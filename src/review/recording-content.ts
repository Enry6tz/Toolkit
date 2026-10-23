import type { ReviewSnapshot } from './types.js';

/** Boundary metadata is explicit: matching user-written labels remain real content. */
export function hasRecordingContent(snapshot: ReviewSnapshot): boolean {
  return Boolean(snapshot.case || snapshot.steps.some(step => step.recordingBoundary === undefined)
    || snapshot.events.length || snapshot.findings.length || snapshot.artifacts.length);
}

/** Active drafts remain recoverable, but an empty finished recording has no saved entry. */
export function isEmptyStoppedRecording(snapshot: ReviewSnapshot): boolean {
  return snapshot.session?.recording === 'stopped' && !hasRecordingContent(snapshot);
}
