// The app sends no usage analytics. track() stays as a no-op so call sites
// need no edits; nothing is collected or leaves the machine. The email entered
// during setup is stored locally in the profile and nowhere else.
export function track(_event: string, _props?: Record<string, unknown>) {}

// first-run email gate state
const GATE_KEY = "omb-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
