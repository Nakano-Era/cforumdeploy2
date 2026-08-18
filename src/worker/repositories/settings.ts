import type { PublicSiteConfig, RegistrationMode } from "@/shared/domain";
import type { Bindings } from "@/worker/env";

type SettingRow = { key: string; value_json: string };

export async function isMaintenanceModeEnabled(
  database: D1Database,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT value_json
       FROM site_settings
       WHERE key = 'maintenance_mode'
       LIMIT 1`,
    )
    .first<Pick<SettingRow, "value_json">>();

  if (!row) return false;
  return JSON.parse(row.value_json) === true;
}

export async function getPublicSiteConfig(
  env: Bindings,
): Promise<PublicSiteConfig> {
  const result = await env.CFORUM_DB.prepare(
    `SELECT key, value_json
     FROM site_settings
     WHERE key IN (
       'site_name',
       'site_description',
       'registration_mode',
       'registration_frozen',
       'maintenance_mode'
     )`,
  ).all<SettingRow>();
  const values = new Map(
    result.results.map((row) => [row.key, JSON.parse(row.value_json) as unknown]),
  );

  return {
    siteName: String(values.get("site_name") ?? "CForum"),
    siteDescription: String(values.get("site_description") ?? "认真交流的地方"),
    registrationMode: (values.get("registration_mode") ??
      "approval") as RegistrationMode,
    registrationFrozen: Boolean(values.get("registration_frozen")),
    maintenanceMode: Boolean(values.get("maintenance_mode")),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
  };
}
