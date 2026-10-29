/** Installed by the workspace tab coordinator without introducing store import cycles. */
let admit: (workspaceId: string) => boolean = () => true;
export function setWorkspaceTabAdmission(check: (workspaceId: string) => boolean): void {
  admit = check;
}
export function canOpenWorkspaceTab(workspaceId: string): boolean {
  return admit(workspaceId);
}
