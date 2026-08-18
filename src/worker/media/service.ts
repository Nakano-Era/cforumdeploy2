import type { TrustLevel } from "@/shared/domain";
import type { Bindings } from "@/worker/env";
import {
  DEFAULT_R2_HARD_LIMIT_BYTES,
  DEFAULT_R2_SOFT_LIMIT_BYTES,
  extensionForMimeType,
  MAX_HEADER_BYTES,
  MEDIA_DAILY_USAGE_RESOURCE,
  PRESIGNED_PUT_TTL_SECONDS,
  R2_STORAGE_COUNTER_KEY,
  R2_STORAGE_PERIOD_KEY,
  R2_STORAGE_USAGE_RESOURCE,
  type SupportedImageMimeType,
} from "@/worker/media/constants";
import { MediaError } from "@/worker/media/errors";
import { validateImageHeader } from "@/worker/media/image-header";
import { presignR2Put, type PresignedPutRequest } from "@/worker/media/presign";
import {
  evaluateMediaQuota,
  type MediaQuotaSnapshot,
} from "@/worker/media/quota";
import {
  countBytes,
  countObjects,
  type AuthorizeUploadsInput,
} from "@/worker/media/schema";

interface MediaUser {
  userId: string;
  trustLevel: TrustLevel;
}

interface StoredObjectPlan {
  id: string;
  uploadId: string;
  kind: "main" | "thumbnail";
  objectKey: string;
  contentType: SupportedImageMimeType;
  checksumSha256: string;
  bytes: number;
  width: number;
  height: number;
  signedRequest: PresignedPutRequest;
}

interface UploadPlan {
  id: string;
  filename: string;
  main: StoredObjectPlan;
  thumbnail: StoredObjectPlan | null;
}

export interface AuthorizedUpload {
  uploadId: string;
  main: PresignedPutRequest;
  thumbnail?: PresignedPutRequest;
}

export interface AuthorizeUploadsResult {
  reservationId: string;
  expiresAt: number;
  capacityWarning: boolean;
  quota: {
    dailyLimitBytes: number;
    dailyRemainingBytes: number;
    siteRemainingBytes: number;
  };
  uploads: AuthorizedUpload[];
}

export interface FinalizeUploadsResult {
  reservationId: string;
  state: "uploaded";
  uploads: Array<{ uploadId: string }>;
}

interface QuotaRow {
  daily_used_bytes: number;
  active_user_reserved_bytes: number;
  stored_bytes: number;
  active_site_reserved_bytes: number;
  soft_limit_bytes: number;
  hard_limit_bytes: number;
}

interface ReservationRow {
  id: string;
  user_id: string;
  reserved_bytes: number;
  object_count: number;
  status: "active" | "finalized" | "expired" | "cancelled";
  expires_at: number;
}

interface UploadRow {
  id: string;
  reservation_id: string | null;
  owner_user_id: string;
  scope: "temporary" | "public" | "private";
  state: "reserved" | "uploaded" | "bound" | "quarantined" | "deleted";
  object_key: string;
  content_hash: string;
  mime_type: SupportedImageMimeType;
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
  mime_type: SupportedImageMimeType;
  byte_size: number;
  width: number;
  height: number;
}

function utcPeriodKey(nowSeconds: number): string {
  return new Date(nowSeconds * 1000).toISOString().slice(0, 10);
}

function numberOr(value: number | null | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : fallback;
}

async function quotaSnapshot(
  env: Bindings,
  userId: string,
  now: number,
): Promise<MediaQuotaSnapshot> {
  const row = await env.CFORUM_DB.prepare(
    `SELECT
       COALESCE((
         SELECT value FROM usage_counters
         WHERE resource = ?1 AND period_key = ?2 AND counter_key = ?3
       ), 0) AS daily_used_bytes,
       COALESCE((
         SELECT SUM(reserved_bytes) FROM upload_reservations
         WHERE user_id = ?3 AND status = 'active' AND expires_at > ?4
       ), 0) AS active_user_reserved_bytes,
       COALESCE((
         SELECT value FROM usage_counters
         WHERE resource = ?5 AND period_key = ?6 AND counter_key = ?7
       ), 0) AS stored_bytes,
       COALESCE((
         SELECT SUM(reserved_bytes) FROM upload_reservations
         WHERE status = 'active' AND expires_at > ?4
       ), 0) AS active_site_reserved_bytes,
       COALESCE((
         SELECT CAST(json_extract(value_json, '$') AS INTEGER)
         FROM site_settings WHERE key = 'r2_soft_limit_bytes'
       ), ?8) AS soft_limit_bytes,
       COALESCE((
         SELECT CAST(json_extract(value_json, '$') AS INTEGER)
         FROM site_settings WHERE key = 'r2_hard_limit_bytes'
       ), ?9) AS hard_limit_bytes`,
  )
    .bind(
      MEDIA_DAILY_USAGE_RESOURCE,
      utcPeriodKey(now),
      userId,
      now,
      R2_STORAGE_USAGE_RESOURCE,
      R2_STORAGE_PERIOD_KEY,
      R2_STORAGE_COUNTER_KEY,
      DEFAULT_R2_SOFT_LIMIT_BYTES,
      DEFAULT_R2_HARD_LIMIT_BYTES,
    )
    .first<QuotaRow>();

  return {
    dailyUsedBytes: row?.daily_used_bytes ?? 0,
    activeUserReservedBytes: row?.active_user_reserved_bytes ?? 0,
    storedBytes: row?.stored_bytes ?? 0,
    activeSiteReservedBytes: row?.active_site_reserved_bytes ?? 0,
    softLimitBytes: numberOr(
      row?.soft_limit_bytes,
      DEFAULT_R2_SOFT_LIMIT_BYTES,
    ),
    hardLimitBytes: numberOr(
      row?.hard_limit_bytes,
      DEFAULT_R2_HARD_LIMIT_BYTES,
    ),
  };
}

function signingConfiguration(env: Bindings) {
  if (
    !env.R2_ACCOUNT_ID?.trim() ||
    !env.R2_ACCESS_KEY_ID?.trim() ||
    !env.R2_SECRET_ACCESS_KEY?.trim() ||
    !env.PRIVATE_MEDIA_BUCKET_NAME?.trim()
  ) {
    throw new MediaError("MEDIA_SIGNING_UNAVAILABLE", 503);
  }
  return {
    accountId: env.R2_ACCOUNT_ID,
    bucketName: env.PRIVATE_MEDIA_BUCKET_NAME,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

function assertSafeUserKeySegment(userId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    throw new MediaError("MEDIA_SIGNING_UNAVAILABLE", 503);
  }
}

function temporaryObjectKey(
  userId: string,
  mimeType: SupportedImageMimeType,
): string {
  return `tmp/${userId}/${crypto.randomUUID()}.${extensionForMimeType(mimeType)}`;
}

async function prepareUploadPlans(
  env: Bindings,
  userId: string,
  input: AuthorizeUploadsInput,
  now: number,
): Promise<UploadPlan[]> {
  assertSafeUserKeySegment(userId);
  const configuration = signingConfiguration(env);

  return Promise.all(
    input.uploads.map(async (upload): Promise<UploadPlan> => {
      const uploadId = crypto.randomUUID();
      const mainKey = temporaryObjectKey(userId, upload.main.contentType);
      const main: StoredObjectPlan = {
        id: uploadId,
        uploadId,
        kind: "main",
        objectKey: mainKey,
        contentType: upload.main.contentType,
        checksumSha256: upload.main.checksumSha256,
        bytes: upload.main.bytes,
        width: upload.main.width,
        height: upload.main.height,
        signedRequest: await presignR2Put(
          configuration,
          mainKey,
          upload.main.contentType,
          upload.main.checksumSha256,
          new Date(now * 1000),
        ),
      };

      let thumbnail: StoredObjectPlan | null = null;
      if (upload.thumbnail) {
        const thumbnailKey = temporaryObjectKey(
          userId,
          upload.thumbnail.contentType,
        );
        thumbnail = {
          id: crypto.randomUUID(),
          uploadId,
          kind: "thumbnail",
          objectKey: thumbnailKey,
          contentType: upload.thumbnail.contentType,
          checksumSha256: upload.thumbnail.checksumSha256,
          bytes: upload.thumbnail.bytes,
          width: upload.thumbnail.width,
          height: upload.thumbnail.height,
          signedRequest: await presignR2Put(
            configuration,
            thumbnailKey,
            upload.thumbnail.contentType,
            upload.thumbnail.checksumSha256,
            new Date(now * 1000),
          ),
        };
      }

      return { id: uploadId, filename: upload.filename, main, thumbnail };
    }),
  );
}

function reservationInsert(
  env: Bindings,
  reservationId: string,
  userId: string,
  reservedBytes: number,
  objectCount: number,
  now: number,
  expiresAt: number,
  dailyLimitBytes: number,
  hardLimitBytes: number,
): D1PreparedStatement {
  return env.CFORUM_DB.prepare(
    `INSERT INTO upload_reservations(
       id, user_id, reserved_bytes, object_count, status, created_at, expires_at
     )
     SELECT ?1, ?2, ?3, ?4, 'active', ?5, ?6
     WHERE (
       COALESCE((
         SELECT value FROM usage_counters
         WHERE resource = ?7 AND period_key = ?8 AND counter_key = ?2
       ), 0)
       + COALESCE((
         SELECT SUM(reserved_bytes) FROM upload_reservations
         WHERE user_id = ?2 AND status = 'active' AND expires_at > ?5
       ), 0)
       + ?3
     ) <= ?9
       AND (
         COALESCE((
           SELECT value FROM usage_counters
           WHERE resource = ?10 AND period_key = ?11 AND counter_key = ?12
         ), 0)
         + COALESCE((
           SELECT SUM(reserved_bytes) FROM upload_reservations
           WHERE status = 'active' AND expires_at > ?5
         ), 0)
         + ?3
       ) <= ?13`,
  ).bind(
    reservationId,
    userId,
    reservedBytes,
    objectCount,
    now,
    expiresAt,
    MEDIA_DAILY_USAGE_RESOURCE,
    utcPeriodKey(now),
    dailyLimitBytes,
    R2_STORAGE_USAGE_RESOURCE,
    R2_STORAGE_PERIOD_KEY,
    R2_STORAGE_COUNTER_KEY,
    hardLimitBytes,
  );
}

function uploadInsert(
  env: Bindings,
  reservationId: string,
  userId: string,
  plan: UploadPlan,
  now: number,
): D1PreparedStatement {
  return env.CFORUM_DB.prepare(
    `INSERT INTO uploads(
       id, reservation_id, owner_user_id, scope, state, object_key,
       original_filename, content_hash, mime_type, byte_size, width, height,
       min_view_level, created_at
     )
     SELECT ?1, ?2, ?3, 'temporary', 'reserved', ?4,
            ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11
     WHERE EXISTS (
       SELECT 1 FROM upload_reservations
       WHERE id = ?2 AND user_id = ?3 AND status = 'active'
     )`,
  ).bind(
    plan.id,
    reservationId,
    userId,
    plan.main.objectKey,
    plan.filename,
    plan.main.checksumSha256,
    plan.main.contentType,
    plan.main.bytes,
    plan.main.width,
    plan.main.height,
    now,
  );
}

function variantInsert(
  env: Bindings,
  plan: StoredObjectPlan,
  now: number,
): D1PreparedStatement {
  return env.CFORUM_DB.prepare(
    `INSERT INTO upload_variants(
       id, upload_id, kind, object_key, content_hash, mime_type,
       byte_size, width, height, created_at
     )
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
     WHERE EXISTS (
       SELECT 1 FROM uploads WHERE id = ?2 AND state = 'reserved'
     )`,
  ).bind(
    plan.id,
    plan.uploadId,
    plan.kind,
    plan.objectKey,
    plan.checksumSha256,
    plan.contentType,
    plan.bytes,
    plan.width,
    plan.height,
    now,
  );
}

export async function authorizeUploads(
  env: Bindings,
  user: MediaUser,
  input: AuthorizeUploadsInput,
  now = Math.floor(Date.now() / 1000),
): Promise<AuthorizeUploadsResult> {
  const reservedBytes = countBytes(input);
  const objectCount = countObjects(input);
  const snapshot = await quotaSnapshot(env, user.userId, now);
  const quota = evaluateMediaQuota(user.trustLevel, reservedBytes, snapshot);
  if (!quota.allowed) {
    throw quota.reason === "daily_limit"
      ? new MediaError("UPLOAD_DAILY_QUOTA_EXCEEDED", 429)
      : new MediaError("UPLOAD_SITE_CAPACITY_EXCEEDED", 503);
  }

  const plans = await prepareUploadPlans(env, user.userId, input, now);
  const reservationId = crypto.randomUUID();
  const expiresAt = now + PRESIGNED_PUT_TTL_SECONDS;
  const statements: D1PreparedStatement[] = [
    reservationInsert(
      env,
      reservationId,
      user.userId,
      reservedBytes,
      objectCount,
      now,
      expiresAt,
      quota.dailyLimitBytes,
      snapshot.hardLimitBytes,
    ),
  ];
  for (const plan of plans) {
    statements.push(uploadInsert(env, reservationId, user.userId, plan, now));
    if (plan.thumbnail) statements.push(variantInsert(env, plan.thumbnail, now));
  }

  const results = await env.CFORUM_DB.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new MediaError("UPLOAD_DAILY_QUOTA_EXCEEDED", 429);
  }

  return {
    reservationId,
    expiresAt,
    capacityWarning: quota.capacityWarning,
    quota: {
      dailyLimitBytes: quota.dailyLimitBytes,
      dailyRemainingBytes: quota.dailyRemainingBytes,
      siteRemainingBytes: quota.siteRemainingBytes,
    },
    uploads: plans.map((plan) => ({
      uploadId: plan.id,
      main: plan.main.signedRequest,
      ...(plan.thumbnail
        ? { thumbnail: plan.thumbnail.signedRequest }
        : {}),
    })),
  };
}

function bytesToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function verifyStoredObject(
  bucket: R2Bucket,
  object: Pick<
    UploadRow | VariantRow,
    | "object_key"
    | "content_hash"
    | "mime_type"
    | "byte_size"
    | "width"
    | "height"
  >,
): Promise<void> {
  const head = await bucket.head(object.object_key);
  if (
    !head ||
    head.size !== object.byte_size ||
    head.httpMetadata?.contentType?.toLowerCase() !== object.mime_type ||
    !head.checksums.sha256 ||
    bytesToBase64(head.checksums.sha256) !== object.content_hash ||
    object.width === null ||
    object.height === null
  ) {
    throw new MediaError("UPLOAD_VALIDATION_FAILED", 422);
  }

  const body = await bucket.get(object.object_key, {
    range: {
      offset: 0,
      length: Math.min(MAX_HEADER_BYTES, object.byte_size),
    },
  });
  if (!body) throw new MediaError("UPLOAD_VALIDATION_FAILED", 422);
  try {
    validateImageHeader(new Uint8Array(await body.arrayBuffer()), {
      mimeType: object.mime_type,
      width: object.width,
      height: object.height,
    });
  } catch {
    throw new MediaError("UPLOAD_VALIDATION_FAILED", 422);
  }
}

async function reservationUploads(
  env: Bindings,
  reservationId: string,
): Promise<{ uploads: UploadRow[]; variants: VariantRow[] }> {
  const results = await env.CFORUM_DB.batch([
    env.CFORUM_DB.prepare(
      `SELECT id, reservation_id, owner_user_id, scope, state, object_key,
              content_hash, mime_type, byte_size, width, height
       FROM uploads
       WHERE reservation_id = ?1
       ORDER BY id`,
    ).bind(reservationId),
    env.CFORUM_DB.prepare(
      `SELECT v.id, v.upload_id, v.kind, v.object_key, v.content_hash,
              v.mime_type, v.byte_size, v.width, v.height
       FROM upload_variants v
       JOIN uploads u ON u.id = v.upload_id
       WHERE u.reservation_id = ?1
       ORDER BY v.upload_id, v.kind`,
    ).bind(reservationId),
  ]);
  return {
    uploads: results[0].results as unknown as UploadRow[],
    variants: results[1].results as unknown as VariantRow[],
  };
}

function uploadedResult(
  reservationId: string,
  uploads: readonly UploadRow[],
): FinalizeUploadsResult {
  return {
    reservationId,
    state: "uploaded",
    uploads: uploads.map((upload) => ({ uploadId: upload.id })),
  };
}

export async function finalizeUploads(
  env: Bindings,
  userId: string,
  reservationId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<FinalizeUploadsResult> {
  const reservation = await env.CFORUM_DB.prepare(
    `SELECT id, user_id, reserved_bytes, object_count, status, expires_at
     FROM upload_reservations
     WHERE id = ?1 AND user_id = ?2
     LIMIT 1`,
  )
    .bind(reservationId, userId)
    .first<ReservationRow>();
  if (!reservation) {
    throw new MediaError("UPLOAD_RESERVATION_NOT_FOUND", 404);
  }

  const records = await reservationUploads(env, reservationId);
  if (records.uploads.length === 0) {
    throw new MediaError("UPLOAD_RESERVATION_UNAVAILABLE", 409);
  }
  if (reservation.status === "finalized") {
    return uploadedResult(reservationId, records.uploads);
  }
  if (reservation.status !== "active") {
    throw new MediaError("UPLOAD_RESERVATION_UNAVAILABLE", 409);
  }
  if (reservation.expires_at <= now) {
    await env.CFORUM_DB.prepare(
      `UPDATE upload_reservations
       SET status = 'expired'
       WHERE id = ?1 AND user_id = ?2 AND status = 'active'`,
    )
      .bind(reservationId, userId)
      .run();
    throw new MediaError("UPLOAD_RESERVATION_EXPIRED", 410);
  }
  if (
    records.uploads.some(
      (upload) =>
        upload.owner_user_id !== userId ||
        upload.scope !== "temporary" ||
        upload.state !== "reserved",
    ) ||
    records.uploads.length + records.variants.length !== reservation.object_count
  ) {
    throw new MediaError("UPLOAD_RESERVATION_UNAVAILABLE", 409);
  }

  await Promise.all([
    ...records.uploads.map((upload) =>
      verifyStoredObject(env.PRIVATE_MEDIA, upload),
    ),
    ...records.variants.map((variant) =>
      verifyStoredObject(env.PRIVATE_MEDIA, variant),
    ),
  ]);

  const periodKey = utcPeriodKey(now);
  const finalizeResults = await env.CFORUM_DB.batch([
    env.CFORUM_DB.prepare(
      `UPDATE upload_reservations
       SET status = 'finalized'
       WHERE id = ?1 AND user_id = ?2 AND status = 'active' AND expires_at > ?3`,
    ).bind(reservationId, userId, now),
    env.CFORUM_DB.prepare(
      `INSERT INTO usage_counters(resource, period_key, counter_key, value, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() = 1
       ON CONFLICT(resource, period_key, counter_key) DO UPDATE SET
         value = value + excluded.value,
         updated_at = excluded.updated_at`,
    ).bind(
      MEDIA_DAILY_USAGE_RESOURCE,
      periodKey,
      userId,
      reservation.reserved_bytes,
      now,
    ),
    env.CFORUM_DB.prepare(
      `INSERT INTO usage_counters(resource, period_key, counter_key, value, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() = 1
       ON CONFLICT(resource, period_key, counter_key) DO UPDATE SET
         value = value + excluded.value,
         updated_at = excluded.updated_at`,
    ).bind(
      R2_STORAGE_USAGE_RESOURCE,
      R2_STORAGE_PERIOD_KEY,
      R2_STORAGE_COUNTER_KEY,
      reservation.reserved_bytes,
      now,
    ),
    env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET state = 'uploaded', finalized_at = ?2
       WHERE reservation_id = ?1
         AND owner_user_id = ?3
         AND state = 'reserved'
         AND EXISTS (
           SELECT 1 FROM upload_reservations
           WHERE id = ?1 AND status = 'finalized'
         )`,
    ).bind(reservationId, now, userId),
  ]);

  if ((finalizeResults[0]?.meta.changes ?? 0) !== 1) {
    const current = await env.CFORUM_DB.prepare(
      `SELECT status FROM upload_reservations
       WHERE id = ?1 AND user_id = ?2
       LIMIT 1`,
    )
      .bind(reservationId, userId)
      .first<{ status: ReservationRow["status"] }>();
    if (current?.status !== "finalized") {
      throw new MediaError("UPLOAD_RESERVATION_UNAVAILABLE", 409);
    }
  }

  return uploadedResult(
    reservationId,
    records.uploads.map((upload) => ({ ...upload, state: "uploaded" })),
  );
}

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i;

export function isTemporaryObjectKey(key: string, userId: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return false;
  const prefix = `tmp/${userId}/`;
  if (!key.startsWith(prefix)) return false;
  return UUID_SEGMENT.test(key.slice(prefix.length));
}

export function isAnyTemporaryObjectKey(key: string): boolean {
  const parts = key.split("/");
  return (
    parts.length === 3 &&
    parts[0] === "tmp" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(parts[1] ?? "") &&
    UUID_SEGMENT.test(parts[2] ?? "")
  );
}

export async function deleteTemporaryUpload(
  env: Bindings,
  userId: string,
  uploadId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const upload = await env.CFORUM_DB.prepare(
    `SELECT id, reservation_id, owner_user_id, scope, state, object_key,
            content_hash, mime_type, byte_size, width, height
     FROM uploads
     WHERE id = ?1 AND owner_user_id = ?2
     LIMIT 1`,
  )
    .bind(uploadId, userId)
    .first<UploadRow>();
  if (!upload) throw new MediaError("UPLOAD_NOT_FOUND", 404);
  if (upload.state === "deleted") return;
  if (
    upload.scope !== "temporary" ||
    !["reserved", "uploaded"].includes(upload.state) ||
    !isTemporaryObjectKey(upload.object_key, userId)
  ) {
    throw new MediaError("UPLOAD_NOT_DELETABLE", 409);
  }

  const variants = await env.CFORUM_DB.prepare(
    `SELECT v.id, v.upload_id, v.kind, v.object_key, v.content_hash,
            v.mime_type, v.byte_size, v.width, v.height
     FROM upload_variants v
     WHERE v.upload_id = ?1`,
  )
    .bind(uploadId)
    .all<VariantRow>();
  const objectKeys = [upload.object_key, ...variants.results.map((v) => v.object_key)];
  if (objectKeys.some((key) => !isTemporaryObjectKey(key, userId))) {
    throw new MediaError("UPLOAD_NOT_DELETABLE", 409);
  }

  await env.PRIVATE_MEDIA.delete(objectKeys);
  const storedBytes =
    upload.byte_size + variants.results.reduce((sum, row) => sum + row.byte_size, 0);
  const statements: D1PreparedStatement[] = [
    env.CFORUM_DB.prepare(
      `UPDATE uploads
       SET state = 'deleted', deleted_at = ?3
       WHERE id = ?1 AND owner_user_id = ?2 AND state IN ('reserved', 'uploaded')`,
    ).bind(uploadId, userId, now),
  ];
  if (upload.state === "uploaded") {
    statements.push(
      env.CFORUM_DB.prepare(
        `UPDATE usage_counters
         SET value = MAX(0, value - ?1), updated_at = ?2
         WHERE resource = ?3 AND period_key = ?4 AND counter_key = ?5`,
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
         WHERE id = ?1 AND status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM uploads
             WHERE reservation_id = ?1 AND state != 'deleted'
           )`,
      ).bind(upload.reservation_id),
    );
  }
  await env.CFORUM_DB.batch(statements);
}
