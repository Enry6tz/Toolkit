import type { KnowledgeBundle, ToolbarMode } from '../core/types.js';

export interface ToolbarDocument {
  routes?: readonly string[];
  id: string;
  path: string;
  label: string;
  /** Defaults to true. Only missing optional files are skipped. */
  required?: boolean;
  /** Omitted means all case modes. */
  modes?: readonly ToolbarMode[];
}

/** An integrator-named rule backed by an explicitly published Markdown file. */
export interface ToolbarRule {
  routes?: readonly string[];
  id: string;
  title: string;
  path: string;
  modes?: readonly ToolbarMode[];
}

export interface ToolbarConfig {
  /** Optional wiki references, separate from bundled internal Markdown. */
  wiki?: import('../core/types.js').ToolbarWiki;
  liveConfig?: import('../core/runtime-config.js').ToolbarLiveConfig;
  /** Product UI and generated Markdown. Project documents retain their own language. Defaults to English. */
  locale?: import('../core/locale.js').ToolbarLocale;
  enabled?: { development?: boolean; preview?: boolean; production?: boolean };
  /** Same-origin application route hosting AIContextDocumentEditor. */
  documentsPath?: string;
  rules?: readonly ToolbarRule[];
  context?: {
    documents?: readonly ToolbarDocument[];
    /** Defaults to 64 KiB and cannot exceed that cap. */
    maxDocumentBytes?: number;
    /** Defaults to 256 KiB and cannot exceed that cap. */
    maxTotalBytes?: number;
  };
}

export interface BundleKnowledgeOptions { rootDir: string }

export interface WriteKnowledgeOptions {
  rootDir: string;
  /** Relative JSON path inside .ai-toolbar; defaults to .ai-toolbar/knowledge.json. */
  output?: string;
}

export interface NextKnowledgeOptions {
  rootDir?: string;
  output?: string;
}

export type { BundledDocument, KnowledgeBundle } from '../core/types.js';
export type KnowledgeBuilder = (config: ToolbarConfig, options: BundleKnowledgeOptions) => Promise<KnowledgeBundle>;
