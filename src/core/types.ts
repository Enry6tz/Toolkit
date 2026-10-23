export type ToolbarMode = 'test' | 'design' | 'report';

export interface BuildInfo {
  environment: 'development' | 'preview' | 'production';
  branch?: string;
  buildId?: string;
}

export interface RecordedContext {
  capturedAt: string;
  appName?: string;
  url: string;
  publicQueryParams?: readonly string[];
  build: BuildInfo;
  viewport: { width: number; height: number };
}

export interface ElementContext {
  tag: string;
  role: string | null;
  accessibleName: string;
  selector: string | null;
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  component?: string;
  source?: string;
  styles?: Record<string, string>;
  control?: { type: string; disabled: boolean; readOnly: boolean; required: boolean; invalid: boolean };
  container?: { tag: string; name: string };
  locator?: { strategy: 'published' | 'testId' | 'id' | 'attribute' | 'semantic'; value: string; matches: number; confidence: 'unique' | 'ambiguous' | 'unavailable' };
}

/** Public observation, independent of live DOM nodes and capture permissions. */
export interface AnnotationContext {
  id: string;
  /** A mark created inside an explicit case is not reused by another case. */
  caseId?: string;
  /** An unfinished note is visible locally but excluded from the prepared handoff. */
  pending?: boolean;
  /** Stable presentation color for the mark and its controls. */
  color?: string;
  kind: 'element' | 'section' | 'area' | 'group';
  /** Total concrete elements selected by a drag; relatedElements contains up to 200 members. */
  elementCount?: number;
  context?: RecordedContext;
  pathname: string;
  createdAt: string;
  updatedAt: string;
  label: string;
  note: string;
  /** Document CSS coordinates at selection time; never screenshot pixels. */
  bounds: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  element: ElementContext | null;
  relatedElements: ElementContext[];
}

/** Explicitly published project documentation, frozen into a deployment. */
export interface BundledDocument {
  /** Omitted: general. Exact paths or a terminal /** include descendants. */
  routes?: readonly string[];
  id: string;
  label: string;
  content: string;
  /** SHA-256 of the exact UTF-8 content, computed by the Node build helper. */
  checksum: string;
  /** Omitted means this public document applies to every case mode. */
  modes?: readonly ToolbarMode[];
}

export interface KnowledgeBundle {
  schemaVersion: '1.0';
  documents: readonly BundledDocument[];
}

/** References open in the wiki; their contents are not bundled into the application. */
export interface WikiDocumentLink {
  label: string;
  url: string;
  /** Omitted means general; exact application paths or a terminal /** are supported. */
  routes?: readonly string[];
  excludedRoutes?: readonly string[];
}

export interface ToolbarWiki {
  /** General wiki, book or project URL. Document links must share this origin. */
  url: string;
  documents?: readonly WikiDocumentLink[];
  /** Credentialed wiki-session endpoint for optional page association controls. */
  manageUrl?: string;
}

export interface ContextSnapshot {
  schemaVersion: '1.0';
  capturedAt: string;
  page: {
    url: string;
    pathname: string;
    /** Explicit public functional query keys; all others are excluded from URL. */
    publicQueryParams?: readonly string[];
    title: string;
    viewport: { width: number; height: number };
  };
  build: BuildInfo;
  target: ElementContext | null;
  rules: readonly string[];
  privacy: { redactions: readonly string[] };
  knowledge?: KnowledgeBundle;
  activity?: readonly ActivityEntry[];
  annotations?: readonly AnnotationContext[];
  activeAnnotationId?: string;
}

export interface WorkInput {
  mode: ToolbarMode;
  title: string;
  detail: string;
  extra?: string;
  priority?: 'low' | 'medium' | 'high';
}

export type ArtifactKind = 'test-plan' | 'design-brief' | 'issue';

export interface ContextArtifactJson {
  schemaVersion: '1.0';
  id: string;
  kind: ArtifactKind;
  title: string;
  createdAt: string;
  input: WorkInput;
  context: ContextSnapshot;
  executionStatus: 'not_run' | 'not_applicable';
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  markdown: string;
  json: ContextArtifactJson;
}

export interface ToolbarEnvironmentOptions {
  environment: BuildInfo['environment'];
  enabled?: boolean;
  allowProduction?: boolean;
  branch?: string;
  branches?: readonly string[];
}
import type { ActivityEntry } from './activity.js';

