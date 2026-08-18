export type ModalDialog = "login" | "compose" | "profile" | "report";

export function shouldDismissDialogOnEscape(
  dialog: ModalDialog,
  profileBusy: boolean,
): boolean {
  if (dialog === "compose") return false;
  if (dialog === "profile" && profileBusy) return false;
  return true;
}
