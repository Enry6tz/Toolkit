import { fetchOutsideRecording } from './activity.js';

export interface WikiRecordingSummary {
  id: string;
  title: string;
  author: string | null;
  updatedAt: string;
}

export class WikiRecordingError extends Error {
  constructor(public readonly code: 'auth' | 'forbidden' | 'unavailable' | 'invalid' | 'too-large') {
    super(`Wiki recording request failed: ${code}.`);
    this.name = 'WikiRecordingError';
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const listLimit = 512 * 1024;
const recordingLimit = 2 * 1024 * 1024;
// ASIDE permits300 characters when a collaborator renames a saved recording.
const recordingTitleLimit = 300;

function projectUrl(manageUrl: string): string {
  try {
    if (typeof manageUrl !== 'string' || manageUrl.length > 2048 || /[\\\u0000-\u0020]/.test(manageUrl)
      || !/^https?:\/\/[^/?#]+\/toolkit\/toolbar\/projects\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/?$/i.test(manageUrl)) throw new Error();
    const url = new URL(manageUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !/^\/toolkit\/toolbar\/projects\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/?$/.test(url.pathname)) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new WikiRecordingError('invalid'); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month! - 1] ?? 0;
  return day! >= 1 && day! <= days && hour! <= 23 && minute! <= 59 && second! <= 59;
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= max && !/[\u0000-\u001F\u007F]/.test(value);
}

async function readJson(view: Window, url: string, limit: number, signal: AbortSignal): Promise<{ source: string; value: unknown }> {
  signal.throwIfAborted();
  try {
    const response = await fetchOutsideRecording(view, url, {
      credentials: 'include', cache: 'no-store', redirect: 'error', signal, headers: { Accept: 'application/json' },
    });
    signal.throwIfAborted();
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new WikiRecordingError(response.status === 401 ? 'auth' : response.status === 403 ? 'forbidden' : 'unavailable');
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new WikiRecordingError('invalid');
    }
    const length = response.headers.get('content-length');
    if (length !== null && /^\d+$/.test(length) && Number(length) > limit) {
      void response.body.cancel().catch(() => undefined);
      throw new WikiRecordingError('too-large');
    }
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, source = '';
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limit) throw new WikiRecordingError('too-large');
        source += decoder.decode(chunk.value, { stream: true });
      }
      source += decoder.decode();
      try { return { source, value: JSON.parse(source) as unknown }; }
      catch { throw new WikiRecordingError('invalid'); }
    } catch (error) {
      if (error instanceof TypeError && !signal.aborted) throw new WikiRecordingError('invalid');
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WikiRecordingError) throw error;
    throw new WikiRecordingError('unavailable');
  }
}

/** Session-authenticated project recordings; URLs and extra fields supplied by the server are never reused. */
export async function listWikiRecordings(view: Window, manageUrl: string, signal: AbortSignal): Promise<WikiRecordingSummary[]> {
  const { value } = await readJson(view, `${projectUrl(manageUrl)}/recordings`, listLimit, signal);
  if (!object(value) || !Array.isArray(value.recordings) || value.recordings.length > 200) throw new WikiRecordingError('invalid');
  const seen = new Set<string>();
  return value.recordings.map((item: unknown) => {
    if (!object(item) || typeof item.id !== 'string' || !uuid.test(item.id) || seen.has(item.id.toLowerCase())
      || !text(item.title, recordingTitleLimit) || (item.fullTitle !== undefined && !text(item.fullTitle, recordingTitleLimit))
      || !(item.author === null || text(item.author, 255)) || !isoDate(item.updatedAt)) throw new WikiRecordingError('invalid');
    seen.add(item.id.toLowerCase());
    // Keep the legacy wire title bounded for older installed toolbars; newer readers retain renamed titles.
    return { id: item.id, title: typeof item.fullTitle === 'string' ? item.fullTitle : item.title, author: item.author, updatedAt: item.updatedAt };
  });
}

/** Returns bounded JSON for the existing recording importer; this never executes the recorded actions. */
export async function readWikiRecording(view: Window, manageUrl: string, id: string, signal: AbortSignal): Promise<string> {
  const url = projectUrl(manageUrl);
  if (typeof id !== 'string' || !uuid.test(id)) throw new WikiRecordingError('invalid');
  const { source, value } = await readJson(view, `${url}/recordings/${id}`, recordingLimit, signal);
  if (!object(value)) throw new WikiRecordingError('invalid');
  return source;
}
