import type { ActivityBody, ActivityNetworkSimulation } from '../core/activity.js';
import type { RecordedContext } from '../core/types.js';

export type EvidenceStatus = 'available' | 'missing' | 'failed' | 'excluded';
export type Provenance = 'observed' | 'declared' | 'inferred';
export type ReviewActor = 'user' | 'agent' | 'unknown';
export type ReviewAttribution = 'declared' | 'verified' | 'unknown';
export type CaptureKind = 'viewport' | 'fullPage' | 'region';
export type ReviewErrorCode = 'INVALID_INPUT' | 'CAPABILITY_UNAVAILABLE' | 'SESSION_NOT_ACTIVE'
  | 'SESSION_ALREADY_ACTIVE' | 'SESSION_NOT_FOUND' | 'RECORDING_NOT_AUTHORIZED' | 'STALE_TARGET'
  | 'STALE_CAPTURE' | 'ARTIFACT_NOT_FOUND' | 'BINARY_TRANSPORT_UNAVAILABLE'
  | 'PRIVACY_REVIEW_REQUIRED' | 'LIMIT_REACHED' | 'REVISION_CONFLICT' | 'REFERENCE_NOT_FOUND';

export interface ReviewError { code: ReviewErrorCode; message: string }
export type ReviewResult<T = undefined> =
  | { status: 'ok'; sessionId?: string; revision: number; data: T }
  | { status: 'error'; sessionId?: string; revision: number; error: ReviewError };

export type CapabilityName = 'contextRead' | 'siteTools' | 'sessionSignals' | 'interactionRecording'
  | 'captureViewport' | 'captureFullPage' | 'captureRegion' | 'artifactRead' | 'bundleExport'
  | 'domainContext' | 'designContext';
export interface ReviewCapability {
  status: 'supported' | 'unavailable' | 'denied';
  provider: string;
  reason?: string;
}
export type ReviewCapabilities = Record<CapabilityName, ReviewCapability>;

export interface ReviewScope { origin: string; pathname: string; targetId?: string }
export interface ReviewSession {
  /** Published references from pages visited while recording, frozen with the walkthrough. */
  documents?: import('../core/types.js').KnowledgeBundle;
  context?: RecordedContext;
  id: string;
  objective: string;
  notes?: string;
  /** Last network collection setting; changes during a recording are explicit steps. */
  networkRecording?: boolean;
  scope: ReviewScope;
  actor: ReviewActor;
  attribution: ReviewAttribution;
  status: 'active' | 'ended';
  recording: 'off' | 'active' | 'stopped';
  startedAt: string;
  lastActivityAt: string;
  endedAt?: string;
  revision: number;
}
export interface ReviewStep {
  context?: RecordedContext;
  id: string;
  sessionId: string;
  label: string;
  at: string;
  pathname: string;
  targetId?: string;
  actor: ReviewActor;
  attribution: ReviewAttribution;
  simulated: boolean;
  artifactIds: string[];
  notes: string;
  /** Automatic recording lifecycle marker; user checkpoint labels never imply this value. */
  recordingBoundary?: 'start' | 'stop';
}
export interface ReviewEvent {
  context?: RecordedContext;
  id: string;
  sessionId: string;
  at: string;
  kind: 'interaction' | 'fetch';
  actor: ReviewActor;
  attribution: ReviewAttribution;
  simulated: boolean;
  label?: string;
  resource?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'OTHER';
  status?: number | null;
  outcome?: 'pending' | 'success' | 'http_error' | 'network_error' | 'aborted' | 'incomplete';
  durationMs?: number | null;
  stepId?: string;
  correlation?: 'temporal' | 'explicit';
  requestBody?: ActivityBody;
  responseBody?: ActivityBody;
  simulation?: Exclude<ActivityNetworkSimulation, 'normal'>;
}
export interface EvidenceCapture {
  kind: CaptureKind;
  provider: string;
  viewport: { width: number; height: number; dpr: number };
  toolbarHidden?: boolean;
}
export interface EvidenceArtifact {
  id: string;
  sessionId: string;
  stepId?: string;
  capturedAt: string;
  pathname: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  status: EvidenceStatus;
  byteLength?: number;
  sha256?: string;
  capture?: EvidenceCapture;
  redactionStatus: 'applied' | 'notRequired' | 'disabled' | 'failed';
  retrieval?: { method: 'tool' | 'download'; reference: string };
  simulated: boolean;
  notes: string;
  failureReason?: string;
}
export interface Finding {
  id: string;
  sessionId: string;
  title: string;
  type: 'bug' | 'feature' | 'observation';
  expected?: { text: string; provenance: Provenance; sourceId?: string };
  observed: string;
  stepIds: string[];
  artifactIds: string[];
  simulated: boolean;
  reproducibility: 'notChecked' | 'reproduced' | 'notReproduced';
  hypothesis?: string;
  missingInformation: string[];
}
export interface ReviewLimits { maxEvents: number; maxImages: number; maxBytes: number }
export type ReviewCaseMode = 'test' | 'design' | 'report';
export interface ReviewCaseOriginal {
  title: string;
  detail: string;
  steps: string[];
  expected: string;
  additionalContext: string;
}
export interface ReviewRefinement {
  id: string;
  basedOnRevision: number;
  title: string;
  steps: string[];
  expected: string;
  summary: string;
  details: string;
  sourceDocIds: string[];
  createdAt: string;
}
/** One bounded task. Refinement changes wording; it never proves execution. */
export interface ReviewCase {
  id: string;
  mode: ReviewCaseMode;
  status: 'draft' | 'prepared' | 'proposed' | 'approved';
  original: ReviewCaseOriginal;
  preparedRevision?: number;
  /** Last wording is retained as history in draft/prepared; only proposed/approved is current. */
  proposal?: ReviewRefinement;
  approvedProposalId?: string;
}
export interface ReviewSnapshot {
  schemaVersion: '2.0';
  revision: number;
  session: ReviewSession | null;
  case?: ReviewCase;
  steps: ReviewStep[];
  events: ReviewEvent[];
  findings: Finding[];
  artifacts: EvidenceArtifact[];
  privacy: { reviewedRevision: number | null };
  partial: { isPartial: boolean; reasons: string[]; droppedEvents: number };
  limits: ReviewLimits;
  bytesStored: number;
}
export interface ReviewMutation { requestId: string; sessionId?: string; expectedRevision?: number }
export interface StartSessionInput extends ReviewMutation {
  objective: string;
  scope: ReviewScope;
  actor?: ReviewActor;
  attribution?: ReviewAttribution;
}
export interface StartCaseInput extends ReviewMutation, Partial<ReviewCaseOriginal> {
  mode: ReviewCaseMode;
  title: string;
  scope: ReviewScope;
}
export interface CaseMutation extends ReviewMutation { caseId: string; expectedRevision: number }
export interface UpdateCaseInput extends CaseMutation, Partial<ReviewCaseOriginal> {}
export interface SubmitRefinementInput extends CaseMutation {
  proposal: Pick<ReviewRefinement, 'title' | 'steps' | 'expected'> & Partial<Pick<ReviewRefinement, 'summary' | 'details' | 'sourceDocIds'>>;
}
export interface ApproveRefinementInput extends CaseMutation { proposalId: string }
export interface StartRecordingInput extends ReviewMutation {
  /** Explicit authorization from the caller's user interaction or authorized task. */
  authorized: boolean;
  scope?: ReviewScope;
}
export interface CheckpointInput extends ReviewMutation {
  label: string;
  pathname: string;
  targetId?: string;
  actor?: ReviewActor;
  attribution?: ReviewAttribution;
  simulated?: boolean;
  notes?: string;
  /** Explicit lifecycle metadata for automatic recording checkpoints. */
  recordingBoundary?: 'start' | 'stop';
}
export interface RemoveStepInput extends ReviewMutation { stepId: string }
export interface RemovedStep { stepId: string; eventIds: string[]; artifactIds: string[] }
export interface AddArtifactInput extends ReviewMutation {
  stepId?: string;
  /** Only already-redacted real image bytes; no original is retained by the engine. */
  bytes?: Uint8Array;
  mimeType: EvidenceArtifact['mimeType'];
  capturedAt: string;
  pathname: string;
  capture?: EvidenceCapture;
  status?: 'available' | 'failed' | 'missing';
  redactionStatus: EvidenceArtifact['redactionStatus'];
  simulated?: boolean;
  failureReason?: string;
}
export interface RecordEventInput extends ReviewMutation {
  kind: ReviewEvent['kind'];
  at?: string;
  actor?: ReviewActor;
  attribution?: ReviewAttribution;
  simulated?: boolean;
  label?: string;
  resource?: string;
  method?: string;
  status?: number | null;
  outcome?: ReviewEvent['outcome'];
  durationMs?: number | null;
  stepId?: string;
  correlation?: 'temporal' | 'explicit';
  requestBody?: ActivityBody;
  responseBody?: ActivityBody;
  simulation?: Exclude<ActivityNetworkSimulation, 'normal'>;
}
export interface UpdateRecordingInput extends ReviewMutation { title?: string; notes?: string; networkRecording?: boolean }
export interface UpdateNetworkEventInput extends ReviewMutation, Pick<RecordEventInput, 'status' | 'outcome' | 'durationMs' | 'requestBody' | 'responseBody'> { eventId: string }
export interface AddFindingInput extends ReviewMutation {
  /** Required for both new findings and updates so edits never overwrite newer review work. */
  expectedRevision: number;
  id?: string;
  title: string;
  type: Finding['type'];
  expected?: Finding['expected'];
  observed: string;
  stepIds: string[];
  artifactIds: string[];
  simulated?: boolean;
  reproducibility?: Finding['reproducibility'];
  hypothesis?: string;
  missingInformation?: string[];
}
export interface EvidenceExclusionInput extends ReviewMutation { artifactId: string; excluded: boolean }
export interface UpdateNotesInput extends ReviewMutation { artifactId?: string; stepId?: string; notes: string }
export interface ReviewPrivacyInput extends ReviewMutation { expectedRevision: number; confirmed: boolean }
export interface FrozenReview {
  snapshot: ReviewSnapshot;
  /** A copy from the frozen revision, by opaque ID only. Excluded files are unavailable here. */
  readArtifact(id: string): Uint8Array | null;
}
/** Durable local evidence only. Browser permissions and transport state never belong here. */
export interface ReviewDraftFile {
  id: string;
  bytes: Uint8Array;
  mimeType: EvidenceArtifact['mimeType'];
  filename: string;
}
export interface ReviewDraft {
  snapshot: ReviewSnapshot;
  files: ReviewDraftFile[];
  /** Preserves reversible exclusions, including excluded failed capture attempts. */
  excludedStatuses?: Array<{ id: string; status: 'available' | 'failed' | 'missing' }>;
}
export interface ReviewDraftOperationOptions {
  signal?: AbortSignal;
  /** Rechecked before publishing an async restore or committing local storage. */
  isCurrent?: () => boolean;
}
export interface ReviewEngineOptions {
  getDocuments?: () => import('../core/types.js').KnowledgeBundle | undefined;
  observe?: () => RecordedContext | undefined;
  locale?: import('../core/locale.js').ToolbarLocale | (() => import('../core/locale.js').ToolbarLocale);
  limits?: Partial<ReviewLimits>;
  now?: () => Date;
  id?: (kind: 'session' | 'step' | 'event' | 'artifact' | 'finding') => string;
  onChange?: (snapshot: ReviewSnapshot) => void;
}
export interface ReviewEngine {
  getSnapshot(): ReviewSnapshot;
  exportDraft(): ReviewDraft;
  restoreDraft(draft: ReviewDraft, options?: ReviewDraftOperationOptions): Promise<ReviewResult<ReviewSnapshot>>;
  startSession(input: StartSessionInput): ReviewResult<ReviewSession>;
  updateRecording(input: UpdateRecordingInput): ReviewResult<ReviewSession>;
  updateNetworkEvent(input: UpdateNetworkEventInput): ReviewResult<ReviewEvent>;
  startCase(input: StartCaseInput): ReviewResult<ReviewCase>;
  updateCase(input: UpdateCaseInput): ReviewResult<ReviewCase>;
  prepareCase(input: CaseMutation): ReviewResult<ReviewCase>;
  submitRefinement(input: SubmitRefinementInput): ReviewResult<ReviewCase>;
  approveRefinement(input: ApproveRefinementInput): ReviewResult<ReviewCase>;
  startRecording(input: StartRecordingInput): ReviewResult<ReviewSession>;
  stopRecording(input: ReviewMutation): ReviewResult<ReviewSession>;
  endSession(input: ReviewMutation): ReviewResult<ReviewSession>;
  checkpoint(input: CheckpointInput): ReviewResult<ReviewStep>;
  removeStep(input: RemoveStepInput): ReviewResult<RemovedStep>;
  recordEvent(input: RecordEventInput): ReviewResult<ReviewEvent>;
  addArtifact(input: AddArtifactInput): Promise<ReviewResult<EvidenceArtifact>>;
  addFinding(input: AddFindingInput): ReviewResult<Finding>;
  setEvidenceExcluded(input: EvidenceExclusionInput): ReviewResult<EvidenceArtifact>;
  updateNotes(input: UpdateNotesInput): ReviewResult<EvidenceArtifact | ReviewStep>;
  reviewPrivacy(input: ReviewPrivacyInput): ReviewResult<ReviewSnapshot>;
  readArtifact(id: string): Uint8Array | null;
  freezeForExport(input: { expectedRevision: number }): ReviewResult<FrozenReview>;
  /** Called by the browser controller on route/selection changes; it never starts collection. */
  updateLocation(scope: ReviewScope): void;
  /** Marks a changed public context or design declaration as a new package revision. */
  invalidateContext(): void;
}
