import { describe, expect, it } from "vitest";
import {
  clearPendingMediaBindJob,
  loadPendingMediaBindJob,
  pendingMediaBindStorageKey,
  savePendingMediaBindJob,
  type MediaBindingStorage,
  type PendingMediaBindJob,
} from "@/client/pendingMediaBindings";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB: PendingMediaBindJob = {
  topicId: "11111111-1111-4111-8111-111111111111",
  postId: "22222222-2222-4222-8222-222222222222",
  uploadIds: [
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ],
};

class MemoryStorage implements MediaBindingStorage {
  readonly values = new Map<string, string>();
  readonly removed: string[] = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removed.push(key);
    this.values.delete(key);
  }
}

describe("pending media binding storage", () => {
  it("persists only the binding identifiers in a user-scoped key", () => {
    const storage = new MemoryStorage();
    const attempted = {
      ...JOB,
      csrfToken: "must-not-persist",
      body: "must-not-persist",
      original: new Uint8Array([1, 2, 3]),
    };

    expect(savePendingMediaBindJob(storage, USER_A, attempted)).toBe(false);
    expect(storage.values.size).toBe(0);

    expect(savePendingMediaBindJob(storage, USER_A, JOB)).toBe(true);
    const key = pendingMediaBindStorageKey(USER_A);
    expect(key).not.toBeNull();
    const raw = storage.getItem(key as string);
    expect(JSON.parse(raw as string)).toEqual(JOB);
    expect(Object.keys(JSON.parse(raw as string)).sort()).toEqual([
      "postId",
      "topicId",
      "uploadIds",
    ]);
    expect(raw).not.toContain("csrf");
    expect(raw).not.toContain("body");
    expect(raw).not.toContain("original");
  });

  it("isolates jobs by user and clears only after an explicit success", () => {
    const storage = new MemoryStorage();
    expect(savePendingMediaBindJob(storage, USER_A, JOB)).toBe(true);

    expect(loadPendingMediaBindJob(storage, USER_B)).toBeNull();
    expect(loadPendingMediaBindJob(storage, USER_A)).toEqual(JOB);
    expect(loadPendingMediaBindJob(storage, USER_A)).toEqual(JOB);

    expect(clearPendingMediaBindJob(storage, USER_A)).toBe(true);
    expect(loadPendingMediaBindJob(storage, USER_A)).toBeNull();
  });

  it.each([
    "not-json",
    JSON.stringify({ ...JOB, csrfToken: "leak" }),
    JSON.stringify({ ...JOB, uploadIds: [] }),
    JSON.stringify({ ...JOB, uploadIds: ["not-a-uuid"] }),
    JSON.stringify({ ...JOB, uploadIds: [JOB.uploadIds[0], JOB.uploadIds[0]] }),
  ])("rejects and removes malformed or over-broad stored data", (raw) => {
    const storage = new MemoryStorage();
    const key = pendingMediaBindStorageKey(USER_A) as string;
    storage.values.set(key, raw);

    expect(loadPendingMediaBindJob(storage, USER_A)).toBeNull();
    expect(storage.values.has(key)).toBe(false);
    expect(storage.removed).toContain(key);
  });

  it("fails closed when the user scope is not a safe key segment", () => {
    const storage = new MemoryStorage();
    expect(savePendingMediaBindJob(storage, "../other-user", JOB)).toBe(false);
    expect(loadPendingMediaBindJob(storage, "../other-user")).toBeNull();
    expect(storage.values.size).toBe(0);
  });
});
