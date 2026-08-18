import { describe, expect, it } from "vitest";
import { shouldDismissDialogOnEscape } from "@/client/dialogDismissal";
import {
  MAX_AVATAR_EDGE,
  MAX_AVATAR_THUMBNAIL_BYTES,
} from "@/client/imageOptimization";

describe("profile dialog dismissal", () => {
  it("keeps an in-flight avatar operation mounted when Escape is pressed", () => {
    expect(shouldDismissDialogOnEscape("profile", true)).toBe(false);
    expect(shouldDismissDialogOnEscape("profile", false)).toBe(true);
    expect(shouldDismissDialogOnEscape("login", true)).toBe(true);
  });

  it("keeps client avatar output within the server binding envelope", () => {
    expect(MAX_AVATAR_EDGE).toBe(256);
    expect(MAX_AVATAR_THUMBNAIL_BYTES).toBe(128 * 1024);
  });
});
