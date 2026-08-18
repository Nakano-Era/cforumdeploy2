import type { Bindings } from "@/worker/env";
import {
  R2_STORAGE_COUNTER_KEY,
  R2_STORAGE_PERIOD_KEY,
  R2_STORAGE_USAGE_RESOURCE,
} from "@/worker/media/constants";
import { isBoundObjectKey } from "@/worker/media/lifecycle";
import {
  isAnyTemporaryObjectKey,
  isTemporaryObjectKey,
} from "@/worker/media/service";

export const STALE_MEDIA_GRACE_SECONDS = 24 * 60 * 60;
export const DELETED_MEDIA_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const STALE_MEDIA_BATCH_SIZE = 50;
const ORPHAN_PAGE_SIZE = 250;

interface StaleUploadRow {
  id: string;
  reservation_id: string | null;
  owner_user_id: string;
  state: "reserved" | "uploaded";
  object_key: string;
  byte_size: number;
}

interface StaleVariantRow {
  object_key: string;
  byte_size: number;
}

interface OrphanAvatarRow {
  id: string;
  owner_user_id: string;
  object_key: string;
  byte_size: number;
}

interface OrphanAvatarVariantRow extends StaleVariantRow {
  kind: string;
}

interface ReferenceRow {
  referenced: number;
}

interface CleanupNamespace {
  bucket: R2Bucket;
  prefix: "tmp/" | "bound/";
  cursorSetting: string;
  safeKey: (key: string) => boolean;
  retainDeletedSeconds: number;
}

export interface CleanupStaleMediaResult {
  examined: number;
  deleted: number;
  quarantined: number;
  failed: number;
  orphanObjectsExamined: number;
  orphanObjectsDeleted: number;
  hasMore: boolean;
}

function normalizedNow(now: number | Date): number {
  const seconds = now instanceof Date ? Math.floor(now.getTime() / 1000) : now;
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new TypeError("now must be a non-negative Unix timestamp in seconds");
  }
  return seconds;
}

async function staleUploads(
  env: Bindings,
  cutoff: number,
): Promise<{ rows: StaleUploadRow[]; hasMore: boolean }> {
  const result = await env.CFORUM_DB.prepare(
    `SELECT id, reservation_id, owner_user_id, state, object_key, byte_size
     FROM uploads
     WHERE scope = 'temporary'
       AND state IN ('reserved', 'uploaded')
       AND CASE
         WHEN state = 'uploaded' THEN COALESCE(finalized_at, created_at) <= ?1
         ELSE created_at <= ?1
       END
     ORDER BY created_at, id
     LIMIT ?2`,
  )
    .bind(cutoff, STALE_MEDIA_BATCH_SIZE + 1)
    .all<StaleUploadRow>();
  return {
    rows: result.results.slice(0, STALE_MEDIA_BATCH_SIZE),
    hasMore: result.results.length > STALE_MEDIA_BATCH_SIZE,
  };
}

async function cleanupOneUpload(
  env: Bindings,
  upload: StaleUploadRow,
  now: number,
): Promise<"deleted" | "quarantined" | "skipped"> {
  const variants = await env.CFORUM_DB.prepare(
    `SELECT object_key, byte_size
     FROM upload_variants
     WHERE upload_id = ?1
     ORDER BY id`,
  )
    .bind(upload.id)
    .all<StaleVariantRow>();
  const objectKeys = [
    upload.object_key,
    ...variants.results.map((variant) => variant.object_key),
  ];
  if (
    !isTemporaryObjectKey(upload.object_key, upload.owner_user_id) ||
    variants.results.some(
      (variant) =>
        !isTemporaryObjectKey(variant.object_key, upload.owner_user_id),
    )
  ) {
    const result = await env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET state = 'quarantined'
       WHERE id = ?1
         AND scope = 'temporary'
         AND state IN ('reserved', 'uploaded')
         AND object_key = ?2`,
    )
      .bind(upload.id, upload.object_key)
      .run();
    return (result.meta.changes ?? 0) === 1 ? "quarantined" : "skipped";
  }

  await env.PRIVATE_MEDIA.delete(objectKeys);
  const statements: D1PreparedStatement[] = [
    env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET state = 'deleted', deleted_at = ?3
       WHERE id = ?1
         AND state = ?2
         AND scope = 'temporary'
         AND object_key = ?4`,
    ).bind(upload.id, upload.state, now, upload.object_key),
  ];
  if (upload.state === "uploaded") {
    const storedBytes =
      upload.byte_size +
      variants.results.reduce(
        (total, variant) => total + variant.byte_size,
        0,
      );
    statements.push(
      env.CFORUM_DB.prepare(
        `UPDATE usage_counters
         SET value = MAX(0, value - ?1), updated_at = ?2
         WHERE resource = ?3
           AND period_key = ?4
           AND counter_key = ?5
           AND changes() = 1`,
      ).bind(
        storedBytes,
        now,
        R2_STORAGE_USAGE_RESOURCE,
        R2_STORAGE_PERIOD_KEY,
        R2_STORAGE_COUNTER_KEY,
      ),
    );
  }
  if (upload.reservation_id) {
    statements.push(
      env.CFORUM_DB.prepare(
        `UPDATE upload_reservations
         SET status = 'cancelled'
         WHERE id = ?1
           AND status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM uploads
             WHERE reservation_id = ?1 AND state != 'deleted'
           )`,
      ).bind(upload.reservation_id),
    );
  }
  const results = await env.CFORUM_DB.batch(statements);
  return (results[0]?.meta.changes ?? 0) === 1 ? "deleted" : "skipped";
}

async function orphanedPublicAvatars(
  env: Bindings,
): Promise<{ rows: OrphanAvatarRow[]; hasMore: boolean }> {
  const result = await env.CFORUM_DB.prepare(
    `SELECT id, owner_user_id, object_key, byte_size
     FROM uploads avatar
     WHERE avatar.scope = 'public'
       AND avatar.state = 'bound'
       AND avatar.topic_id IS NULL
       AND avatar.post_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM users WHERE avatar_upload_id = avatar.id
       )
     ORDER BY COALESCE(avatar.bound_at, avatar.created_at), avatar.id
     LIMIT ?1`,
  ).bind(STALE_MEDIA_BATCH_SIZE + 1).all<OrphanAvatarRow>();
  return {
    rows: result.results.slice(0, STALE_MEDIA_BATCH_SIZE),
    hasMore: result.results.length > STALE_MEDIA_BATCH_SIZE,
  };
}

async function cleanupOrphanedPublicAvatar(
  env: Bindings,
  upload: OrphanAvatarRow,
  now: number,
): Promise<"deleted" | "skipped"> {
  const variants = await env.CFORUM_DB.prepare(
    `SELECT kind, object_key, byte_size
     FROM upload_variants
     WHERE upload_id = ?1
     ORDER BY kind, id`,
  ).bind(upload.id).all<OrphanAvatarVariantRow>();
  if (
    !isBoundObjectKey(upload.object_key, upload.id, "main") ||
    variants.results.length !== 1 ||
    variants.results[0]?.kind !== "thumbnail" ||
    !isBoundObjectKey(
      variants.results[0].object_key,
      upload.id,
      "thumbnail",
    )
  ) {
    return "skipped";
  }
  const objectKeys = [upload.object_key, variants.results[0].object_key];
  // Delete first. If R2 or the following D1 batch fails, the bound orphan row
  // remains queryable and the next Cron pass can repeat this idempotently.
  await env.PUBLIC_MEDIA.delete(objectKeys);
  const storedBytes = upload.byte_size + variants.results[0].byte_size;
  const results = await env.CFORUM_DB.batch([
    env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET state = 'deleted', deleted_at = ?4
       WHERE id = ?1
         AND owner_user_id = ?2
         AND state = 'bound'
         AND scope = 'public'
         AND object_key = ?3
         AND topic_id IS NULL
         AND post_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM users WHERE avatar_upload_id = ?1
         )`,
    ).bind(upload.id, upload.owner_user_id, upload.object_key, now),
    env.CFORUM_DB.prepare(
      `UPDATE usage_counters
       SET value = MAX(0, value - ?1), updated_at = ?2
       WHERE resource = ?3
         AND period_key = ?4
         AND counter_key = ?5
         AND changes() = 1`,
    ).bind(
      storedBytes,
      now,
      R2_STORAGE_USAGE_RESOURCE,
      R2_STORAGE_PERIOD_KEY,
      R2_STORAGE_COUNTER_KEY,
    ),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1 ? "deleted" : "skipped";
}

async function readCursor(
  database: D1Database,
  setting: string,
): Promise<string | undefined> {
  const row = await database
    .prepare("SELECT value_json FROM site_settings WHERE key = ?1 LIMIT 1")
    .bind(setting)
    .first<{ value_json: string }>();
  if (!row) return undefined;
  try {
    const value = JSON.parse(row.value_json) as unknown;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function saveCursor(
  database: D1Database,
  setting: string,
  cursor: string | undefined,
  now: number,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO site_settings(key, value_json, is_public, updated_by, updated_at)
       VALUES (?1, ?2, 0, NULL, ?3)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         is_public = 0,
         updated_by = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(setting, JSON.stringify(cursor ?? null), now)
    .run();
}

async function referencedKeys(
  database: D1Database,
  keys: readonly string[],
  retainDeletedAfter: number | null,
): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (let offset = 0; offset < keys.length; offset += 50) {
    const chunk = keys.slice(offset, offset + 50);
    const results = await database.batch(
      chunk.map((key) =>
        database
          .prepare(
            `SELECT EXISTS (
               SELECT 1 FROM uploads
               WHERE object_key = ?1
                 AND (
                   state != 'deleted'
                   OR deleted_at IS NULL
                   OR (?2 IS NOT NULL AND deleted_at > ?2)
                 )
               UNION ALL
               SELECT 1
               FROM upload_variants v
               JOIN uploads u ON u.id = v.upload_id
               WHERE v.object_key = ?1
                 AND (
                   u.state != 'deleted'
                   OR u.deleted_at IS NULL
                   OR (?2 IS NOT NULL AND u.deleted_at > ?2)
                 )
             ) AS referenced`,
          )
          .bind(key, retainDeletedAfter),
      ),
    );
    results.forEach((result, index) => {
      const row = result.results[0] as ReferenceRow | undefined;
      const key = chunk[index];
      if (key && row?.referenced === 1) referenced.add(key);
    });
  }
  return referenced;
}

async function cleanupOrphanPage(
  env: Bindings,
  namespace: CleanupNamespace,
  cutoff: number,
  now: number,
): Promise<{
  examined: number;
  deleted: number;
  failed: number;
  hasMore: boolean;
}> {
  let cursor = await readCursor(env.CFORUM_DB, namespace.cursorSetting);
  let listing: R2Objects;
  try {
    listing = await namespace.bucket.list({
      prefix: namespace.prefix,
      limit: ORPHAN_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
  } catch {
    // An expired/invalid R2 cursor must not wedge future cleanup attempts.
    if (cursor) await saveCursor(env.CFORUM_DB, namespace.cursorSetting, undefined, now);
    return { examined: 0, deleted: 0, failed: 1, hasMore: true };
  }

  const candidates = listing.objects.filter(
    (object) =>
      object.uploaded.getTime() <= cutoff * 1000 &&
      namespace.safeKey(object.key),
  );
  const referenced = await referencedKeys(
    env.CFORUM_DB,
    candidates.map((object) => object.key),
    namespace.retainDeletedSeconds > 0
      ? now - namespace.retainDeletedSeconds
      : null,
  );
  const orphanKeys = candidates
    .map((object) => object.key)
    .filter((key) => !referenced.has(key));
  let deleted = 0;
  let failed = 0;
  if (orphanKeys.length > 0) {
    try {
      await namespace.bucket.delete(orphanKeys);
      deleted = orphanKeys.length;
    } catch {
      failed = 1;
    }
  }

  cursor = listing.truncated ? listing.cursor : undefined;
  await saveCursor(env.CFORUM_DB, namespace.cursorSetting, cursor, now);
  return {
    examined: listing.objects.length,
    deleted,
    failed,
    hasMore: listing.truncated,
  };
}

/**
 * Performs a bounded, retry-safe lifecycle pass. `now` is Unix seconds (or a
 * Date). The persisted R2 cursors ensure large buckets are swept over several
 * Cron invocations instead of requiring an unbounded Worker execution.
 */
export async function cleanupStaleMedia(
  env: Bindings,
  now: number | Date = Math.floor(Date.now() / 1000),
): Promise<CleanupStaleMediaResult> {
  const nowSeconds = normalizedNow(now);
  const cutoff = nowSeconds - STALE_MEDIA_GRACE_SECONDS;
  const stale = await staleUploads(env, cutoff);
  const result: CleanupStaleMediaResult = {
    examined: stale.rows.length,
    deleted: 0,
    quarantined: 0,
    failed: 0,
    orphanObjectsExamined: 0,
    orphanObjectsDeleted: 0,
    hasMore: stale.hasMore,
  };

  for (const upload of stale.rows) {
    try {
      const outcome = await cleanupOneUpload(env, upload, nowSeconds);
      if (outcome === "deleted") result.deleted += 1;
      if (outcome === "quarantined") result.quarantined += 1;
    } catch {
      result.failed += 1;
    }
  }

  try {
    const avatarOrphans = await orphanedPublicAvatars(env);
    result.examined += avatarOrphans.rows.length;
    result.hasMore ||= avatarOrphans.hasMore;
    for (const upload of avatarOrphans.rows) {
      try {
        const outcome = await cleanupOrphanedPublicAvatar(
          env,
          upload,
          nowSeconds,
        );
        if (outcome === "deleted") result.deleted += 1;
      } catch {
        result.failed += 1;
        result.hasMore = true;
      }
    }
  } catch {
    result.failed += 1;
    result.hasMore = true;
  }

  const namespaces: CleanupNamespace[] = [
    {
      bucket: env.PRIVATE_MEDIA,
      prefix: "tmp/",
      cursorSetting: "_internal.media_cleanup.private_tmp_cursor",
      safeKey: isAnyTemporaryObjectKey,
      retainDeletedSeconds: 0,
    },
    {
      bucket: env.PRIVATE_MEDIA,
      prefix: "bound/",
      cursorSetting: "_internal.media_cleanup.private_bound_cursor",
      safeKey: (key) => isBoundObjectKey(key),
      retainDeletedSeconds: DELETED_MEDIA_RETENTION_SECONDS,
    },
    {
      bucket: env.PUBLIC_MEDIA,
      prefix: "bound/",
      cursorSetting: "_internal.media_cleanup.public_bound_cursor",
      safeKey: (key) => isBoundObjectKey(key),
      retainDeletedSeconds: DELETED_MEDIA_RETENTION_SECONDS,
    },
  ];
  for (const namespace of namespaces) {
    try {
      const orphanResult = await cleanupOrphanPage(
        env,
        namespace,
        cutoff,
        nowSeconds,
      );
      result.orphanObjectsExamined += orphanResult.examined;
      result.orphanObjectsDeleted += orphanResult.deleted;
      result.failed += orphanResult.failed;
      result.hasMore ||= orphanResult.hasMore;
    } catch {
      result.failed += 1;
    }
  }

  result.hasMore ||= result.failed > 0;

  return result;
}
