import { describe, expect, it } from "vitest";
import {
  PasskeyFlowError,
  encodePasskeyUserHandle,
  hashWebAuthnChallenge,
  isPasskeyAccountStatusAllowed,
  isWebAuthnChallengeUsable,
  parsePasskeyTransports,
  passkeyUserHandleMatches,
  resolveWebAuthnConfig,
  storedPasskeyPublicKey,
  webAuthnChallengeMatches,
} from "@/worker/auth/passkeys";

describe("passkey security helpers", () => {
  it("derives an exact origin and RP ID and rejects insecure production origins", () => {
    expect(
      resolveWebAuthnConfig({
        APP_ORIGIN: "https://Forum.Example.com:8443/",
        ENVIRONMENT: "production",
      }),
    ).toEqual({
      origin: "https://forum.example.com:8443",
      rpID: "forum.example.com",
      rpName: "CForum",
    });

    expect(() =>
      resolveWebAuthnConfig({
        APP_ORIGIN: "http://forum.example.com",
        ENVIRONMENT: "production",
      }),
    ).toThrow(PasskeyFlowError);
    expect(() =>
      resolveWebAuthnConfig({
        APP_ORIGIN: "https://forum.example.com/a-path",
        ENVIRONMENT: "production",
      }),
    ).toThrow(PasskeyFlowError);
    expect(
      resolveWebAuthnConfig({
        APP_ORIGIN: "http://localhost:8787",
        ENVIRONMENT: "development",
      }).rpID,
    ).toBe("localhost");
  });

  it("binds the HMAC to challenge ID, purpose, user, and challenge", async () => {
    const secret = "challenge-secret".repeat(3);
    const input = {
      challengeId: crypto.randomUUID(),
      purpose: "registration" as const,
      userId: "user-1",
      challenge: "browser-challenge",
    };
    const hash = await hashWebAuthnChallenge(secret, input);

    await expect(webAuthnChallengeMatches(secret, hash, input)).resolves.toBe(true);
    await expect(
      webAuthnChallengeMatches(secret, hash, {
        ...input,
        purpose: "authentication",
      }),
    ).resolves.toBe(false);
    await expect(
      webAuthnChallengeMatches(secret, hash, {
        ...input,
        userId: "user-2",
      }),
    ).resolves.toBe(false);
    await expect(
      hashWebAuthnChallenge("short", input),
    ).rejects.toMatchObject({ kind: "misconfigured" });
  });

  it("accepts a challenge only before expiry and before consumption", () => {
    const challenge = {
      id: "challenge-1",
      user_id: null,
      purpose: "authentication" as const,
      challenge_hash: "hash",
      created_at: 100,
      expires_at: 400,
      consumed_at: null,
    };
    const expected = {
      id: "challenge-1",
      purpose: "authentication" as const,
      userId: null,
      now: 200,
    };
    expect(isWebAuthnChallengeUsable(challenge, expected)).toBe(true);
    expect(
      isWebAuthnChallengeUsable({ ...challenge, consumed_at: 150 }, expected),
    ).toBe(false);
    expect(
      isWebAuthnChallengeUsable(challenge, { ...expected, now: 400 }),
    ).toBe(false);
  });

  it("requires the discoverable user handle to match the credential owner", () => {
    expect(encodePasskeyUserHandle("user-1")).toBe("dXNlci0x");
    expect(passkeyUserHandleMatches("dXNlci0x", "user-1")).toBe(true);
    expect(passkeyUserHandleMatches(undefined, "user-1")).toBe(false);
    expect(passkeyUserHandleMatches("dXNlci0y", "user-1")).toBe(false);
  });

  it("allows active and silenced accounts only", () => {
    expect(isPasskeyAccountStatusAllowed("active")).toBe(true);
    expect(isPasskeyAccountStatusAllowed("silenced")).toBe(true);
    expect(isPasskeyAccountStatusAllowed("pending")).toBe(false);
    expect(isPasskeyAccountStatusAllowed("suspended")).toBe(false);
    expect(isPasskeyAccountStatusAllowed("deleted")).toBe(false);
  });

  it("normalizes stored transports and public-key blobs", () => {
    expect(
      parsePasskeyTransports('["internal","usb","internal","invalid"]'),
    ).toEqual(["internal", "usb"]);
    expect(parsePasskeyTransports("not-json")).toEqual([]);
    expect([...storedPasskeyPublicKey(new Uint8Array([1, 2, 3]).buffer)]).toEqual([
      1, 2, 3,
    ]);
    expect([...storedPasskeyPublicKey([4, 5, 6])]).toEqual([4, 5, 6]);
    expect(() => storedPasskeyPublicKey([256])).toThrow(PasskeyFlowError);
  });
});
