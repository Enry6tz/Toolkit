import { AIToolbar as ClientToolbar } from '../react/index.js';
import type { AIToolbarProps } from '../react/index.js';
import type { ToolbarConfig } from '../config/types.js';
import type { ReviewOptions } from '../review/controller.js';

declare const process: { env: Record<string, string | undefined> };

/** Server component adapter: production stays off unless explicitly opted in. */
export interface NextAIToolbarProps extends Omit<AIToolbarProps, 'loadKnowledge' | 'review'> {
  /** Server-only configuration. Only environment flags are forwarded to the client. */
  config?: Pick<ToolbarConfig, 'enabled' | 'documentsPath' | 'locale' | 'wiki' | 'liveConfig'>;
  /** Serializable public declarations; custom capture providers belong in a client component. */
  review?: Omit<ReviewOptions, 'captureProvider'>;
}

export function AIToolbar({ config, ...props }: NextAIToolbarProps) {
  const environment = props.environment ?? (process.env.VERCEL_ENV === 'preview' ? 'preview' : process.env.NODE_ENV === 'development' ? 'development' : 'production');
  const configured = config?.enabled?.[environment];
  const documentsPath = props.documentsPath ?? config?.documentsPath;
  const locale = props.locale ?? config?.locale ?? 'en';
  const wiki = props.wiki ?? config?.wiki;
  const liveConfig = props.liveConfig ?? config?.liveConfig;
  return <ClientToolbar {...props} environment={environment}
    locale={locale}
    {...(wiki !== undefined ? { wiki } : {})}
    {...(liveConfig !== undefined ? { liveConfig } : {})}
    {...(documentsPath !== undefined ? { documentsPath } : {})}
    {...(props.enabled !== undefined || configured !== undefined ? { enabled: props.enabled ?? configured! } : {})}
    {...(props.allowProduction !== undefined || config?.enabled?.production !== undefined ? { allowProduction: props.allowProduction ?? config?.enabled?.production === true } : {})} />;
}
export type { AIToolbarProps } from '../react/index.js';
