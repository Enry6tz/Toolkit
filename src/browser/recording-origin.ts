interface RecordingOrigin { sessionId: string; recordingId: string; manageUrl: string }
const key = "ai-context-toolbar:recording-origins:v1";
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function origins(view: Window): RecordingOrigin[] {
  try {
    const raw = view.localStorage.getItem(key);
    if (!raw || raw.length > 200_000) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.slice(-200).filter((entry: unknown): entry is RecordingOrigin => {
      if (!entry || typeof entry !== "object") return false;
      return "sessionId" in entry && typeof entry.sessionId === "string" && entry.sessionId.length < 200
        && "recordingId" in entry && typeof entry.recordingId === "string" && uuid.test(entry.recordingId)
        && "manageUrl" in entry && typeof entry.manageUrl === "string" && entry.manageUrl.length < 2048;
    });
  } catch { return []; }
}
/** Only references are cached. Creator names are read from the authenticated server. */
export function rememberRecordingOrigin(view: Window, origin: RecordingOrigin): void {
  try { view.localStorage.setItem(key, JSON.stringify([...origins(view).filter(value => value.sessionId !== origin.sessionId), origin].slice(-200))); }
  catch { /* Local reference storage is optional. */ }
  view.dispatchEvent(new Event("ai-context-toolbar:recording-origin"));
}
export function recordingOrigin(view: Window, sessionId: string, manageUrl: string): RecordingOrigin | undefined {
  return origins(view).find(value => value.sessionId === sessionId && value.manageUrl === manageUrl);
}
