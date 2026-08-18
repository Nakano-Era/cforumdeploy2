import { z } from "zod";
import type { Bindings } from "@/worker/env";

export const EMAIL_REQUEST_TURNSTILE_ACTION = "email_request_code";
const SITEVERIFY_ENDPOINT =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  action: z.string().optional(),
  hostname: z.string().optional(),
});

export interface VerifyTurnstileInput {
  token: string;
  expectedAction: string;
  remoteIp?: string;
  fetcher?: typeof fetch;
}

export function expectedTurnstileHostname(appOrigin: string): string | null {
  try {
    const url = new URL(appOrigin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** Fail-closed Siteverify validation. Never logs the token or secret. */
export async function verifyTurnstileToken(
  env: Pick<Bindings, "APP_ORIGIN" | "TURNSTILE_SECRET">,
  input: VerifyTurnstileInput,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET?.trim();
  const expectedHostname = expectedTurnstileHostname(env.APP_ORIGIN);
  const token = input.token.trim();
  if (
    !secret ||
    !expectedHostname ||
    token.length === 0 ||
    token.length > 2048
  ) {
    return false;
  }

  const body = new URLSearchParams({ secret, response: token });
  if (input.remoteIp) body.set("remoteip", input.remoteIp);

  try {
    const response = await (input.fetcher ?? fetch)(SITEVERIFY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;

    const parsed = siteverifyResponseSchema.safeParse(await response.json());
    if (!parsed.success || !parsed.data.success) return false;
    const hostname = parsed.data.hostname?.toLowerCase().replace(/\.$/, "");
    return (
      parsed.data.action === input.expectedAction &&
      hostname === expectedHostname
    );
  } catch {
    return false;
  }
}
