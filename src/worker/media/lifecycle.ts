import type { TrustLevel } from "@/shared/domain";
import { guestViewer } from "@/worker/auth/session";
import type { Bindings } from "@/worker/env";
import {
  extensionForMimeType,
  MAX_HEADER_BYTES,
  MAX_AVATAR_EDGE,
  MAX_AVATAR_THUMBNAIL_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  type SupportedImageMimeType,
} from "@/worker/media/constants";
import { MediaError } from "@/worker/media/errors";
import { avatarUrl } from "@/worker/media/avatar-url";
import { validateImageHeader } from "@/worker/media/image-header";
import type {
  BindUploadInput,
  MediaVariant,
} from "@/worker/media/schema";
import { isTemporaryObjectKey } from "@/worker/media/service";
import {
  evaluateAccessUpload,
  evaluateModerate,
  evaluateViewTopic,
  type CategoryPolicy,
  type TopicPolicy,
  type ViewerContext,
} from "@/worker/permissions/policy";
import { getTopicAggregate } from "@/worker/repositories/forum";

type BoundScope = "public" | "private";
type UploadState =
  | "reserved"
  | "uploaded"
  | "bound"
  | "quarantined"
  | "deleted";

interface UploadRow {
  id: string;
  owner_user_id: string;
  topic_id: string | null;
  post_id: string | null;
  scope: "temporary" | BoundScope;
  state: UploadState;
  object_key: string;
  content_hash: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
}

interface VariantRow {
  id: string;
  upload_id: string;
  kind: "main" | "thumbnail" | "avatar" | "original";
  object_key: string;
  content_hash: string;
  mime_type: string;
  byte_size: number;
  width: number;
  height: number;
}

interface TargetRow {
  post_id: string;
  topic_id: string;
  post_author_id: string;
  post_status: "pending" | "published" | "hidden" | "deleted";
  topic_status: "open" | "locked" | "archived" | "deleted" | "pending";
  category_id: string;
  owner_status: string;
}

interface MediaRow extends UploadRow {
  post_author_id: string;
  post_status: TargetRow["post_status"];
}

export interface BoundUploadResult {
  uploadId: string;
  state: "bound";
  scope: BoundScope;
  media: {
    main: string;
    thumbnail?: string;
  };
}

export interface BoundAvatarResult {
  uploadId: string;
  avatarUrl: string;
}

export interface ReconcileBoundUploadResult extends BoundUploadResult {
  changed: boolean;
}

export interface ObjectMove {
  uploadId: string;
  id: string;
  kind: "main" | "thumbnail";
  sourceKey: string;
  destinationKey: string;
  contentHash: string;
  mimeType: SupportedImageMimeType;
  byteSize: number;
  width: number;
  height: number;
}

const BOUND_KEY_PATTERN =
  /^bound\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(main|thumbnail)\.(jpg|png|webp)$/i;

function isSupportedMimeType(value: string): value is SupportedImageMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

function effectiveViewLevel(
  category: CategoryPolicy,
  topic: TopicPolicy,
): TrustLevel {
  return Math.max(
    category.minViewLevel,
    topic.minViewLevel,
    topic.effectiveMinViewLevel,
  ) as TrustLevel;
}

export function deriveBoundMediaScope(
  category: CategoryPolicy,
  topic: TopicPolicy,
): BoundScope {
  return evaluateViewTopic(guestViewer(), category, topic).allowed
    ? "public"
    : "private";
}

export function derivePostMediaScope(
  category: CategoryPolicy,
  topic: TopicPolicy,
  postStatus: TargetRow["post_status"],
): BoundScope {
  return postStatus === "published" &&
    category.state !== "deleted" &&
    deriveBoundMediaScope(category, topic) === "public"
    ? "public"
    : "private";
}

export function isBoundObjectKey(
  key: string,
  uploadId?: string,
  kind?: "main" | "thumbnail",
): boolean {
  const match = BOUND_KEY_PATTERN.exec(key);
  if (!match) return false;
  if (uploadId && match[1]?.toLowerCase() !== uploadId.toLowerCase()) {
    return false;
  }
  return !kind || match[3] === kind;
}

function mediaPaths(
  uploadId: string,
  variants: readonly VariantRow[],
): BoundUploadResult["media"] {
  return {
    main: `/api/media/${encodeURIComponent(uploadId)}`,
    ...(variants.some((variant) => variant.kind === "thumbnail")
      ? {
          thumbnail: `/api/media/${encodeURIComponent(uploadId)}/thumbnail`,
        }
      : {}),
  };
}

function boundResult(
  upload: Pick<UploadRow, "id" | "scope">,
  variants: readonly VariantRow[],
): BoundUploadResult {
  if (upload.scope !== "public" && upload.scope !== "private") {
    throw new MediaError("UPLOAD_NOT_BINDABLE", 409);
  }
  return {
    uploadId: upload.id,
    state: "bound",
    scope: upload.scope,
    media: mediaPaths(upload.id, variants),
  };
}

function bytesToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function deleteWithoutThrow(
  bucket: R2Bucket,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await bucket.delete([...keys]);
  } catch {
    // A later lifecycle cleanup reclaims unreferenced objects. The caller must
    // never delete a key it did not create for this attempt.
  }
}

function destinationKey(
  uploadId: string,
  attemptId: string,
  kind: ObjectMove["kind"],
  mimeType: SupportedImageMimeType,
): string {
  return `bound/${uploadId}/${attemptId}/${kind}.${extensionForMimeType(mimeType)}`;
}

function assertMoveShape(
  uploadId: string,
  ownerUserId: string,
  upload: UploadRow,
  variants: readonly VariantRow[],
  attemptId: string,
): ObjectMove[] {
  if (
    upload.width === null ||
    upload.height === null ||
    !isSupportedMimeType(upload.mime_type) ||
    !isTemporaryObjectKey(upload.object_key, ownerUserId)
  ) {
    throw new MediaError("UPLOAD_NOT_BINDABLE", 409);
  }
  if (
    variants.some(
      (variant) =>
        variant.kind !== "thumbnail" ||
        !isSupportedMimeType(variant.mime_type) ||
        !isTemporaryObjectKey(variant.object_key, ownerUserId),
    )
  ) {
    throw new MediaError("UPLOAD_NOT_BINDABLE", 409);
  }

  return [
    {
      uploadId,
      id: upload.id,
      kind: "main",
      sourceKey: upload.object_key,
      destinationKey: destinationKey(
        uploadId,
        attemptId,
        "main",
        upload.mime_type,
      ),
      contentHash: upload.content_hash,
      mimeType: upload.mime_type,
      byteSize: upload.byte_size,
      width: upload.width,
      height: upload.height,
    },
    ...variants.map(
      (variant): ObjectMove => ({
        uploadId,
        id: variant.id,
        kind: "thumbnail",
        sourceKey: variant.object_key,
        destinationKey: destinationKey(
          uploadId,
          attemptId,
          "thumbnail",
          variant.mime_type as SupportedImageMimeType,
        ),
        contentHash: variant.content_hash,
        mimeType: variant.mime_type as SupportedImageMimeType,
        byteSize: variant.byte_size,
        width: variant.width,
        height: variant.height,
      }),
    ),
  ];
}

async function assertSourceBody(
  source: R2ObjectBody,
  move: ObjectMove,
): Promise<{ body: ArrayBuffer; digest: ArrayBuffer }> {
  if (
    source.size !== move.byteSize ||
    source.httpMetadata?.contentType?.toLowerCase() !== move.mimeType
  ) {
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
  const body = await source.arrayBuffer();
  if (body.byteLength !== move.byteSize) {
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
  const digest = await crypto.subtle.digest("SHA-256", body);
  if (bytesToBase64(digest) !== move.contentHash) {
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
  try {
    validateImageHeader(new Uint8Array(body, 0, Math.min(body.byteLength, MAX_HEADER_BYTES)), {
      mimeType: move.mimeType,
      width: move.width,
      height: move.height,
    });
  } catch {
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
  return { body, digest };
}

async function assertDestination(
  bucket: R2Bucket,
  move: ObjectMove,
): Promise<void> {
  const destination = await bucket.head(move.destinationKey);
  if (
    !destination ||
    destination.size !== move.byteSize ||
    destination.httpMetadata?.contentType?.toLowerCase() !== move.mimeType ||
    !destination.checksums.sha256 ||
    bytesToBase64(destination.checksums.sha256) !== move.contentHash
  ) {
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
}

export async function copyObjectsForBinding(
  sourceBucket: R2Bucket,
  destinationBucket: R2Bucket,
  moves: readonly ObjectMove[],
  scope: BoundScope,
): Promise<void> {
  try {
    for (const move of moves) {
      const source = await sourceBucket.get(move.sourceKey);
      if (!source) throw new MediaError("MEDIA_MOVE_FAILED", 503);
      const { body, digest } = await assertSourceBody(source, move);
      await destinationBucket.put(move.destinationKey, body, {
        httpMetadata: {
          contentType: move.mimeType,
          contentDisposition: "inline",
          cacheControl:
            scope === "public"
              ? "public, max-age=60, must-revalidate"
              : "private, no-store",
        },
        customMetadata: {
          uploadId: move.uploadId,
          variant: move.kind,
        },
        sha256: digest,
      });
      await assertDestination(destinationBucket, move);
    }
  } catch (error) {
    await deleteWithoutThrow(
      destinationBucket,
      moves.map((move) => move.destinationKey),
    );
    if (error instanceof MediaError) throw error;
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
}

async function bindingRecords(
  env: Bindings,
  uploadId: string,
  ownerUserId: string,
  postId: string,
): Promise<{
  upload: UploadRow | null;
  variants: VariantRow[];
  target: TargetRow | null;
}> {
  const results = await env.CFORUM_DB.batch([
    env.CFORUM_DB.prepare(
      `SELECT id, owner_user_id, topic_id, post_id, scope, state, object_key,
              content_hash, mime_type, byte_size, width, height
       FROM uploads
       WHERE id = ?1 AND owner_user_id = ?2
       LIMIT 1`,
    ).bind(uploadId, ownerUserId),
    env.CFORUM_DB.prepare(
      `SELECT id, upload_id, kind, object_key, content_hash, mime_type,
              byte_size, width, height
       FROM upload_variants
       WHERE upload_id = ?1
       ORDER BY kind, id`,
    ).bind(uploadId),
    env.CFORUM_DB.prepare(
      `SELECT p.id AS post_id, p.topic_id, p.author_id AS post_author_id,
              p.status AS post_status, t.status AS topic_status,
              t.category_id, owner.status AS owner_status
       FROM posts p
       JOIN topics t ON t.id = p.topic_id
       JOIN users owner ON owner.id = p.author_id
       WHERE p.id = ?1 AND p.author_id = ?2
       LIMIT 1`,
    ).bind(postId, ownerUserId),
  ]);
  return {
    upload: (results[0]?.results[0] as UploadRow | undefined) ?? null,
    variants: (results[1]?.results as unknown as VariantRow[]) ?? [],
    target: (results[2]?.results[0] as TargetRow | undefined) ?? null,
  };
}

async function currentBoundUpload(
  env: Bindings,
  uploadId: string,
  ownerUserId: string,
): Promise<UploadRow | null> {
  return env.CFORUM_DB.prepare(
    `SELECT id, owner_user_id, topic_id, post_id, scope, state, object_key,
            content_hash, mime_type, byte_size, width, height
     FROM uploads
     WHERE id = ?1 AND owner_user_id = ?2
     LIMIT 1`,
  )
    .bind(uploadId, ownerUserId)
    .first<UploadRow>();
}

interface AvatarOwnerRow {
  id: string;
  status: string;
  avatar_upload_id: string | null;
}

async function avatarBindingRecords(
  env: Bindings,
  uploadId: string,
  ownerUserId: string,
): Promise<{
  upload: UploadRow | null;
  variants: VariantRow[];
  owner: AvatarOwnerRow | null;
}> {
  const results = await env.CFORUM_DB.batch([
    env.CFORUM_DB.prepare(
      `SELECT id, owner_user_id, topic_id, post_id, scope, state, object_key,
              content_hash, mime_type, byte_size, width, height
       FROM uploads
       WHERE id = ?1 AND owner_user_id = ?2
       LIMIT 1`,
    ).bind(uploadId, ownerUserId),
    env.CFORUM_DB.prepare(
      `SELECT id, upload_id, kind, object_key, content_hash, mime_type,
              byte_size, width, height
       FROM upload_variants
       WHERE upload_id = ?1
       ORDER BY kind, id`,
    ).bind(uploadId),
    env.CFORUM_DB.prepare(
      `SELECT id, status, avatar_upload_id
       FROM users
       WHERE id = ?1
       LIMIT 1`,
    ).bind(ownerUserId),
  ]);
  return {
    upload: (results[0]?.results[0] as UploadRow | undefined) ?? null,
    variants: (results[1]?.results as unknown as VariantRow[]) ?? [],
    owner: (results[2]?.results[0] as AvatarOwnerRow | undefined) ?? null,
  };
}

async function rollbackAvatarMove(
  env: Bindings,
  ownerUserId: string,
  uploadId: string,
  previousAvatarId: string | null,
  moves: readonly ObjectMove[],
): Promise<void> {
  const mainMove = moves[0];
  if (!mainMove) return;
  const statements: D1PreparedStatement[] = [
    env.CFORUM_DB.prepare(
      `UPDATE users
       SET avatar_upload_id = ?3
       WHERE id = ?1
         AND avatar_upload_id = ?2
         AND EXISTS (
           SELECT 1 FROM uploads
           WHERE id = ?2
             AND owner_user_id = ?1
             AND state = 'bound'
             AND scope = 'public'
             AND object_key = ?4
             AND topic_id IS NULL
             AND post_id IS NULL
         )`,
    ).bind(
      ownerUserId,
      uploadId,
      previousAvatarId,
      mainMove.destinationKey,
    ),
    env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET scope = 'temporary', state = 'uploaded', object_key = ?3,
           bound_at = NULL
       WHERE id = ?1
         AND owner_user_id = ?2
         AND state = 'bound'
         AND scope = 'public'
         AND object_key = ?4
         AND topic_id IS NULL
         AND post_id IS NULL`,
    ).bind(
      uploadId,
      ownerUserId,
      mainMove.sourceKey,
      mainMove.destinationKey,
    ),
    ...moves.slice(1).map((move) =>
      env.CFORUM_DB.prepare(
        `UPDATE upload_variants
         SET object_key = ?3
         WHERE id = ?1 AND upload_id = ?2 AND object_key = ?4`,
      ).bind(move.id, uploadId, move.sourceKey, move.destinationKey),
    ),
  ];
  await env.CFORUM_DB.batch(statements).catch(() => undefined);
}

async function retireAvatarUpload(
  env: Bindings,
  uploadId: string | null,
  ownerUserId: string,
  now: number,
): Promise<void> {
  if (!uploadId) return;
  const [upload, variants] = await Promise.all([
    currentBoundUpload(env, uploadId, ownerUserId),
    allVariantRows(env, uploadId),
  ]);
  if (
    !upload ||
    upload.scope !== "public" ||
    upload.topic_id !== null ||
    upload.post_id !== null ||
    !["bound", "deleted"].includes(upload.state) ||
    !isBoundObjectKey(upload.object_key, uploadId, "main") ||
    variants.some(
      (variant) =>
        variant.kind !== "thumbnail" ||
        !isBoundObjectKey(variant.object_key, uploadId, "thumbnail"),
    )
  ) {
    return;
  }
  const objectKeys = [
    upload.object_key,
    ...variants.map((variant) => variant.object_key),
  ];
  let retired = upload.state === "deleted";
  if (!retired) {
    const results = await env.CFORUM_DB.batch([
    env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET state = 'deleted', deleted_at = ?3
       WHERE id = ?1
         AND owner_user_id = ?2
         AND state = 'bound'
         AND scope = 'public'
         AND topic_id IS NULL
         AND post_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM users WHERE avatar_upload_id = ?1
         )`,
    ).bind(uploadId, ownerUserId, now),
    env.CFORUM_DB.prepare(
      `UPDATE usage_counters
       SET value = MAX(0, value - COALESCE((
         SELECT u.byte_size + COALESCE(SUM(v.byte_size), 0)
         FROM uploads u
         LEFT JOIN upload_variants v ON v.upload_id = u.id
         WHERE u.id = ?1
         GROUP BY u.id, u.byte_size
       ), 0)), updated_at = ?2
       WHERE resource = 'r2_storage_bytes'
         AND period_key = 'lifetime'
         AND counter_key = 'total'
         AND changes() = 1`,
    ).bind(uploadId, now),
    ]);
    retired = (results[0]?.meta.changes ?? 0) === 1;
  }
  if (!retired) return;
  try {
    await env.PUBLIC_MEDIA.delete(objectKeys);
  } catch {
    // The deleted DB row keeps the keys inaccessible. The bounded orphan sweep
    // retries physical deletion, so a transient R2 failure cannot resurrect it.
  }
}

export async function bindAvatarUpload(
  env: Bindings,
  viewer: ViewerContext,
  uploadId: string,
  requestId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<BoundAvatarResult> {
  const ownerUserId = viewer.userId;
  if (!ownerUserId) {
    throw new MediaError("AUTHENTICATION_REQUIRED", 401);
  }
  if (viewer.status !== "active") {
    throw new MediaError("ACCOUNT_INACTIVE", 403);
  }
  const records = await avatarBindingRecords(env, uploadId, ownerUserId);
  if (!records.upload) throw new MediaError("UPLOAD_NOT_FOUND", 404);
  if (
    records.variants.length !== 1 ||
    records.variants[0]?.kind !== "thumbnail" ||
    records.variants[0].width > MAX_AVATAR_EDGE ||
    records.variants[0].height > MAX_AVATAR_EDGE ||
    records.variants[0].byte_size > MAX_AVATAR_THUMBNAIL_BYTES
  ) {
    throw new MediaError("UPLOAD_NOT_BINDABLE", 409);
  }
  if (
    records.owner?.avatar_upload_id === uploadId &&
    records.upload.state === "bound" &&
    records.upload.scope === "public" &&
    records.upload.topic_id === null &&
    records.upload.post_id === null
  ) {
    return { uploadId, avatarUrl: avatarUrl(uploadId) ?? "" };
  }
  if (
    records.owner?.status !== "active" ||
    records.upload.state !== "uploaded" ||
    records.upload.scope !== "temporary" ||
    records.upload.topic_id !== null ||
    records.upload.post_id !== null
  ) {
    throw new MediaError("UPLOAD_NOT_BINDABLE", 409);
  }

  const previousAvatarId = records.owner.avatar_upload_id;
  const attemptId = crypto.randomUUID();
  const moves = assertMoveShape(
    uploadId,
    ownerUserId,
    records.upload,
    records.variants,
    attemptId,
  );
  await copyObjectsForBinding(
    env.PRIVATE_MEDIA,
    env.PUBLIC_MEDIA,
    moves,
    "public",
  );
  const mainMove = moves[0];
  if (!mainMove) throw new MediaError("MEDIA_MOVE_FAILED", 503);

  const statements: D1PreparedStatement[] = [
    env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET scope = 'public', state = 'bound', object_key = ?3,
           min_view_level = 0, bound_at = ?4
       WHERE id = ?1
         AND owner_user_id = ?2
         AND state = 'uploaded'
         AND scope = 'temporary'
         AND object_key = ?5
         AND topic_id IS NULL
         AND post_id IS NULL`,
    ).bind(uploadId, ownerUserId, mainMove.destinationKey, now, mainMove.sourceKey),
    ...moves.slice(1).map((move) =>
      env.CFORUM_DB.prepare(
        `UPDATE upload_variants
         SET object_key = ?2
         WHERE id = ?1
           AND upload_id = ?3
           AND object_key = ?4
           AND EXISTS (
             SELECT 1 FROM uploads
             WHERE id = ?3
               AND owner_user_id = ?5
               AND state = 'bound'
               AND scope = 'public'
               AND object_key = ?6
               AND topic_id IS NULL
               AND post_id IS NULL
           )`,
      ).bind(
        move.id,
        move.destinationKey,
        uploadId,
        move.sourceKey,
        ownerUserId,
        mainMove.destinationKey,
      ),
    ),
    env.CFORUM_DB.prepare(
      `UPDATE users
       SET avatar_upload_id = ?2, updated_at = ?4
       WHERE id = ?1
         AND status = 'active'
         AND avatar_upload_id IS ?3
         AND EXISTS (
           SELECT 1 FROM uploads
           WHERE id = ?2
             AND owner_user_id = ?1
             AND state = 'bound'
             AND scope = 'public'
             AND topic_id IS NULL
             AND post_id IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM upload_variants
           WHERE upload_id = ?2 AND object_key LIKE 'tmp/%'
         )`,
    ).bind(ownerUserId, uploadId, previousAvatarId, now),
  ];
  const userUpdateIndex = statements.length - 1;
  let results: D1Result[];
  try {
    results = await env.CFORUM_DB.batch(statements);
  } catch {
    await rollbackAvatarMove(
      env,
      ownerUserId,
      uploadId,
      previousAvatarId,
      moves,
    );
    await deleteWithoutThrow(
      env.PUBLIC_MEDIA,
      moves.map((move) => move.destinationKey),
    );
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
  const moveUpdatesSucceeded = moves.every(
    (_move, index) => (results[index]?.meta.changes ?? 0) === 1,
  );
  if (
    !moveUpdatesSucceeded ||
    (results[userUpdateIndex]?.meta.changes ?? 0) !== 1
  ) {
    await rollbackAvatarMove(
      env,
      ownerUserId,
      uploadId,
      previousAvatarId,
      moves,
    );
    await deleteWithoutThrow(
      env.PUBLIC_MEDIA,
      moves.map((move) => move.destinationKey),
    );
    throw new MediaError("UPLOAD_NOT_BINDABLE", 409);
  }

  await deleteWithoutThrow(
    env.PRIVATE_MEDIA,
    moves.map((move) => move.sourceKey),
  );
  await retireAvatarUpload(env, previousAvatarId, ownerUserId, now).catch(
    () => undefined,
  );
  await env.CFORUM_DB.prepare(
    `INSERT INTO audit_logs(
       id, occurred_at, actor_user_id, actor_role, action, target_type,
       target_id, request_id, before_json, after_json
     ) VALUES (?1, ?2, ?3, ?4, 'account.avatar.update', 'user', ?3, ?5, ?6, ?7)`,
  ).bind(
    crypto.randomUUID(),
    now,
    ownerUserId,
    viewer.role,
    requestId,
    JSON.stringify({ avatarUploadId: previousAvatarId }),
    JSON.stringify({ avatarUploadId: uploadId }),
  ).run().catch(() => undefined);
  return { uploadId, avatarUrl: avatarUrl(uploadId) ?? "" };
}

export async function removeAvatarUpload(
  env: Bindings,
  viewer: ViewerContext,
  requestId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const ownerUserId = viewer.userId;
  if (!ownerUserId) {
    throw new MediaError("AUTHENTICATION_REQUIRED", 401);
  }
  if (viewer.status !== "active") {
    throw new MediaError("ACCOUNT_INACTIVE", 403);
  }
  const owner = await env.CFORUM_DB.prepare(
    `SELECT avatar_upload_id FROM users
     WHERE id = ?1 AND status = 'active'
     LIMIT 1`,
  ).bind(ownerUserId).first<{ avatar_upload_id: string | null }>();
  if (!owner?.avatar_upload_id) return;
  const previousAvatarId = owner.avatar_upload_id;
  const result = await env.CFORUM_DB.prepare(
    `UPDATE users
     SET avatar_upload_id = NULL, updated_at = ?3
     WHERE id = ?1 AND status = 'active' AND avatar_upload_id = ?2`,
  ).bind(ownerUserId, previousAvatarId, now).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new MediaError("UPLOAD_NOT_BINDABLE", 409);
  }
  await retireAvatarUpload(env, previousAvatarId, ownerUserId, now).catch(
    () => undefined,
  );
  await env.CFORUM_DB.prepare(
    `INSERT INTO audit_logs(
       id, occurred_at, actor_user_id, actor_role, action, target_type,
       target_id, request_id, before_json, after_json
     ) VALUES (?1, ?2, ?3, ?4, 'account.avatar.remove', 'user', ?3, ?5, ?6, ?7)`,
  ).bind(
    crypto.randomUUID(),
    now,
    ownerUserId,
    viewer.role,
    requestId,
    JSON.stringify({ avatarUploadId: previousAvatarId }),
    JSON.stringify({ avatarUploadId: null }),
  ).run().catch(() => undefined);
}

export async function bindUpload(
  env: Bindings,
  viewer: ViewerContext,
  input: BindUploadInput,
  now = Math.floor(Date.now() / 1000),
): Promise<BoundUploadResult> {
  const ownerUserId = viewer.userId;
  if (!ownerUserId || viewer.status !== "active") {
    throw new MediaError("ACCOUNT_INACTIVE", 403);
  }
  const records = await bindingRecords(
    env,
    input.uploadId,
    ownerUserId,
    input.postId,
  );
  if (!records.upload) throw new MediaError("UPLOAD_NOT_FOUND", 404);

  if (
    records.upload.state === "bound" &&
    records.upload.topic_id === input.topicId &&
    records.upload.post_id === input.postId &&
    records.target?.topic_id === input.topicId &&
    records.target.owner_status === "active"
  ) {
    return boundResult(records.upload, records.variants);
  }

  if (
    records.upload.state !== "uploaded" ||
    records.upload.scope !== "temporary" ||
    records.upload.topic_id !== null ||
    records.upload.post_id !== null ||
    !records.target ||
    records.target.topic_id !== input.topicId ||
    records.target.owner_status !== "active" ||
    !["published", "pending"].includes(records.target.post_status) ||
    records.target.topic_status === "deleted"
  ) {
    throw new MediaError("UPLOAD_NOT_BINDABLE", 409);
  }

  const aggregate = await getTopicAggregate(env.CFORUM_DB, input.topicId);
  if (
    !aggregate ||
    aggregate.topic.categoryId !== records.target.category_id ||
    aggregate.category.state === "deleted" ||
    !aggregate.category.allowImages ||
    !evaluateViewTopic(viewer, aggregate.category, aggregate.topic).allowed
  ) {
    throw new MediaError("UPLOAD_NOT_BINDABLE", 409);
  }

  const scope = derivePostMediaScope(
    aggregate.category,
    aggregate.topic,
    records.target.post_status,
  );
  const attemptId = crypto.randomUUID();
  const moves = assertMoveShape(
    input.uploadId,
    ownerUserId,
    records.upload,
    records.variants,
    attemptId,
  );
  const destinationBucket =
    scope === "public" ? env.PUBLIC_MEDIA : env.PRIVATE_MEDIA;
  await copyObjectsForBinding(
    env.PRIVATE_MEDIA,
    destinationBucket,
    moves,
    scope,
  );

  const mainMove = moves[0];
  if (!mainMove) {
    await deleteWithoutThrow(destinationBucket, []);
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
  const statements: D1PreparedStatement[] = [
    env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET topic_id = ?8, post_id = ?9, scope = ?3, state = 'bound',
           object_key = ?4, min_view_level = ?5, bound_at = ?6
       WHERE id = ?1
         AND owner_user_id = ?2
         AND state = 'uploaded'
         AND scope = 'temporary'
         AND object_key = ?7
         AND topic_id IS NULL
         AND post_id IS NULL
         AND EXISTS (
           SELECT 1
           FROM posts p
           JOIN topics t ON t.id = p.topic_id
           JOIN users owner ON owner.id = p.author_id
           JOIN categories c ON c.id = t.category_id
           WHERE p.id = ?9
             AND p.topic_id = ?8
             AND p.author_id = ?2
             AND p.status IN ('published', 'pending')
             AND t.status != 'deleted'
             AND c.state != 'deleted'
             AND owner.status = 'active'
             AND c.allow_images = 1
             AND (
               ?3 != 'public'
               OR (
                 p.status = 'published'
                 AND t.status != 'pending'
                 AND c.min_view_level = 0
                 AND t.min_view_level = 0
                 AND t.effective_min_view_level = 0
                 AND (
                   c.acl_mode = 'open'
                   OR EXISTS (
                     SELECT 1 FROM category_permissions cp
                     WHERE cp.category_id = c.id
                       AND cp.principal_type = 'everyone'
                       AND cp.principal_id IS NULL
                       AND cp.action = 'see'
                   )
                 )
               )
             )
         )`,
    ).bind(
      input.uploadId,
      ownerUserId,
      scope,
      mainMove.destinationKey,
      effectiveViewLevel(aggregate.category, aggregate.topic),
      now,
      mainMove.sourceKey,
      input.topicId,
      input.postId,
    ),
    ...moves.slice(1).map((move) =>
      env.CFORUM_DB.prepare(
        `UPDATE upload_variants
         SET object_key = ?2
         WHERE id = ?1
           AND upload_id = ?3
           AND object_key = ?4
           AND EXISTS (
             SELECT 1 FROM uploads
             WHERE id = ?3
               AND owner_user_id = ?5
               AND state = 'bound'
               AND topic_id = ?6
               AND post_id = ?7
               AND object_key = ?8
           )`,
      ).bind(
        move.id,
        move.destinationKey,
        input.uploadId,
        move.sourceKey,
        ownerUserId,
        input.topicId,
        input.postId,
        mainMove.destinationKey,
      ),
    ),
  ];

  let results: D1Result[];
  try {
    results = await env.CFORUM_DB.batch(statements);
  } catch {
    await deleteWithoutThrow(
      destinationBucket,
      moves.map((move) => move.destinationKey),
    );
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    await deleteWithoutThrow(
      destinationBucket,
      moves.map((move) => move.destinationKey),
    );
    const current = await currentBoundUpload(env, input.uploadId, ownerUserId);
    if (
      current?.state === "bound" &&
      current.topic_id === input.topicId &&
      current.post_id === input.postId
    ) {
      return boundResult(current, records.variants);
    }
    throw new MediaError("UPLOAD_NOT_BINDABLE", 409);
  }

  if (
    moves.slice(1).some(
      (_move, index) => (results[index + 1]?.meta.changes ?? 0) !== 1,
    )
  ) {
    await env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET state = 'quarantined'
       WHERE id = ?1 AND state = 'bound' AND object_key = ?2`,
    )
      .bind(input.uploadId, mainMove.destinationKey)
      .run();
    await deleteWithoutThrow(
      destinationBucket,
      moves.map((move) => move.destinationKey),
    );
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }

  await deleteWithoutThrow(
    env.PRIVATE_MEDIA,
    moves.map((move) => move.sourceKey),
  );
  return {
    uploadId: input.uploadId,
    state: "bound",
    scope,
    media: mediaPaths(input.uploadId, records.variants),
  };
}

async function mediaRow(
  env: Bindings,
  uploadId: string,
): Promise<MediaRow | null> {
  return env.CFORUM_DB.prepare(
    `SELECT u.id, u.owner_user_id, u.topic_id, u.post_id, u.scope, u.state,
            u.object_key, u.content_hash, u.mime_type, u.byte_size,
            u.width, u.height, p.author_id AS post_author_id,
            p.status AS post_status
     FROM uploads u
     JOIN posts p ON p.id = u.post_id AND p.topic_id = u.topic_id
     WHERE u.id = ?1 AND u.state = 'bound'
     LIMIT 1`,
  )
    .bind(uploadId)
    .first<MediaRow>();
}

async function variantRow(
  env: Bindings,
  uploadId: string,
): Promise<VariantRow | null> {
  return env.CFORUM_DB.prepare(
    `SELECT id, upload_id, kind, object_key, content_hash, mime_type,
            byte_size, width, height
     FROM upload_variants
     WHERE upload_id = ?1 AND kind = 'thumbnail'
     LIMIT 1`,
  )
    .bind(uploadId)
    .first<VariantRow>();
}

async function allVariantRows(
  env: Bindings,
  uploadId: string,
): Promise<VariantRow[]> {
  const rows = await env.CFORUM_DB.prepare(
    `SELECT id, upload_id, kind, object_key, content_hash, mime_type,
            byte_size, width, height
     FROM upload_variants
     WHERE upload_id = ?1
     ORDER BY kind, id`,
  )
    .bind(uploadId)
    .all<VariantRow>();
  return rows.results;
}

function boundMoves(
  upload: MediaRow,
  variants: readonly VariantRow[],
  attemptId: string,
): ObjectMove[] {
  if (
    upload.width === null ||
    upload.height === null ||
    !isSupportedMimeType(upload.mime_type) ||
    !isBoundObjectKey(upload.object_key, upload.id, "main") ||
    variants.some(
      (variant) =>
        variant.kind !== "thumbnail" ||
        !isSupportedMimeType(variant.mime_type) ||
        !isBoundObjectKey(variant.object_key, upload.id, "thumbnail"),
    )
  ) {
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
  return [
    {
      uploadId: upload.id,
      id: upload.id,
      kind: "main",
      sourceKey: upload.object_key,
      destinationKey: destinationKey(
        upload.id,
        attemptId,
        "main",
        upload.mime_type,
      ),
      contentHash: upload.content_hash,
      mimeType: upload.mime_type,
      byteSize: upload.byte_size,
      width: upload.width,
      height: upload.height,
    },
    ...variants.map(
      (variant): ObjectMove => ({
        uploadId: upload.id,
        id: variant.id,
        kind: "thumbnail",
        sourceKey: variant.object_key,
        destinationKey: destinationKey(
          upload.id,
          attemptId,
          "thumbnail",
          variant.mime_type as SupportedImageMimeType,
        ),
        contentHash: variant.content_hash,
        mimeType: variant.mime_type as SupportedImageMimeType,
        byteSize: variant.byte_size,
        width: variant.width,
        height: variant.height,
      }),
    ),
  ];
}

/**
 * Reclassifies a bound upload after post approval or a topic/category visibility
 * change. The caller should invoke this after committing the policy change.
 * A retry is safe: each attempt owns distinct destination keys and a guarded D1
 * switch selects at most one winner.
 */
export async function reconcileBoundUploadScope(
  env: Bindings,
  uploadId: string,
): Promise<ReconcileBoundUploadResult> {
  const upload = await mediaRow(env, uploadId);
  if (
    !upload ||
    !upload.topic_id ||
    !upload.post_id ||
    (upload.scope !== "public" && upload.scope !== "private")
  ) {
    throw new MediaError("MEDIA_NOT_FOUND", 404);
  }
  const [variants, aggregate] = await Promise.all([
    allVariantRows(env, uploadId),
    getTopicAggregate(env.CFORUM_DB, upload.topic_id),
  ]);
  if (!aggregate) throw new MediaError("MEDIA_NOT_FOUND", 404);
  const desiredScope = derivePostMediaScope(
    aggregate.category,
    aggregate.topic,
    upload.post_status,
  );
  if (upload.scope === desiredScope) {
    return { ...boundResult(upload, variants), changed: false };
  }

  const attemptId = crypto.randomUUID();
  const moves = boundMoves(upload, variants, attemptId);
  const sourceBucket =
    upload.scope === "public" ? env.PUBLIC_MEDIA : env.PRIVATE_MEDIA;
  const destinationBucket =
    desiredScope === "public" ? env.PUBLIC_MEDIA : env.PRIVATE_MEDIA;
  await copyObjectsForBinding(
    sourceBucket,
    destinationBucket,
    moves,
    desiredScope,
  );
  const mainMove = moves[0];
  if (!mainMove) throw new MediaError("MEDIA_MOVE_FAILED", 503);

  const statements: D1PreparedStatement[] = [
    env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET scope = ?2, object_key = ?3, min_view_level = ?4
       WHERE id = ?1
         AND state = 'bound'
         AND scope = ?5
         AND object_key = ?6
         AND topic_id = ?7
         AND post_id = ?8
         AND EXISTS (
           SELECT 1
           FROM posts p
           JOIN topics t ON t.id = p.topic_id
           JOIN categories c ON c.id = t.category_id
           WHERE p.id = ?8
             AND p.topic_id = ?7
             AND (
               ?2 != 'public'
               OR (
                 p.status = 'published'
                 AND t.status != 'pending'
                 AND t.status != 'deleted'
                 AND c.state != 'deleted'
                 AND c.min_view_level = 0
                 AND t.min_view_level = 0
                 AND t.effective_min_view_level = 0
                 AND (
                   c.acl_mode = 'open'
                   OR EXISTS (
                     SELECT 1 FROM category_permissions cp
                     WHERE cp.category_id = c.id
                       AND cp.principal_type = 'everyone'
                       AND cp.principal_id IS NULL
                       AND cp.action = 'see'
                   )
                 )
               )
             )
         )`,
    ).bind(
      upload.id,
      desiredScope,
      mainMove.destinationKey,
      effectiveViewLevel(aggregate.category, aggregate.topic),
      upload.scope,
      mainMove.sourceKey,
      upload.topic_id,
      upload.post_id,
    ),
    ...moves.slice(1).map((move) =>
      env.CFORUM_DB.prepare(
        `UPDATE upload_variants
         SET object_key = ?2
         WHERE id = ?1
           AND upload_id = ?3
           AND object_key = ?4
           AND EXISTS (
             SELECT 1 FROM uploads
             WHERE id = ?3
               AND state = 'bound'
               AND scope = ?5
               AND object_key = ?6
           )`,
      ).bind(
        move.id,
        move.destinationKey,
        upload.id,
        move.sourceKey,
        desiredScope,
        mainMove.destinationKey,
      ),
    ),
  ];

  let results: D1Result[];
  try {
    results = await env.CFORUM_DB.batch(statements);
  } catch {
    await deleteWithoutThrow(
      destinationBucket,
      moves.map((move) => move.destinationKey),
    );
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    await deleteWithoutThrow(
      destinationBucket,
      moves.map((move) => move.destinationKey),
    );
    const current = await currentBoundUpload(
      env,
      upload.id,
      upload.owner_user_id,
    );
    if (current?.state === "bound" && current.scope === desiredScope) {
      return { ...boundResult(current, variants), changed: false };
    }
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }
  if (
    moves.slice(1).some(
      (_move, index) => (results[index + 1]?.meta.changes ?? 0) !== 1,
    )
  ) {
    await env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET state = 'quarantined'
       WHERE id = ?1 AND state = 'bound' AND object_key = ?2`,
    )
      .bind(upload.id, mainMove.destinationKey)
      .run();
    await deleteWithoutThrow(
      destinationBucket,
      moves.map((move) => move.destinationKey),
    );
    throw new MediaError("MEDIA_MOVE_FAILED", 503);
  }

  await deleteWithoutThrow(
    sourceBucket,
    moves.map((move) => move.sourceKey),
  );
  return {
    uploadId: upload.id,
    state: "bound",
    scope: desiredScope,
    media: mediaPaths(upload.id, variants),
    changed: true,
  };
}

function postIsVisible(
  viewer: ViewerContext,
  row: MediaRow,
  categoryId: string,
): boolean {
  if (row.post_status === "published") return true;
  if (row.post_status !== "pending") return false;
  return (
    (viewer.userId === row.post_author_id &&
      (viewer.status === "active" || viewer.status === "silenced")) ||
    evaluateModerate(viewer, categoryId).allowed
  );
}

function safeMediaHeaders(
  scope: BoundScope,
  mimeType: SupportedImageMimeType,
  byteSize: number,
  etag: string,
): Headers {
  const headers = new Headers({
    "cache-control":
      scope === "public"
        ? "public, max-age=60, must-revalidate"
        : "private, no-store",
    "content-disposition": "inline",
    "content-length": String(byteSize),
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": mimeType,
    "cross-origin-resource-policy": "same-site",
    etag,
    "x-content-type-options": "nosniff",
  });
  if (scope === "private") headers.set("vary", "Cookie");
  return headers;
}

function contentHashEtag(contentHash: string): string | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(contentHash)) return null;
  const base64Url = contentHash
    .slice(0, -1)
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return `"sha256-${base64Url}"`;
}

export function ifNoneMatchMatches(
  headerValue: string | undefined,
  etag: string,
): boolean {
  if (!headerValue) return false;
  return headerValue.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag || value === `W/${etag}`;
  });
}

export async function serveMedia(
  env: Bindings,
  viewer: ViewerContext,
  uploadId: string,
  variant: MediaVariant,
  method: "GET" | "HEAD",
  ifNoneMatch?: string,
): Promise<Response> {
  const upload = await mediaRow(env, uploadId);
  if (
    !upload ||
    !upload.topic_id ||
    !upload.post_id ||
    (upload.scope !== "public" && upload.scope !== "private") ||
    !isSupportedMimeType(upload.mime_type)
  ) {
    throw new MediaError("MEDIA_NOT_FOUND", 404);
  }

  const aggregate = await getTopicAggregate(env.CFORUM_DB, upload.topic_id);
  if (!aggregate || aggregate.category.state === "deleted") {
    throw new MediaError("MEDIA_NOT_FOUND", 404);
  }
  if (upload.scope === "private") {
    if (
      !evaluateAccessUpload(viewer, aggregate.category, {
        id: upload.id,
        ownerUserId: upload.owner_user_id,
        topic: aggregate.topic,
        state: upload.state,
      }).allowed ||
      !postIsVisible(viewer, upload, aggregate.category.id)
    ) {
      throw new MediaError("MEDIA_NOT_FOUND", 404);
    }
  } else if (
    derivePostMediaScope(
      aggregate.category,
      aggregate.topic,
      upload.post_status,
    ) !== "public"
  ) {
    throw new MediaError("MEDIA_NOT_FOUND", 404);
  }

  const object = variant === "main" ? upload : await variantRow(env, uploadId);
  if (
    !object ||
    !isSupportedMimeType(object.mime_type) ||
    !contentHashEtag(object.content_hash) ||
    !isBoundObjectKey(object.object_key, uploadId, variant)
  ) {
    throw new MediaError("MEDIA_NOT_FOUND", 404);
  }
  const bucket =
    upload.scope === "public" ? env.PUBLIC_MEDIA : env.PRIVATE_MEDIA;
  const etag = contentHashEtag(object.content_hash);
  if (!etag) throw new MediaError("MEDIA_NOT_FOUND", 404);
  const stored =
    method === "HEAD" || ifNoneMatchMatches(ifNoneMatch, etag)
      ? await bucket.head(object.object_key)
      : await bucket.get(object.object_key);
  if (
    !stored ||
    stored.size !== object.byte_size ||
    stored.httpMetadata?.contentType?.toLowerCase() !== object.mime_type ||
    !stored.checksums.sha256 ||
    bytesToBase64(stored.checksums.sha256) !== object.content_hash
  ) {
    throw new MediaError("MEDIA_NOT_FOUND", 404);
  }

  const headers = safeMediaHeaders(
    upload.scope,
    object.mime_type,
    object.byte_size,
    etag,
  );
  if (ifNoneMatchMatches(ifNoneMatch, etag)) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }

  return new Response(
    method === "HEAD" ? null : (stored as R2ObjectBody).body,
    {
      status: 200,
      headers,
    },
  );
}

interface AvatarMediaRow {
  upload_id: string;
  object_key: string;
  content_hash: string;
  mime_type: string;
  byte_size: number;
  width: number;
  height: number;
  object_kind: "main" | "thumbnail";
}

export async function serveAvatar(
  env: Bindings,
  uploadId: string,
  method: "GET" | "HEAD",
  ifNoneMatch?: string,
): Promise<Response> {
  const object = await env.CFORUM_DB.prepare(
    `SELECT
       upload.id AS upload_id,
       thumb.object_key,
       thumb.content_hash,
       thumb.mime_type,
       thumb.byte_size,
       thumb.width,
       thumb.height,
       'thumbnail' AS object_kind
     FROM users owner
     JOIN uploads upload ON upload.id = owner.avatar_upload_id
     JOIN upload_variants thumb
       ON thumb.upload_id = upload.id AND thumb.kind = 'thumbnail'
     WHERE upload.id = ?1
       AND owner.status != 'deleted'
       AND upload.owner_user_id = owner.id
       AND upload.state = 'bound'
       AND upload.scope = 'public'
       AND upload.topic_id IS NULL
       AND upload.post_id IS NULL
     LIMIT 1`,
  ).bind(uploadId).first<AvatarMediaRow>();
  if (
    !object ||
    !isSupportedMimeType(object.mime_type) ||
    !Number.isInteger(object.width) ||
    !Number.isInteger(object.height) ||
    object.width < 1 ||
    object.height < 1 ||
    object.width > MAX_AVATAR_EDGE ||
    object.height > MAX_AVATAR_EDGE ||
    object.byte_size > MAX_AVATAR_THUMBNAIL_BYTES ||
    !contentHashEtag(object.content_hash) ||
    !isBoundObjectKey(object.object_key, uploadId, object.object_kind)
  ) {
    throw new MediaError("MEDIA_NOT_FOUND", 404);
  }

  const etag = contentHashEtag(object.content_hash);
  if (!etag) throw new MediaError("MEDIA_NOT_FOUND", 404);
  const stored =
    method === "HEAD" || ifNoneMatchMatches(ifNoneMatch, etag)
      ? await env.PUBLIC_MEDIA.head(object.object_key)
      : await env.PUBLIC_MEDIA.get(object.object_key);
  if (
    !stored ||
    stored.size !== object.byte_size ||
    stored.httpMetadata?.contentType?.toLowerCase() !== object.mime_type ||
    !stored.checksums.sha256 ||
    bytesToBase64(stored.checksums.sha256) !== object.content_hash
  ) {
    throw new MediaError("MEDIA_NOT_FOUND", 404);
  }

  const headers = safeMediaHeaders(
    "public",
    object.mime_type,
    object.byte_size,
    etag,
  );
  if (ifNoneMatchMatches(ifNoneMatch, etag)) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(
    method === "HEAD" ? null : (stored as R2ObjectBody).body,
    { status: 200, headers },
  );
}
