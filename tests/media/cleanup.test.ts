import { describe, expect, it } from "vitest";
import type { Bindings } from "@/worker/env";
import {
  cleanupStaleMedia,
  DELETED_MEDIA_RETENTION_SECONDS,
  STALE_MEDIA_GRACE_SECONDS,
} from "@/worker/media/cleanup";

const NOW = 2_000_000_000;
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const VALID_KEY =
  `tmp/${OWNER_ID}/66666666-6666-4666-8666-666666666666.png`;

interface FakeStatement {
  sql: string;
  values: unknown[];
  bind: (...values: unknown[]) => FakeStatement;
  first: () => Promise<unknown>;
  all: () => Promise<D1Result>;
  run: () => Promise<D1Result>;
}

function d1Result(rows: unknown[] = [], changes = 0): D1Result {
  return {
    success: true,
    results: rows,
    meta: { changes },
  } as unknown as D1Result;
}

function cleanupDatabase(
  uploads: Array<Record<string, unknown>>,
): { database: D1Database; quarantined: string[] } {
  const quarantined: string[] = [];
  const database = {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        values: [],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first() {
          if (sql.includes("SELECT value_json FROM site_settings")) return null;
          throw new Error(`unexpected first query: ${sql}`);
        },
        async all() {
          if (sql.includes("avatar.scope = 'public'")) return d1Result([]);
          if (sql.includes("FROM uploads") && sql.includes("ORDER BY created_at")) {
            return d1Result(uploads);
          }
          if (sql.includes("FROM upload_variants")) return d1Result([]);
          throw new Error(`unexpected all query: ${sql}`);
        },
        async run() {
          if (sql.includes("SET state = 'quarantined'")) {
            quarantined.push(String(statement.values[0]));
            return d1Result([], 1);
          }
          if (sql.includes("INSERT INTO site_settings")) {
            return d1Result([], 1);
          }
          throw new Error(`unexpected run query: ${sql}`);
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      return statements.map((rawStatement) => {
        const statement = rawStatement as unknown as FakeStatement;
        if (statement.sql.includes("SET state = 'deleted'")) {
          return d1Result([], 1);
        }
        if (statement.sql.includes("UPDATE usage_counters")) {
          return d1Result([], 1);
        }
        if (statement.sql.includes("UPDATE upload_reservations")) {
          return d1Result([], 1);
        }
        throw new Error(`unexpected batch query: ${statement.sql}`);
      });
    },
  } as unknown as D1Database;
  return { database, quarantined };
}

class CleanupBucket {
  readonly deleted: string[][] = [];
  readonly listed: R2Object[];
  failDeletes = false;

  constructor(listed: R2Object[] = []) {
    this.listed = listed;
  }

  async delete(keys: string | string[]): Promise<void> {
    const values = Array.isArray(keys) ? keys : [keys];
    this.deleted.push(values);
    if (this.failDeletes && values.some((key) => key.startsWith("tmp/"))) {
      throw new Error("simulated R2 failure");
    }
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    return {
      objects: this.listed.filter((object) =>
        object.key.startsWith(options?.prefix ?? ""),
      ),
      delimitedPrefixes: [],
      truncated: false,
    };
  }

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

function listedObject(key: string): R2Object {
  return {
    key,
    version: "v1",
    size: 24,
    etag: "etag",
    httpEtag: '"etag"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date((NOW - STALE_MEDIA_GRACE_SECONDS - 1) * 1000),
    storageClass: "Standard",
    writeHttpMetadata() {},
  } as unknown as R2Object;
}

function retainedDeletedDatabase(retentionBindings: unknown[][]): D1Database {
  return {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        values: [],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first() {
          if (sql.includes("SELECT value_json FROM site_settings")) return null;
          throw new Error(`unexpected first query: ${sql}`);
        },
        async all() {
          if (sql.includes("avatar.scope = 'public'")) return d1Result([]);
          if (sql.includes("FROM uploads") && sql.includes("ORDER BY created_at")) {
            return d1Result([]);
          }
          throw new Error(`unexpected all query: ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO site_settings")) return d1Result([], 1);
          throw new Error(`unexpected run query: ${sql}`);
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      return statements.map((rawStatement) => {
        const statement = rawStatement as unknown as FakeStatement;
        if (!statement.sql.includes("SELECT EXISTS")) {
          throw new Error(`unexpected batch query: ${statement.sql}`);
        }
        retentionBindings.push(statement.values);
        return d1Result([{ referenced: 1 }]);
      });
    },
  } as unknown as D1Database;
}

function orphanAvatarDatabase(input: {
  uploadId: string;
  mainKey: string;
  thumbnailKey: string;
}): {
  database: D1Database;
  retired: string[];
  control: { failNextRetirementBatch: boolean };
} {
  const retired: string[] = [];
  const control = { failNextRetirementBatch: false };
  const database = {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        values: [],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
        async first() {
          if (sql.includes("SELECT value_json FROM site_settings")) return null;
          throw new Error(`unexpected first query: ${sql}`);
        },
        async all() {
          if (sql.includes("avatar.scope = 'public'")) {
            return d1Result([
              {
                id: input.uploadId,
                owner_user_id: OWNER_ID,
                object_key: input.mainKey,
                byte_size: 24,
              },
            ]);
          }
          if (sql.includes("scope = 'temporary'")) return d1Result([]);
          if (sql.includes("FROM upload_variants")) {
            return d1Result([
              {
                kind: "thumbnail",
                object_key: input.thumbnailKey,
                byte_size: 12,
              },
            ]);
          }
          throw new Error(`unexpected all query: ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO site_settings")) return d1Result([], 1);
          throw new Error(`unexpected run query: ${sql}`);
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      if (
        control.failNextRetirementBatch &&
        statements.some((rawStatement) =>
          (rawStatement as unknown as FakeStatement).sql.includes(
            "SET state = 'deleted'",
          ),
        )
      ) {
        control.failNextRetirementBatch = false;
        throw new Error("simulated D1 retirement failure");
      }
      return statements.map((rawStatement) => {
        const statement = rawStatement as unknown as FakeStatement;
        if (statement.sql.includes("SET state = 'deleted'")) {
          retired.push(String(statement.values[0]));
          return d1Result([], 1);
        }
        if (statement.sql.includes("UPDATE usage_counters")) {
          return d1Result([], 1);
        }
        throw new Error(`unexpected batch query: ${statement.sql}`);
      });
    },
  } as unknown as D1Database;
  return { database, retired, control };
}

function bindings(
  database: D1Database,
  privateBucket: R2Bucket,
  publicBucket = new CleanupBucket().asBucket(),
): Bindings {
  return {
    CFORUM_DB: database,
    PRIVATE_MEDIA: privateBucket,
    PUBLIC_MEDIA: publicBucket,
  } as unknown as Bindings;
}

function staleUpload(
  id: string,
  objectKey: string,
): Record<string, unknown> {
  return {
    id,
    reservation_id: null,
    owner_user_id: OWNER_ID,
    state: "reserved",
    object_key: objectKey,
    byte_size: 24,
    created_at: NOW - STALE_MEDIA_GRACE_SECONDS - 1,
  };
}

describe("stale media cleanup", () => {
  it("deletes safe temporary objects but quarantines an injected database key", async () => {
    const maliciousId = "99999999-9999-4999-8999-999999999999";
    const { database, quarantined } = cleanupDatabase([
      staleUpload("88888888-8888-4888-8888-888888888888", VALID_KEY),
      staleUpload(maliciousId, `tmp/${OWNER_ID}/../../secret.png`),
    ]);
    const privateBucket = new CleanupBucket();

    const result = await cleanupStaleMedia(
      bindings(database, privateBucket.asBucket()),
      NOW,
    );

    expect(result).toMatchObject({
      examined: 2,
      deleted: 1,
      quarantined: 1,
      failed: 0,
    });
    expect(quarantined).toEqual([maliciousId]);
    expect(privateBucket.deleted).toContainEqual([VALID_KEY]);
    expect(JSON.stringify(privateBucket.deleted)).not.toContain("secret.png");
  });

  it("leaves D1 unchanged after an R2 deletion failure so Cron can retry", async () => {
    const { database, quarantined } = cleanupDatabase([
      staleUpload("88888888-8888-4888-8888-888888888888", VALID_KEY),
    ]);
    const privateBucket = new CleanupBucket();
    privateBucket.failDeletes = true;

    const result = await cleanupStaleMedia(
      bindings(database, privateBucket.asBucket()),
      NOW,
    );

    expect(result).toMatchObject({
      examined: 1,
      deleted: 0,
      quarantined: 0,
      failed: 1,
    });
    expect(quarantined).toEqual([]);
  });

  it("retains a recently soft-deleted bound object for the seven-day recovery window", async () => {
    const key =
      "bound/11111111-1111-4111-8111-111111111111/" +
      "55555555-5555-4555-8555-555555555555/main.png";
    const retentionBindings: unknown[][] = [];
    const publicBucket = new CleanupBucket([listedObject(key)]);

    const result = await cleanupStaleMedia(
      bindings(
        retainedDeletedDatabase(retentionBindings),
        new CleanupBucket().asBucket(),
        publicBucket.asBucket(),
      ),
      NOW,
    );

    expect(result.orphanObjectsExamined).toBe(1);
    expect(result.orphanObjectsDeleted).toBe(0);
    expect(publicBucket.deleted).toEqual([]);
    expect(retentionBindings).toContainEqual([
      key,
      NOW - DELETED_MEDIA_RETENTION_SECONDS,
    ]);
  });

  it("retries an unreferenced bound avatar after retirement previously failed", async () => {
    const uploadId = "11111111-1111-4111-8111-111111111111";
    const attemptId = "55555555-5555-4555-8555-555555555555";
    const mainKey = `bound/${uploadId}/${attemptId}/main.png`;
    const thumbnailKey = `bound/${uploadId}/${attemptId}/thumbnail.png`;
    const { database, retired, control } = orphanAvatarDatabase({
      uploadId,
      mainKey,
      thumbnailKey,
    });
    const publicBucket = new CleanupBucket();
    control.failNextRetirementBatch = true;

    const failed = await cleanupStaleMedia(
      bindings(
        database,
        new CleanupBucket().asBucket(),
        publicBucket.asBucket(),
      ),
      NOW,
    );
    expect(failed).toMatchObject({
      examined: 1,
      deleted: 0,
      failed: 1,
      hasMore: true,
    });
    expect(retired).toEqual([]);

    const retried = await cleanupStaleMedia(
      bindings(
        database,
        new CleanupBucket().asBucket(),
        publicBucket.asBucket(),
      ),
      NOW,
    );
    expect(retried).toMatchObject({ examined: 1, deleted: 1, failed: 0 });
    expect(retired).toEqual([uploadId]);
    expect(publicBucket.deleted).toContainEqual([mainKey, thumbnailKey]);
  });
});
