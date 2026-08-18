import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Hono } from "hono";
import { z } from "zod";
import {
  PasskeyFlowError,
  isPasskeyAccountStatusAllowed,
  issuePasskeyAuthenticationOptions,
  issuePasskeyRegistrationOptions,
  verifyAndPreparePasskeyAuthentication,
  verifyAndRegisterPasskey,
} from "@/worker/auth/passkeys";
import {
  setSessionCookies,
  type RequestIdentity,
} from "@/worker/auth/session";
import type { AppEnv } from "@/worker/env";

const base64UrlSchema = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[A-Za-z0-9_-]+$/);

const credentialIdSchema = base64UrlSchema(4_096);
const clientDataSchema = base64UrlSchema(16_384);
const extensionResultsSchema = z.record(z.string().max(128), z.unknown());
const authenticatorAttachmentSchema = z
  .enum(["platform", "cross-platform"])
  .optional();
const transportSchema = z.enum([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

const registrationResponseSchema = z.object({
  id: credentialIdSchema,
  rawId: credentialIdSchema,
  response: z.object({
    clientDataJSON: clientDataSchema,
    attestationObject: base64UrlSchema(131_072),
    authenticatorData: base64UrlSchema(16_384).optional(),
    transports: z.array(transportSchema).max(8).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64UrlSchema(32_768).optional(),
  }),
  authenticatorAttachment: authenticatorAttachmentSchema,
  clientExtensionResults: extensionResultsSchema,
  type: z.literal("public-key"),
});

const authenticationResponseSchema = z.object({
  id: credentialIdSchema,
  rawId: credentialIdSchema,
  response: z.object({
    clientDataJSON: clientDataSchema,
    authenticatorData: base64UrlSchema(16_384),
    signature: base64UrlSchema(16_384),
    userHandle: base64UrlSchema(512).nullable().optional(),
  }),
  authenticatorAttachment: authenticatorAttachmentSchema,
  clientExtensionResults: extensionResultsSchema,
  type: z.literal("public-key"),
});

const registerVerifySchema = z
  .object({
    challengeId: z.string().uuid(),
    response: registrationResponseSchema,
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const authenticateVerifySchema = z
  .object({
    challengeId: z.string().uuid(),
    response: authenticationResponseSchema,
  })
  .strict();

const router = new Hono<AppEnv>();

function identityFor(context: Parameters<typeof setSessionCookies>[0]) {
  return context.get("identity") as RequestIdentity | undefined;
}

function invalidInput(error: z.ZodError) {
  return {
    error: {
      code: "INVALID_INPUT",
      fields: error.flatten().fieldErrors,
    },
  };
}

router.post("/passkeys/register/options", async (context) => {
  const identity = identityFor(context);
  if (!identity?.session || !identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (!isPasskeyAccountStatusAllowed(identity.viewer.status)) {
    return context.json({ error: { code: "ACCOUNT_NOT_ELIGIBLE" } }, 403);
  }

  try {
    const result = await issuePasskeyRegistrationOptions(
      context.env,
      identity.viewer.userId,
    );
    return context.json(result);
  } catch (error) {
    if (error instanceof PasskeyFlowError && error.kind === "forbidden") {
      return context.json({ error: { code: "ACCOUNT_NOT_ELIGIBLE" } }, 403);
    }
    return context.json({ error: { code: "PASSKEY_SERVICE_UNAVAILABLE" } }, 503);
  }
});

router.post("/passkeys/register/verify", async (context) => {
  const identity = identityFor(context);
  if (!identity?.session || !identity.viewer.userId) {
    return context.json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
  }
  if (!isPasskeyAccountStatusAllowed(identity.viewer.status)) {
    return context.json({ error: { code: "ACCOUNT_NOT_ELIGIBLE" } }, 403);
  }
  const parsed = registerVerifySchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(invalidInput(parsed.error), 422);
  }

  try {
    const passkey = await verifyAndRegisterPasskey(context.env, {
      userId: identity.viewer.userId,
      challengeId: parsed.data.challengeId,
      response: parsed.data.response as RegistrationResponseJSON,
      label: parsed.data.label,
    });
    return context.json({ passkey }, 201);
  } catch (error) {
    if (error instanceof PasskeyFlowError) {
      if (error.kind === "forbidden") {
        return context.json({ error: { code: "ACCOUNT_NOT_ELIGIBLE" } }, 403);
      }
      if (error.kind === "invalid_challenge") {
        return context.json(
          { error: { code: "INVALID_OR_EXPIRED_PASSKEY_CHALLENGE" } },
          400,
        );
      }
      if (error.kind === "registration_failed") {
        return context.json({ error: { code: "PASSKEY_REGISTRATION_FAILED" } }, 400);
      }
    }
    return context.json({ error: { code: "PASSKEY_SERVICE_UNAVAILABLE" } }, 503);
  }
});

router.post("/passkeys/authenticate/options", async (context) => {
  try {
    const result = await issuePasskeyAuthenticationOptions(context.env);
    return context.json(result);
  } catch {
    return context.json({ error: { code: "PASSKEY_SERVICE_UNAVAILABLE" } }, 503);
  }
});

router.post("/passkeys/authenticate/verify", async (context) => {
  const parsed = authenticateVerifySchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json(invalidInput(parsed.error), 422);
  }
  const authenticationResponse = {
    ...parsed.data.response,
    response: {
      ...parsed.data.response.response,
      userHandle: parsed.data.response.response.userHandle ?? undefined,
    },
  } as AuthenticationResponseJSON;

  try {
    const result = await verifyAndPreparePasskeyAuthentication(context.env, {
      challengeId: parsed.data.challengeId,
      response: authenticationResponse,
    });
    setSessionCookies(context, result.preparedSession);
    return context.json({
      user: result.user,
      csrfToken: result.preparedSession.csrfToken,
    });
  } catch (error) {
    if (
      error instanceof PasskeyFlowError &&
      error.kind === "invalid_authentication"
    ) {
      return context.json(
        { error: { code: "INVALID_PASSKEY_AUTHENTICATION" } },
        401,
      );
    }
    return context.json({ error: { code: "PASSKEY_SERVICE_UNAVAILABLE" } }, 503);
  }
});

export default router;
