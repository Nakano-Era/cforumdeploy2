import type { TrustLevel } from "@/shared/domain";
import { dailyUploadLimitBytes } from "@/worker/media/constants";

export interface MediaQuotaSnapshot {
  dailyUsedBytes: number;
  activeUserReservedBytes: number;
  storedBytes: number;
  activeSiteReservedBytes: number;
  softLimitBytes: number;
  hardLimitBytes: number;
}

export type QuotaDecision =
  | {
      allowed: true;
      dailyLimitBytes: number;
      dailyRemainingBytes: number;
      siteRemainingBytes: number;
      capacityWarning: boolean;
    }
  | {
      allowed: false;
      reason: "daily_limit" | "site_hard_limit";
      dailyLimitBytes: number;
      capacityWarning: boolean;
    };

function safeNonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function evaluateMediaQuota(
  trustLevel: TrustLevel,
  requestedBytes: number,
  snapshot: MediaQuotaSnapshot,
): QuotaDecision {
  const storedBytes = safeNonNegativeInteger(snapshot.storedBytes);
  const activeSiteReservedBytes = safeNonNegativeInteger(
    snapshot.activeSiteReservedBytes,
  );
  const softLimitBytes = safeNonNegativeInteger(snapshot.softLimitBytes);
  const hardLimitBytes = safeNonNegativeInteger(snapshot.hardLimitBytes);
  const siteUsedAndReserved = storedBytes + activeSiteReservedBytes;
  const projectedSiteBytes = siteUsedAndReserved + requestedBytes;
  const atSoftLimit = siteUsedAndReserved >= softLimitBytes;
  const capacityWarning = projectedSiteBytes >= softLimitBytes;
  const baseDailyLimit = dailyUploadLimitBytes(trustLevel);
  const dailyLimitBytes = atSoftLimit
    ? Math.floor(baseDailyLimit / 2)
    : baseDailyLimit;

  if (
    !Number.isSafeInteger(requestedBytes) ||
    requestedBytes <= 0 ||
    hardLimitBytes <= 0 ||
    projectedSiteBytes > hardLimitBytes
  ) {
    return {
      allowed: false,
      reason: "site_hard_limit",
      dailyLimitBytes,
      capacityWarning,
    };
  }

  const dailyConsumed =
    safeNonNegativeInteger(snapshot.dailyUsedBytes) +
    safeNonNegativeInteger(snapshot.activeUserReservedBytes);
  if (dailyConsumed + requestedBytes > dailyLimitBytes) {
    return {
      allowed: false,
      reason: "daily_limit",
      dailyLimitBytes,
      capacityWarning,
    };
  }

  return {
    allowed: true,
    dailyLimitBytes,
    dailyRemainingBytes: dailyLimitBytes - dailyConsumed - requestedBytes,
    siteRemainingBytes: hardLimitBytes - projectedSiteBytes,
    capacityWarning,
  };
}
