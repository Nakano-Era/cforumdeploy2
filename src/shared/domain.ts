export const TRUST_LEVELS = [0, 1, 2, 3, 4] as const;

export type TrustLevel = (typeof TRUST_LEVELS)[number];
export type UserRole = "member" | "moderator" | "admin";
export type UserStatus =
  | "pending"
  | "active"
  | "silenced"
  | "suspended"
  | "deleted";

export type RegistrationMode = "open" | "approval" | "invite_only";

export interface PublicSiteConfig {
  siteName: string;
  siteDescription: string;
  registrationMode: RegistrationMode;
  registrationFrozen: boolean;
  maintenanceMode: boolean;
  turnstileSiteKey: string | null;
}

export interface FeedTopicSummary {
  id: string;
  title: string;
  excerpt: string;
  category: {
    id: string;
    name: string;
    color: string;
  };
  tags: string[];
  author: {
    id: string;
    username: string;
    displayName: string;
  };
  minViewLevel: TrustLevel;
  replyCount: number;
  likeCount: number;
  bumpedAt: string;
  pinned: boolean;
  locked: boolean;
  unreadPosts: number;
  thumbnailUrl: string | null;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
