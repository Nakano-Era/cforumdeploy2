import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DirectUploadError,
  putSignedObjects,
  recognizableAuthorizedUploadIds,
  type SignedObjectUpload,
} from "@/client/media";

const UPLOAD_A = "11111111-1111-4111-8111-111111111111";
const UPLOAD_B = "22222222-2222-4222-8222-222222222222";
const CHECKSUM = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function signedObject(url: string): SignedObjectUpload {
  return {
    request: {
      url,
      method: "PUT",
      headers: {
        "content-type": "image/webp",
        "x-amz-checksum-sha256": CHECKSUM,
      },
      expiresInSeconds: 300,
    },
    blob: new Blob([url], { type: "image/webp" }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signed object upload batches", () => {
  it("waits for every PUT to settle before rejecting with the first input error", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", fetchMock);
    const progress: Array<[number, number]> = [];
    let outcome: "pending" | "resolved" | "rejected" = "pending";

    const operation = putSignedObjects(
      [signedObject("https://r2.example/first"), signedObject("https://r2.example/second")],
      (settled, total) => progress.push([settled, total]),
    );
    void operation.then(
      () => { outcome = "resolved"; },
      () => { outcome = "rejected"; },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.resolve(new Response(null, { status: 500 }));
    await flushMicrotasks();
    expect(outcome).toBe("pending");
    expect(progress).toEqual([[1, 2]]);

    first.resolve(new Response(null, { status: 403 }));
    await expect(operation).rejects.toEqual(
      expect.objectContaining<Partial<DirectUploadError>>({
        name: "DirectUploadError",
        status: 403,
      }),
    );
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  it("resolves only after all successful PUTs and reports every settlement", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const progress: Array<[number, number]> = [];

    await expect(putSignedObjects(
      [signedObject("https://r2.example/first"), signedObject("https://r2.example/second")],
      (settled, total) => progress.push([settled, total]),
    )).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });
});

describe("recognizable authorization upload IDs", () => {
  it("retains every valid response ID available for best-effort cleanup", () => {
    expect(recognizableAuthorizedUploadIds({
      uploads: [
        { uploadId: UPLOAD_A, main: null },
        { uploadId: "not-a-uuid" },
        null,
        { uploadId: UPLOAD_B },
      ],
    })).toEqual([UPLOAD_A, UPLOAD_B]);
  });
});
