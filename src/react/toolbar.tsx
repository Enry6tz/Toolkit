'use client';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createAgentContext, isToolbarEnabled, sanitizePathname, validateKnowledgeBundle, validateWikiLinks } from '../core/index.js';
import type { AgentContext, AnnotationContext, BuildInfo, KnowledgeBundle, ToolbarWiki, ToolbarEnvironmentOptions } from '../core/index.js';
import type { ActivityConfig } from '../core/activity.js';
import { activityBodyReason } from '../core/activity-labels.js';
import { captureContext, installAgentBridge, installSelection, loadAnnotations, resolveAnnotation, saveAnnotations } from '../browser/index.js';
import type { SelectionResult } from '../browser/selection.js';
import { installAgentDomTransport } from '../browser/agent-transport.js';
import type { AgentDomTransport } from '../browser/agent-transport.js';
import { createReviewController } from '../review/controller.js';
import { sanitizeReviewText } from '../review/session.js';
import type { AgentContextV2, ReviewController, ReviewOptions } from '../review/controller.js';
import type { ReviewCaseMode, ReviewEvent } from '../review/types.js';
import { recordingMarkdown, recordingJson, isRecordingBoundary, recordingTitle } from '../review/recording.js';
import { RECORDING_JSON_MAX_CHARACTERS, RECORDING_IMPORT_NOTICE } from '../review/recording-import.js';
import { flightErrorDiagnostic, recordingResource, recordingSteps, routineFrameworkQuery } from '../review/recording-view.js';
import { createTranslator, dateLocale, resolveLocale, importNoticeIn } from '../core/locale.js';
import type { ToolbarLocale } from '../core/locale.js';
import { Icon } from './icons.js';
import { SelectionActions } from './selection-actions.js';
import { styles } from './styles.js';
import { selectionActionsStyles } from './selection-actions.styles.js';
import { caseStyles } from './case.styles.js';
import { ensureToolbarFont } from './font.js';
import { assignMarkColors, markColor, markStyle, nextMarkColor } from './mark-colors.js';
import { sanitizeRecordedContext, recordedRoute } from '../core/recorded-context.js';
import { documentMatchesRoute } from '../core/knowledge.js';
import { annotationPosition } from '../browser/selection.js';
import { visibleElementBounds, enclosingBounds } from '../browser/selection-geometry.js';
import type { SelectionBounds } from '../browser/selection.js';
import { watchRuntimeConfig } from '../browser/runtime-config.js';
import type { ToolbarLiveConfig, ToolbarRuntimeConfig } from '../core/runtime-config.js';
import { WikiDocuments } from './wiki-documents.js';
import { WikiRecordingSave } from './wiki-recording.js';
import { WikiRecordingPicker, wikiRecordingErrorMessage } from './wiki-recording-picker.js';
import { readWikiRecording } from '../browser/wiki-recordings.js';
import type { WikiRecordingSummary } from '../browser/wiki-recordings.js';
import { rememberRecordingOrigin } from '../browser/recording-origin.js';
import { WikiRecordingAuthor } from './wiki-recording-author.js';
import { RecordingQualityNotice } from './recording-quality.js';
import { useDockPlacement } from './use-dock-placement.js';
import type { DockCorner } from './dock-geometry.js';

export interface AIToolbarProps extends Omit<ToolbarEnvironmentOptions, 'environment'> {
  /** General and route-specific links that open their original wiki pages. */
  wiki?: ToolbarWiki;
  liveConfig?: ToolbarLiveConfig;
  locale?: ToolbarLocale;
  environment?: BuildInfo['environment']; buildId?: string; appName?: string;
  rules?: readonly string[]; knowledge?: KnowledgeBundle; loadKnowledge?: () => Promise<KnowledgeBundle>;
  activity?: ActivityConfig | false; review?: ReviewOptions; defaultOpen?: boolean; nonce?: string;
  publicQueryParams?: readonly string[];
  /** Optional focus boundary for dialog libraries. Defaults to the active native modal or body. */
  portalContainer?: HTMLElement | ShadowRoot | null;
  /** Same-origin route for the project's full document editor. */
  documentsPath?: string;
  /** Retained for SDK compatibility. Recordings use the common project documents. */
  contextByMode?: Partial<Record<ReviewCaseMode, { rules?: readonly string[]; knowledge?: KnowledgeBundle;
    domain?: ReviewOptions['domain'] | null; design?: ReviewOptions['design'] | null }>>;
}
type SavedRecording = { id: string; title: string; updatedAt: string; startedAt: string; sessionId?: string; stepCount: number; contentStepCount: number };
type RecordingController = ReviewController & { deleteSavedRecording(id: string): Promise<void>; readSavedRecording(id: string): Promise<AgentContextV2>; getNetworkRecording?(): boolean };
type Body = { status: 'captured' | 'truncated' | 'omitted'; text?: string; contentType?: string; charLimit: number; redacted?: true; reason?: string };
type ToolbarCorner = DockCorner;
const toolbarCorners: ReadonlyArray<{ value: ToolbarCorner; label: string }> = [
  { value: 'bottom-right', label: 'Abajo a la derecha' }, { value: 'bottom-left', label: 'Abajo a la izquierda' },
  { value: 'top-right', label: 'Arriba a la derecha' }, { value: 'top-left', label: 'Arriba a la izquierda' },
];

/** Disabled builds do not mount collectors or event listeners. */
export function AIToolbar(props: AIToolbarProps) {
  const [dismissed, dismiss] = useState(false);
  const environment = props.environment ?? 'production';
  return !dismissed && isToolbarEnabled({ ...props, environment }) ? <LiveToolbar {...props} environment={environment} onDismiss={() => dismiss(true)} /> : null;
}
function LiveToolbar(props: AIToolbarProps & { environment: BuildInfo['environment']; onDismiss(): void }) {
  const [remote, setRemote] = useState<ToolbarRuntimeConfig | null>(null);
  const source = props.liveConfig;
  useEffect(() => {
    setRemote(null);
    if (!source) return;
    try { return watchRuntimeConfig(window, source, setRemote); } catch { /* Keep the declared configuration if the endpoint is invalid. */ }
  }, [source?.url, source?.intervalMs]);
  const { wiki: declaredWiki, ...rest } = props;
  const wiki = remote ? remote.wiki : declaredWiki;
  return <MountedToolbar {...rest} {...(wiki ? { wiki } : {})} {...(remote ? { locale: remote.locale,
    activity: props.activity === false ? false : { ...(props.activity ?? { resources: [] }), maxBodyChars: remote.maxBodyChars, recordNetwork: remote.recordNetwork } } : {})} />;
}
function MountedToolbar(props: AIToolbarProps & { environment: BuildInfo['environment']; onDismiss(): void }) {
  const locale = resolveLocale(props.locale), t = createTranslator(locale);
  let wiki: ToolbarWiki | undefined, wikiError = '';
  try { wiki = validateWikiLinks(props.wiki); } catch { wikiError = t('Los enlaces de la wiki no son válidos. Revisá la configuración.'); }
  const [root, setRoot] = useState<ShadowRoot | null>(null), [open, setOpen] = useState(props.defaultOpen ?? false);
  const [view, setView] = useState<'recording' | 'documents' | 'import'>('recording');
  const [importText, setImportText] = useState('');
  const [importSource, setImportSource] = useState<'wiki' | 'json'>('wiki');
  const showWikiImport = importSource === 'wiki' && !!wiki?.manageUrl;
  const [fallbackFormat, setFallbackFormat] = useState('Markdown');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [context, setContext] = useState<AgentContextV2 | null>(null), [history, setHistory] = useState<SavedRecording[]>([]);
  const [fallback, setFallback] = useState('');
  const dockPreferenceKey = `ai-context:recording-dock:${props.appName ?? (typeof window === 'undefined' ? 'app' : window.location.host)}`.slice(0, 240);
  const [dockPreferences, setDockPreferences] = useState<{ pinned: boolean; corner: ToolbarCorner }>(() => {
    const defaults = { pinned: false, corner: 'bottom-right' as const };
    if (typeof window === 'undefined') return defaults;
    try {
      const saved = JSON.parse(window.localStorage.getItem(dockPreferenceKey) ?? 'null');
      return { pinned: saved?.pinned === true, corner: toolbarCorners.some(item => item.value === saved?.corner) ? saved.corner as ToolbarCorner : defaults.corner };
    } catch { return defaults; }
  });
  const [dockHover, setDockHover] = useState(false), [dockFocused, setDockFocused] = useState(false), [dockTouchOpen, setDockTouchOpen] = useState(false);
  const [positionMenuOpen, setPositionMenuOpen] = useState(false);
  const dock = useRef<HTMLDivElement>(null), positionMenu = useRef<HTMLDivElement>(null), positionTrigger = useRef<HTMLButtonElement>(null);
  const dockPointerFocus = useRef(false), dockTouchReveal = useRef(false), dockLeaveTimer = useRef<number | undefined>(undefined);
  const compactPreferenceKey = `ai-context:compact-recording:${props.appName ?? (typeof window === 'undefined' ? 'app' : window.location.host)}`.slice(0, 240);
  const [compact, setCompact] = useState(() => {
    if (typeof window === 'undefined') return true;
    try { return window.localStorage.getItem(compactPreferenceKey) !== 'false'; } catch { return true; }
  });
  const markVisibilityPreferenceKey = `ai-context:mark-visibility:${props.appName ?? (typeof window === 'undefined' ? 'app' : window.location.host)}`.slice(0, 240);
  const [markVisibility, setMarkVisibility] = useState<'none' | 'areas' | 'notes'>(() => {
    if (typeof window === 'undefined') return 'notes';
    try {
      const saved = window.localStorage.getItem(markVisibilityPreferenceKey);
      return saved === 'none' || saved === 'areas' || saved === 'notes' ? saved : 'notes';
    } catch { return 'notes'; }
  });
  const showMarks = markVisibility !== 'none', showMarkText = markVisibility === 'notes';
  const networkPreferenceKey = `ai-context:record-network:${props.appName ?? (typeof window === 'undefined' ? 'app' : window.location.host)}`.slice(0, 240);
  const [recordNetwork, setRecordNetwork] = useState(() => {
    const configured = props.activity === false ? false : props.activity?.recordNetwork !== false;
    if (typeof window === 'undefined') return configured;
    try { const saved = window.localStorage.getItem(networkPreferenceKey); return saved === 'true' ? true : saved === 'false' ? false : configured; }
    catch { return configured; }
  });
  const networkRecordingRef = useRef(recordNetwork); networkRecordingRef.current = recordNetwork;
  const configuredNetwork = props.activity === false ? false : props.activity?.recordNetwork !== false;
  const previousConfiguredNetwork = useRef(configuredNetwork);
  const [selecting, setSelecting] = useState(false);
  const [highlight, setHighlight] = useState<(SelectionBounds & { tag: string; members?: SelectionBounds[] }) | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationContext[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null), [editingId, setEditingId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const inspection = useRef({ stepId: selectedStepId, showAnnotations: showMarks });
  inspection.current = { stepId: selectedStepId, showAnnotations: showMarks };
  const [, redraw] = useState(0), [clock, setClock] = useState(Date.now());
  const refs = useRef({ annotations, activeId, editingId }); refs.current = { annotations, activeId, editingId };
  const propsRef = useRef(props); propsRef.current = props;
  const observe = () => { const current = propsRef.current; return sanitizeRecordedContext({ capturedAt: new Date().toISOString(), appName: current.appName,
    url: window.location.href, publicQueryParams: current.publicQueryParams, build: { environment: current.environment, buildId: current.buildId, branch: current.branch }, viewport: { width: innerWidth, height: innerHeight } }); };
  const controller = useRef<RecordingController | null>(null), activeWork = useRef(0), alive = useRef(true);
  const wikiRecordingRead = useRef<AbortController | null>(null), wikiRecordingSource = useRef(wiki?.manageUrl);
  wikiRecordingSource.current = wiki?.manageUrl;
  useEffect(() => () => { wikiRecordingRead.current?.abort(); }, [wiki?.manageUrl]);
  useEffect(() => { if (!open || view !== 'import' || !showWikiImport) wikiRecordingRead.current?.abort(); }, [open, view, showWikiImport]);
  const handoffRoot = useRef<HTMLDivElement>(null), handoff = useRef<AgentDomTransport | null>(null);
  const panel = useRef<HTMLElement>(null), launcher = useRef<HTMLButtonElement>(null), selectButton = useRef<HTMLButtonElement>(null);
  const selectedElement = useRef<Element | null>(null), persistedSessionId = useRef<string | undefined>(undefined);
  const knowledge = useRef<{ loader: NonNullable<AIToolbarProps['loadKnowledge']>; promise: Promise<KnowledgeBundle> } | null>(null);
  const loadedKnowledge = useRef<KnowledgeBundle | undefined>(undefined);
  const getDocuments = () => { const published = propsRef.current.knowledge ?? loadedKnowledge.current; return published ? { ...published, documents: published.documents.filter(document => documentMatchesRoute(document, window.location.pathname)) } : undefined; };
  const reader = useRef<() => Promise<AgentContext>>(async () => { throw new Error(t("El contexto se está preparando.")); });
  const id = useId(), snapshot = controller.current?.snapshot(), session = snapshot?.session;
  const recording = session?.recording === 'active';
  const sessionMarks = annotations.filter(mark => mark.caseId === session?.id);
  const activeMark = sessionMarks.find(mark => mark.id === editingId && mark.pathname === sanitizePathname(window.location.pathname));
  const selectedStep = snapshot?.steps.find(step => step.id === selectedStepId);
  const presentedSteps = recordingSteps(snapshot?.steps ?? [], snapshot?.events ?? [], compact);
  const visibleSteps = presentedSteps.filter(step => !selectedStep || step.id === selectedStep.id);
  const visibleStepIds = new Set(presentedSteps.map(step => step.id));
  const presentedQueries = (snapshot?.events ?? []).filter(event => event.kind === 'fetch' && (!compact || !routineFrameworkQuery(event)));
  const internalQueries = compact ? (snapshot?.events ?? []).filter(routineFrameworkQuery) : [];
  const visibleMarks = sessionMarks.filter(mark => (!mark.pending || mark.id === editingId) && (!selectedStep || mark.id === selectedStep.targetId));
  const unlinkedMarks = selectedStep ? [] : sessionMarks.filter(mark => !mark.pending && !snapshot?.steps.some(step => step.targetId === mark.id));
  const previewColor = nextMarkColor(new Set(sessionMarks.flatMap(mark => mark.color ? [mark.color] : [])));
  const dockExpanded = dockPreferences.pinned || dockHover || dockFocused || dockTouchOpen || positionMenuOpen || !!editingId || selecting;
  const dockPlacement = useDockPlacement({ root, dock, preferred: dockPreferences.corner, expanded: dockExpanded, menuOpen: positionMenuOpen });
  const placedCorner = dockPlacement?.corner ?? dockPreferences.corner;
  const expandedDock = dockExpanded && !dockPlacement?.compressed;
  const showDockActions = expandedDock || dockPlacement?.compressed === true;

  function changeDockPreferences(next: Partial<typeof dockPreferences>) {
    const value = { ...dockPreferences, ...next }; setDockPreferences(value);
    try { window.localStorage.setItem(dockPreferenceKey, JSON.stringify(value)); } catch { /* Layout remains usable without persisted preferences. */ }
  }
  function cancelDockLeave() { window.clearTimeout(dockLeaveTimer.current); dockLeaveTimer.current = undefined; }
  function leaveDock() {
    cancelDockLeave(); dockLeaveTimer.current = window.setTimeout(() => setDockHover(false), 160);
  }
  function focusPositionTrigger() {
    dockPointerFocus.current = false; setDockFocused(true); positionTrigger.current?.focus({ preventScroll: true });
  }
  function chooseCorner(corner: ToolbarCorner) { changeDockPreferences({ corner }); setPositionMenuOpen(false); focusPositionTrigger(); }
  function togglePositionMenu() {
    const next = !positionMenuOpen; setPositionMenuOpen(next);
    if (next) requestAnimationFrame(() => positionMenu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true }));
  }

  function currentAnnotation() {
    const sessionId = controller.current?.snapshot().session?.id;
    return refs.current.annotations.find(mark => mark.caseId === sessionId && mark.id === refs.current.activeId && mark.pathname === sanitizePathname(window.location.pathname)) ?? null;
  }
  function currentTarget() {
    const mark = currentAnnotation(); if (!mark || mark.kind === 'area') return null;
    return resolveAnnotation(document, mark) ?? (selectedElement.current?.isConnected ? selectedElement.current : null);
  }
  function currentBounds() {
    const mark = currentAnnotation();
    if (!mark || mark.kind !== 'area' || mark.viewport.width !== innerWidth || mark.viewport.height !== innerHeight) return null;
    return { ...mark.bounds, x: mark.bounds.x - scrollX, y: mark.bounds.y - scrollY };
  }
  async function ensureKnowledge() {
    const current = propsRef.current;
    if (current.knowledge) return validateKnowledgeBundle(current.knowledge);
    if (!current.loadKnowledge) return null;
    if (knowledge.current?.loader !== current.loadKnowledge) knowledge.current = { loader: current.loadKnowledge,
      promise: Promise.resolve().then(current.loadKnowledge).then(validateKnowledgeBundle).then(value => { loadedKnowledge.current = value; return value; }) };
    return knowledge.current.promise;
  }
  reader.current = async () => {
    const documents = await ensureKnowledge(), current = propsRef.current, sessionId = controller.current?.snapshot().session?.id;
    const marks = refs.current.annotations.filter(mark => mark.caseId === sessionId && !mark.pending);
    const activity = current.activity === false ? false : { ...(current.activity ?? { resources: [] }), recordNetwork: networkRecordingRef.current };
    return createAgentContext(captureContext({ build: { environment: current.environment,
      ...(current.branch ? { branch: current.branch } : {}), ...(current.buildId ? { buildId: current.buildId } : {}) },
      rules: current.rules ?? [], target: currentTarget(),
      ...(marks.length ? { annotations: marks, ...(refs.current.activeId ? { activeAnnotationId: refs.current.activeId } : {}) } : {}),
      ...(documents ? { knowledge: { ...documents, documents: documents.documents.filter(document => documentMatchesRoute(document, window.location.pathname)) } } : {}), ...(current.publicQueryParams ? { publicQueryParams: current.publicQueryParams } : {}),
      ...(activity ? { activity: controller.current?.activityEntries() ?? [] } : {}) }));
  };
  function updateMarks(next: AnnotationContext[]) { const colored = assignMarkColors(next); refs.current.annotations = colored; setAnnotations(colored); }
  function persistMarks() {
    if (propsRef.current.review?.persistence === false) return;
    const sessionId = controller.current?.snapshot().session?.id;
    if (sessionId && !saveAnnotations(window, refs.current.annotations, sessionId))
      throw new Error(t("Las marcas siguen abiertas, pero el navegador no pudo guardarlas. Descargá la grabación antes de recargar."));
  }
  function clearSelection() {
    refs.current.activeId = null; refs.current.editingId = null; setActiveId(null); setEditingId(null); selectedElement.current = null; setHighlight(null);
  }
  function editMark(mark: AnnotationContext) {
    if (!mark.pending || mark.pathname !== sanitizePathname(window.location.pathname)) return;
    refs.current.activeId = mark.id; refs.current.editingId = mark.id; setActiveId(mark.id); setEditingId(mark.id);
    selectedElement.current = resolveAnnotation(document, mark); setOpen(false);
  }
  function commitSelection(result: SelectionResult) {
    const sessionId = controller.current?.snapshot().session?.id;
    if (!sessionId || controller.current?.snapshot().session?.recording !== 'active' || activeWork.current) return;
    const context = observe();
    const mark = { ...result.annotation, ...(context ? { context } : {}), caseId: sessionId, pending: true };
    updateMarks([...refs.current.annotations, mark]); refs.current.activeId = mark.id; refs.current.editingId = mark.id;
    setActiveId(mark.id); setEditingId(mark.id); selectedElement.current = result.element; setHighlight(null); setMessage(''); setError('');
    try { persistMarks(); } catch (cause) { setError((cause as Error).message); }
  }
  function changeNote(note: string) {
    updateMarks(refs.current.annotations.map(mark => mark.id === refs.current.editingId ? { ...mark, note: note.slice(0, 2000), updatedAt: new Date().toISOString() } : mark));
  }
  async function finishMark(cancel = false, requirePersistence = true) {
    const mark = refs.current.annotations.find(item => item.id === refs.current.editingId); if (!mark) return;
    const isNew = mark.pending === true;
    const previous = refs.current.annotations;
    updateMarks(cancel && isNew ? refs.current.annotations.filter(item => item.id !== mark.id)
      : refs.current.annotations.map(item => item.id === mark.id ? { ...item, pending: false, updatedAt: new Date().toISOString() } : item));
    try { persistMarks(); } catch (cause) {
      if (requirePersistence) { updateMarks(previous); throw cause; }
      setError(cause instanceof Error ? cause.message : t("No se pudieron guardar las marcas para después de recargar."));
    }
    if (!cancel && isNew && controller.current?.snapshot().session?.recording === 'active') {
      try { await operation('checkpoint', { label: `${t('Marca')}: ${mark.label}`, notes: mark.note, targetId: mark.id, actor: 'user', attribution: 'declared' }); }
      catch (cause) { updateMarks(previous); try { persistMarks(); } catch { /* Keep the original note available for retry. */ } throw cause; }
    }
    clearSelection(); if (!cancel) setMessage(t("Marca guardada. Podés marcar otra zona."));
  }
  async function removeMark(markId: string) {
    const previous = refs.current.annotations;
    const steps = controller.current?.snapshot().steps.filter(step => step.targetId === markId) ?? [];
    updateMarks(previous.filter(item => item.id !== markId));
    try { persistMarks(); for (const step of steps) await operation('removeStep', { stepId: step.id }); }
    catch (cause) { updateMarks(previous); try { persistMarks(); } catch { /* The error leaves the original mark visible. */ } throw cause; }
    if (refs.current.activeId === markId) clearSelection();
    if (steps.some(step => step.id === selectedStepId)) setSelectedStepId(null);
    if (!controller.current?.snapshot().session) await closeDiscardedRecording();
  }
  async function removeRecordedStep(stepId: string) {
    const step = controller.current?.snapshot().steps.find(item => item.id === stepId);
    if (!step) return;
    const previous = refs.current.annotations;
    if (step.targetId) updateMarks(previous.filter(mark => mark.id !== step.targetId));
    try { persistMarks(); await operation('removeStep', { stepId }); }
    catch (cause) { updateMarks(previous); try { persistMarks(); } catch { /* The original mark stays available for retry. */ } throw cause; }
    if (step.targetId === refs.current.activeId) clearSelection();
    if (selectedStepId === stepId) setSelectedStepId(null);
    if (!controller.current?.snapshot().session) await closeDiscardedRecording();
  }
  async function openMarkStep(mark: AnnotationContext) {
    if (refs.current.editingId) await finishMark(!refs.current.annotations.find(item => item.id === refs.current.editingId)?.note.trim());
    const step = controller.current?.snapshot().steps.find(item => item.targetId === mark.id);
    setSelectedStepId(step?.id ?? null); setSelecting(false); setHighlight(null); setView('recording'); setOpen(true);
  }
  async function toggleSelection() {
    if (editingId) await finishMark(!activeMark?.note.trim());
    setSelecting(value => !value); setOpen(false); setHighlight(null); setSelectedStepId(null);
  }
  useEffect(() => {
    alive.current = true; const host = document.createElement('div'); host.setAttribute('data-ai-toolbar-host', ''); host.setAttribute('data-ai-toolbar-root', ''); document.body.append(host);
    void ensureToolbarFont(document);
    setRoot(host.attachShadow({ mode: 'open' })); return () => { alive.current = false; host.remove(); };
  }, []);
  useEffect(() => {
    if (!root) return;
    const host = root.host as HTMLElement;
    const place = () => {
      let modal: Element | null = null;
      try { modal = Array.from(document.querySelectorAll('dialog:modal')).at(-1) ?? null; } catch { /* Older browsers. */ }
      const container = propsRef.current.portalContainer ?? modal ?? document.body;
      if (host.parentNode !== container) container.append(host);
      if (typeof host.showPopover === 'function') {
        host.setAttribute('popover', 'manual');
        if (!host.matches(':popover-open')) { try { host.showPopover(); } catch { host.removeAttribute('popover'); } }
      }
    };
    place();
    const observer = new MutationObserver(place); observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, [root, props.portalContainer]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const path = event.composedPath();
      if ((dock.current && path.includes(dock.current)) || (panel.current && path.includes(panel.current))) return;
      cancelDockLeave(); setDockHover(false); setDockTouchOpen(false); setDockFocused(false); setPositionMenuOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Tab') dockPointerFocus.current = false;
      if (event.key !== 'Escape') return;
      setDockTouchOpen(false);
      if (positionMenuOpen) { event.preventDefault(); event.stopPropagation(); setPositionMenuOpen(false); focusPositionTrigger(); }
    };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true); cancelDockLeave(); };
  }, [positionMenuOpen]);
  useEffect(() => {
    if (!root) return; const current = propsRef.current, activity = current.activity === false ? false : { ...(current.activity ?? { resources: [] }), recordNetwork: networkRecordingRef.current };
    const instance = createReviewController({ window, observe, getDocuments, locale: () => resolveLocale(propsRef.current.locale), getLegacyContext: () => reader.current(), getTarget: currentTarget,
      getRegionBounds: currentBounds, getSelectionId: () => currentAnnotation()?.id, activity,
      getInspection: () => ({ ...(inspection.current.stepId ? { stepId: inspection.current.stepId } : {}), showAnnotations: inspection.current.showAnnotations }),
      review: { ...current.review, persistence: current.review?.persistence === false ? false : {
        key: current.review?.persistence?.key ?? `${current.appName ?? 'app'}:${current.buildId ?? 'default'}:active-case`.slice(0, 200) } },
      onChange: () => {
        if (!alive.current) return;
        const enabled = controller.current?.getNetworkRecording?.();
        if (typeof enabled === 'boolean') { networkRecordingRef.current = enabled; setRecordNetwork(enabled); }
        redraw(value => value + 1);
      } }) as RecordingController;
    controller.current = instance;
    const recordingOperations = new Set(['beginRecording', 'setNetworkRecording', 'checkpoint', 'stopRecording', 'removeStep']);
    const operations = Object.fromEntries(Object.entries(instance.operations).filter(([name]) => recordingOperations.has(name)).map(([name, fn]) => [name, async (input: Record<string, unknown>) => {
      if (name === 'checkpoint' && input.capture !== undefined) throw new Error(t("Las grabaciones no incluyen capturas. Marcá la zona y agregá tu comentario."));
      const result = await fn(input); await refreshContext(instance); return result;
    }]));
    if (handoffRoot.current) handoff.current = installAgentDomTransport({ root: handoffRoot.current, readOnly: true,
      getContext: () => refreshContext(instance), operations, readFile: fileId => instance.readFile(fileId) });
    let bridge: ReturnType<typeof installAgentBridge> | undefined;
    try { bridge = installAgentBridge({ window, recordingOnly: true, getContext: () => reader.current(), getContextV2: () => refreshContext(instance), operations,
      onSiteToolsStatus: available => instance.setSiteToolsAvailable(available) }); } catch { setError(t("Ya hay otro Toolkit en esta página.")); }
    redraw(value => value + 1); void refreshContext(instance).catch(() => {});
    return () => { bridge?.dispose(); handoff.current?.dispose(); handoff.current = null; instance.dispose(); if (controller.current === instance) controller.current = null; };
  }, [root]);
  useEffect(() => {
    const changed = previousConfiguredNetwork.current !== configuredNetwork;
    previousConfiguredNetwork.current = configuredNetwork;
    controller.current?.updateActivityConfig({ ...(props.activity !== false && props.activity?.maxBodyChars !== undefined ? { maxBodyChars: props.activity.maxBodyChars } : {}),
      ...(changed ? { recordNetwork: configuredNetwork } : {}) });
    if (changed) {
      networkRecordingRef.current = configuredNetwork; setRecordNetwork(configuredNetwork);
      try { window.localStorage.setItem(networkPreferenceKey, String(configuredNetwork)); } catch { /* Session still receives the update. */ }
    }
  }, [root, configuredNetwork, props.activity === false ? undefined : props.activity?.maxBodyChars]);
  useEffect(() => {
    if (persistedSessionId.current === session?.id) return; persistedSessionId.current = session?.id;
    const saved = session?.id && propsRef.current.review?.persistence !== false ? loadAnnotations(window, session.id, setError) : [];
    updateMarks(saved); clearSelection(); setSelecting(false); setSelectedStepId(null);
    setFallback('');
    const pending = saved.find(mark => mark.pending && mark.pathname === sanitizePathname(window.location.pathname));
    if (pending) editMark(pending);
  }, [session?.id]);
  useEffect(() => {
    if (!editingId || activeMark) return;
    const mark = refs.current.annotations.find(item => item.id === editingId);
    if (!mark) { clearSelection(); return; }
    // A note typed on the previous route stays with that route. Do not create a
    // checkpoint on the new page, or attach its target to a different element.
    updateMarks(mark.note.trim() ? refs.current.annotations.map(item => item.id === mark.id ? { ...item, pending: false } : item)
      : refs.current.annotations.filter(item => item.id !== mark.id));
    clearSelection(); try { persistMarks(); } catch (cause) { setError((cause as Error).message); }
  }, [editingId, activeMark, snapshot?.revision]);
  useEffect(() => {
    if (!session?.id) return; const timer = setTimeout(() => { try { persistMarks(); } catch (cause) { setError((cause as Error).message); } }, 250);
    return () => clearTimeout(timer);
  }, [annotations, session?.id]);
  useEffect(() => {
    const flush = () => { try { persistMarks(); } catch { /* Storage failure is already visible in the editor. */ } };
    window.addEventListener('pagehide', flush); return () => { flush(); window.removeEventListener('pagehide', flush); };
  }, []);
  useEffect(() => {
    if (!recording) { setSelecting(false); return; }
    setClock(Date.now()); const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (!root) return; const inspecting = selecting && recording && !editingId;
    root.host.toggleAttribute('data-ai-toolbar-selecting', inspecting); if (!inspecting) return;
    return installSelection({ document, host: root.host, mode: 'auto', locale, onPreview: setHighlight, onSelect: commitSelection,
      onCancel: () => { setSelecting(false); setHighlight(null); selectButton.current?.focus({ preventScroll: true }); }, onMessage: setMessage });
  }, [root, selecting, recording, editingId, locale]);
  useEffect(() => {
    if (!sessionMarks.length) return; let frame = 0;
    const changed = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; redraw(value => value + 1); }); };
    const timer = setInterval(changed, 600); window.addEventListener('scroll', changed, true); window.addEventListener('resize', changed); window.addEventListener('popstate', changed);
    return () => { clearInterval(timer); cancelAnimationFrame(frame); window.removeEventListener('scroll', changed, true); window.removeEventListener('resize', changed); window.removeEventListener('popstate', changed); };
  }, [sessionMarks.length]);
  useEffect(() => {
    if (!open) return; panel.current?.querySelector<HTMLElement>(view === 'import' && !showWikiImport ? 'textarea' : 'h2')?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setOpen(false); launcher.current?.focus({ preventScroll: true }); } };
    document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape);
  }, [open, view, showWikiImport]);
  useEffect(() => { if (!root || busy) return; void loadHistory().catch(() => {}); }, [root, session?.id, recording]);
  useEffect(() => { if (busy || !controller.current) return; void refreshContext().catch(() => setError(t("No se pudo actualizar el contexto. Volvé a intentar."))); }, [snapshot?.revision, annotations, activeId, busy, selectedStepId, showMarks, locale]);
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 5000); return () => clearTimeout(timer); }, [message]);

  async function refreshContext(instance = controller.current) {
    if (!instance) throw new Error(t("La grabación se está preparando.")); const value = await instance.getContext();
    if (alive.current) setContext(value); handoff.current?.refresh(value); return value;
  }
  async function operation(name: string, input: Record<string, unknown> = {}) {
    const fn = controller.current?.operations[name]; if (!fn) throw new Error(t("La acción todavía se está preparando."));
    const result = await fn({ requestId: crypto.randomUUID(), ...input }) as { status: string; data: unknown; error?: { message: string } };
    if (result.status === 'error') throw new Error(result.error?.message ?? t("No se pudo completar la acción.")); return result.data;
  }
  async function run(work: () => Promise<void>) {
    if (activeWork.current) return; activeWork.current++; setBusy(true); setError(''); setMessage('');
    try { await work(); await refreshContext(); } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : t("No se pudo completar la acción.")); }
    finally { activeWork.current--; if (alive.current) setBusy(false); }
  }
  async function loadHistory() { if (controller.current) setHistory(await controller.current.listSavedCases()); }
  async function closeDiscardedRecording() {
    updateMarks([]); clearSelection(); setSelectedStepId(null); setSelecting(false); setOpen(false);
    await loadHistory(); setMessage(t("Grabación vacía descartada."));
  }
  async function record() {
    if (controller.current?.snapshot().session?.recording === 'active') {
      if (refs.current.editingId) await finishMark(!refs.current.annotations.find(mark => mark.id === refs.current.editingId)?.note.trim(), false);
      try { persistMarks(); } catch (cause) { setError((cause as Error).message); }
      await operation('stopRecording'); setSelecting(false); clearSelection(); setView('recording');
      if (!controller.current?.snapshot().session) await closeDiscardedRecording();
      else { setOpen(true); await loadHistory(); }
    } else { persistMarks(); await operation('beginRecording', { authorized: true }); setOpen(false); clearSelection(); setSelecting(false); }
  }
  async function openRecording(recordingId: string) {
    persistMarks(); await controller.current!.restoreSavedCase(recordingId); const restored = controller.current!.snapshot().session;
    if (restored) { updateMarks(loadAnnotations(window, restored.id, setError)); persistedSessionId.current = restored.id; }
    clearSelection(); setSelecting(false); setSelectedStepId(null);
    setOpen(true); setView('recording'); await loadHistory();
  }
  async function resumeRecording() {
    const current = controller.current?.snapshot().session;
    if (!current || current.recording === 'active') return;
    persistMarks();
    await operation('startRecording', { authorized: true, captureRequired: false, sessionId: current.id });
    setOpen(false); setSelecting(false); setSelectedStepId(null); clearSelection();
    await loadHistory();
  }
  async function deleteRecording(recordingId: string) { await controller.current!.deleteSavedRecording(recordingId); await loadHistory(); setMessage(t("Grabación borrada.")); }
  async function copyText(markdown: string, format = 'Markdown') {
    setFallback(''); setFallbackFormat(format); let timer: number | undefined;
    try { await Promise.race([navigator.clipboard.writeText(markdown), new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error(t("El portapapeles no respondió."))), 4000); })]); setMessage(format === 'JSON' ? t("JSON copiado. Pegalo con el + en otra toolbar.") : t("Markdown copiado. Continuá en tu chat.")); }
    catch { setFallback(markdown); throw new Error(t('No se pudo copiar. Podés seleccionar el {format} de abajo.', { format })); } finally { clearTimeout(timer); }
  }
  async function copyRecording() { await copyText(recordingMarkdown(await refreshContext(), { compact, locale })); }
  async function copyJson() { await copyText(recordingJson(await refreshContext()), 'JSON'); }
  function showImport() {
    setError(''); setMessage(''); setFallback(''); setSelecting(false); clearSelection(); setSelectedStepId(null);
    setImportSource(wiki?.manageUrl ? 'wiki' : 'json');
    setView('import'); setOpen(true);
  }
  async function pasteRecording(text = importText, title?: string) {
    if (title) {
      const source = JSON.parse(text);
      if (source && typeof source === 'object' && !Array.isArray(source) && source.session && typeof source.session === 'object' && !Array.isArray(source.session)) {
        source.session.objective = sanitizeReviewText(title, 1000) || t('Grabación'); text = JSON.stringify(source);
      }
    }
    persistMarks();
    const marks = await controller.current!.importRecording(text);
    persistedSessionId.current = controller.current!.snapshot().session!.id;
    updateMarks(marks); clearSelection(); setSelecting(false); setSelectedStepId(null);
    setImportText(''); setView('recording'); setOpen(true); await loadHistory();
    setMessage(t("Grabación importada."));
  }
  async function chooseWikiRecording(item: WikiRecordingSummary) {
    const manageUrl = wikiRecordingSource.current, instance = controller.current;
    if (!manageUrl || !instance) return;
    const abort = new AbortController();
    wikiRecordingRead.current?.abort(); wikiRecordingRead.current = abort;
    let readComplete = false;
    try {
      const text = await readWikiRecording(window, manageUrl, item.id, AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]));
      if (abort.signal.aborted || !alive.current || wikiRecordingSource.current !== manageUrl || controller.current !== instance) return;
      readComplete = true;
      await pasteRecording(text, item.title);
      const importedSession = instance.snapshot().session;
      if (importedSession) rememberRecordingOrigin(window, { sessionId: importedSession.id, recordingId: item.id, manageUrl });
      setMessage(t('Grabación «{title}» añadida.', { title: item.title }));
    } catch (cause) {
      if (abort.signal.aborted || !alive.current) return;
      if (!readComplete) {
        window.dispatchEvent(new Event('ai-context-toolbar:wiki-auth-changed'));
        throw new Error(wikiRecordingErrorMessage(cause, locale));
      }
      throw cause;
    } finally {
      if (wikiRecordingRead.current === abort) wikiRecordingRead.current = null;
    }
  }
  function changeCompact(enabled: boolean) {
    setCompact(enabled); setFallback('');
    if (enabled && selectedStep && isRecordingBoundary(selectedStep)) setSelectedStepId(null);
    try { window.localStorage.setItem(compactPreferenceKey, String(enabled)); } catch { /* This view still applies when preferences cannot persist. */ }
  }
  function cycleMarkVisibility() {
    const next = markVisibility === 'none' ? 'areas' : markVisibility === 'areas' ? 'notes' : 'none';
    setMarkVisibility(next);
    try { window.localStorage.setItem(markVisibilityPreferenceKey, next); } catch { /* The current view remains usable without persisted preferences. */ }
  }
  async function changeNetworkRecording() {
    const enabled = !networkRecordingRef.current;
    await operation('setNetworkRecording', { enabled });
    networkRecordingRef.current = enabled; setRecordNetwork(enabled);
    try { window.localStorage.setItem(networkPreferenceKey, String(enabled)); }
    catch { setError(t("El tráfico de red se configuró para esta pestaña, pero no se pudo guardar la preferencia.")); }
  }
  async function openCurrentRecording() {
    if (editingId) await finishMark(!activeMark?.note.trim());
    setSelecting(false); setHighlight(null); setView('recording'); setOpen(value => !(value && view === 'recording'));
  }
  async function showDocuments() {
    if (editingId) await finishMark(!activeMark?.note.trim()); setSelecting(false); setHighlight(null); setView('documents'); setOpen(value => !(value && view === 'documents'));
  }
  function documentHref(documentId: string) {
    const path = props.documentsPath;
    if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return undefined;
    const url = new URL(path, window.location.origin);
    url.searchParams.set('document', documentId);
    return `${url.pathname}${url.search}${url.hash}`;
  }
  const elapsed = recording ? Math.max(0, Math.floor((clock - Date.parse(session?.startedAt ?? new Date(clock).toISOString())) / 1000)) : 0;
  const timer = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
  const currentStepCount = presentedSteps.length + sessionMarks.filter(mark => !mark.pending && !snapshot?.steps.some(step => step.targetId === mark.id)).length;
  const savedHistory = history.filter(item => item.sessionId !== session?.id && item.id !== session?.id);
  const recordingItems: SavedRecording[] = [...savedHistory, ...(session && !recording ? [{ id: session.id, sessionId: session.id, title: session.objective,
    updatedAt: session.lastActivityAt, startedAt: session.startedAt, stepCount: currentStepCount,
    contentStepCount: recordingSteps(snapshot?.steps ?? [], snapshot?.events ?? [], true).length + sessionMarks.filter(mark => !mark.pending && !snapshot?.steps.some(step => step.targetId === mark.id)).length }] : [])]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || (a.sessionId ?? a.id).localeCompare(b.sessionId ?? b.id));
  const importedNotice = session?.notes ? importNoticeIn(session.notes) : undefined;
  function markRegions(mark: AnnotationContext) {
    const sources = mark.kind === 'group' ? mark.relatedElements.map(element => ({ element, bounds: element.bounds })) : [{ element: mark.element, bounds: mark.bounds }];
    return sources.flatMap(source => {
      const target = resolveAnnotation(document, { ...mark, element: source.element });
      const live = target && visibleElementBounds(target);
      if (target) return live ? [{ ...live, historical: false }] : [];
      // Missing or ambiguous DOM references belong in the recording, never over unrelated live content.
      if (source.element || mark.viewport.width !== innerWidth || mark.viewport.height !== innerHeight) return [];
      const box = { ...source.bounds, x: source.bounds.x - scrollX, y: source.bounds.y - scrollY };
      return box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= innerWidth || box.y >= innerHeight ? [] : [{ ...box, historical: true }];
    });
  }
  if (!root) return null;
  return createPortal(<div className="shell" data-corner={placedCorner} data-ai-toolbar-root="" data-ai-toolbar-version="2" lang={locale}>
    <style nonce={props.nonce}>{styles + selectionActionsStyles + caseStyles}</style>
    <div ref={handoffRoot} className="agent-handoff-root" data-visible="false" />
    {context && <script type="application/json" data-ai-context-entry="2">{JSON.stringify(context)}</script>}
    {activeMark && !open && <SelectionActions locale={locale} key={activeMark.id} name={activeMark.label} tag={activeMark.kind === 'group' ? t('Selección múltiple') : activeMark.kind === 'area' ? t("Área libre") : activeMark.kind === 'section' ? t("Sección") : activeMark.element?.tag ?? t("Elemento")}
      color={markColor(activeMark)}
      position={t('Marca {number}', { number: sessionMarks.indexOf(activeMark) + 1 })} busy={busy} note={activeMark.note} pending={activeMark.pending === true}
      onNoteChange={changeNote} onDone={() => void run(() => finishMark())} onCancel={() => void run(() => finishMark(true))}
      onClear={() => void run(() => removeMark(activeMark.id))} status={message} error={error}
      anchor={enclosingBounds(markRegions(activeMark))} />}
    {selecting && recording && !editingId && <><div className="inspector-banner" data-ai-toolbar-overlay=""><span>{t("Clic para marcar · arrastrá para seleccionar elementos")}<span className="selection-key-hint">{t(" · Shift + clic para una sección")}</span></span>
      <button type="button" className="icon-button" aria-label={t("Salir de selección")} title={t("Salir de selección · Esc")} onClick={() => { setSelecting(false); setHighlight(null); }}><Icon name="close" /></button></div>
      {highlight && <div className="highlight" data-ai-toolbar-overlay="" data-multiple={!!highlight.members} aria-hidden="true" style={{ ...markStyle(previewColor), left: highlight.x, top: highlight.y, width: highlight.width, height: highlight.height }}><span>{highlight.tag}{highlight.members ? ` · ${highlight.members.length}` : ''}</span></div>}
      {highlight?.members?.map((box, index) => <div key={index} className="highlight selection-member" aria-hidden="true" style={{ ...markStyle(previewColor), left: box.x, top: box.y, width: box.width, height: box.height }} />)}</>}
    {showMarks && (!selecting || !!editingId) && visibleMarks.map(mark => {
      if (recordedRoute(mark.context, mark.pathname) !== recordedRoute(observe(), sanitizePathname(window.location.pathname))) return null;
      const regions = markRegions(mark);
      if (!regions.length) return null;
      const left = Math.min(...regions.map(box => box.x)), top = Math.min(...regions.map(box => box.y));
      const box = { x: left, y: top, width: Math.max(...regions.map(box => box.x + box.width)) - left, height: Math.max(...regions.map(box => box.y + box.height)) - top };
      const number = sessionMarks.indexOf(mark) + 1;
      return <div key={mark.id} data-ai-toolbar-overlay="" style={markStyle(markColor(mark))}>
        {regions.map((region, index) => <div key={index} className="annotation-region" data-position={region.historical ? 'historical' : 'matched'} data-group-member={mark.kind === 'group' ? index : undefined} aria-hidden="true" style={{ left: region.x, top: region.y, width: region.width, height: region.height }} />)}
        {box.x >= 0 && box.y >= 0 && <span className="annotation-corner" aria-hidden="true" style={{ left: box.x, top: box.y, width: Math.min(16, box.width), height: Math.min(16, box.height) }} />}
        <button type="button" className="annotation-pin" aria-label={`${t("Marca {number}", { number })}: ${mark.note || mark.label}`} disabled={busy}
        style={{ left: Math.min(innerWidth - 28, Math.max(2, box.x - 28)), top: Math.min(innerHeight - 28, Math.max(2, box.y - 28)) }} onClick={() => void run(() => openMarkStep(mark))}>{number}</button>
        {showMarkText && mark.note && editingId !== mark.id && <p className="annotation-comment" style={{ left: Math.max(8, Math.min(innerWidth - 228, box.x + box.width + 238 < innerWidth ? box.x + box.width + 10 : box.x)), top: Math.max(8, Math.min(innerHeight - 120, box.x + box.width + 238 < innerWidth ? box.y : box.y + box.height + 8)) }}>{regions.some(region => region.historical) && <small>{t('Posición histórica')} · </small>}{mark.note}</p>}</div>;
    })}
    {open && <section className="panel recording-panel" ref={panel} role="dialog" aria-modal="false" aria-label={view === 'documents' ? t("Documentos") : view === 'import' ? t(showWikiImport ? 'Grabaciones del proyecto' : 'Pegar grabación') : t("Grabación")} id={`${id}-panel`}>
      <header className="panel-head"><h2 tabIndex={-1}>{view === 'documents' ? t("Documentos") : view === 'import' ? t(showWikiImport ? 'Grabaciones del proyecto' : 'Pegar grabación') : recordingTitle(session?.objective || t("Grabación"), compact, locale)}</h2>
        {view === 'recording' && session && !recording && <div className="recording-header-actions"><button className="icon-button recording-resume" type="button" aria-label={t("Reanudar grabación")} title={t("Reanudar grabación")} disabled={busy || props.activity === false} onClick={() => void run(resumeRecording)}><Icon name="play" /></button><button className="icon-button recording-format-copy" type="button" aria-label={t("Copiar MD")} disabled={busy} onClick={() => void run(copyRecording)}><Icon name="copy" /><span className="copy-format" aria-hidden="true">.md</span></button><button className="icon-button recording-format-copy" type="button" aria-label={t("Copiar JSON")} disabled={busy} onClick={() => void run(copyJson)}><Icon name="copy" /><span className="copy-format" aria-hidden="true">.json</span></button><button className="icon-button" type="button" aria-label={t("Borrar grabación")} title={t("Borrar grabación")} disabled={busy} onClick={() => void run(() => deleteRecording(session.id))}><Icon name="trash" /></button></div>}
        <button className="icon-button" type="button" aria-label={t("Cerrar panel")} title={t("Cerrar")} onClick={() => setOpen(false)}><Icon name="close" /></button></header>
      <div className="panel-body">
        {view === 'recording' && session ? <>
          <p className="subtle">{recording ? t("Grabando") : t("Guardada en este navegador")}{!compact && <> · {new Date(session.startedAt).toLocaleString(dateLocale(locale), { hour12: false })}</>} · {t('{count} marcas', { count: sessionMarks.filter(mark => !mark.pending).length })}</p>
          {!recording && wiki?.manageUrl && <WikiRecordingAuthor key={`author-${session.id}`} sessionId={session.id} manageUrl={wiki.manageUrl} locale={locale} />}
          {!recording && wiki?.manageUrl && <WikiRecordingSave key={session.id} wiki={wiki} locale={locale} sessionId={session.id} title={recordingTitle(session.objective || t('Grabación'), compact, locale)} getJson={async () => recordingJson(await refreshContext())} getMarkdown={async () => recordingMarkdown(await refreshContext(), { compact, locale })} />}
          {session.notes && <p className="recording-session-notes">{importedNotice
            ? <>{session.notes.replace(importedNotice, '').trim()}{session.notes.replace(importedNotice, '').trim() && ' '}<span className="recording-import-label" tabIndex={0} title={t(RECORDING_IMPORT_NOTICE)} aria-label={`${t("Importación")}. ${t(RECORDING_IMPORT_NOTICE)}`}>{t("Importación")}</span></>
            : session.notes}</p>}
          <div className="recording-filters"><label className="consent" title={t("Cambiar entre sin marcas, con marcas y con indicaciones")}><input type="checkbox" aria-label={t("Visibilidad de marcas")} aria-checked={markVisibility === 'areas' ? 'mixed' : markVisibility === 'notes'} checked={markVisibility === 'notes'} ref={input => { if (input) input.indeterminate = markVisibility === 'areas'; }} onChange={cycleMarkVisibility} />{markVisibility === 'none' ? t("Sin marcas") : markVisibility === 'areas' ? t("Con marcas") : t("Con indicaciones")}</label><label className="consent" title={t("Ocultar inicio, fin, fechas, horas y agrupar consultas internas. El JSON conserva todos los datos.")}><input type="checkbox" aria-label={t("Ocultar inicio, fin, fechas y horas")} checked={compact} onChange={event => changeCompact(event.target.checked)} />{t("Vista simple")}</label>{selectedStep && <button type="button" className="text-button" onClick={() => setSelectedStepId(null)}>{t("Todos los pasos")}</button>}</div>
          <RecordingQualityNotice source={snapshot} locale={locale} />
          <ol className="recording-timeline" aria-label={t("Pasos de la grabación")}>{visibleSteps.map((step, index) => {
            const mark = sessionMarks.find(item => !item.pending && item.id === step.targetId), note = mark?.note || step.notes;
            return <li key={step.id} data-step-id={step.id} data-annotation-id={mark?.id} style={mark ? markStyle(markColor(mark)) : undefined}>
              <div className="recording-step-row"><button className="recording-step" type="button" aria-pressed={selectedStepId === step.id} onClick={() => setSelectedStepId(selectedStepId === step.id ? null : step.id)}><span>{index + 1}</span><strong>{mark ? t("Marca {number}", { number: sessionMarks.indexOf(mark) + 1 }) : step.label}</strong>{!compact && <time dateTime={step.at}>{new Date(step.at).toLocaleTimeString(dateLocale(locale), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>}</button><button type="button" className="icon-button" aria-label={t("Quitar paso {number}", { number: index + 1 })} title={t("Quitar paso {number}", { number: index + 1 })} disabled={busy} onClick={() => void run(() => removeRecordedStep(step.id))}><Icon name="trash" /></button></div>
              {mark ? <MarkContext mark={mark} locale={locale} /> : <small>{step.pathname}</small>}
              {note && <p>{note}</p>}
              {(selectedStepId === step.id || !selectedStepId) && presentedQueries.filter(event => event.stepId === step.id).map(event => <div className="recording-network" key={event.id}><NetworkEvent event={event} locale={locale} /></div>)}
            </li>;
          })}{unlinkedMarks.map((mark, index) => <li key={mark.id} data-annotation-id={mark.id} style={markStyle(markColor(mark))}>
            <div className="recording-step-row"><div className="recording-step"><span>{visibleSteps.length + index + 1}</span><strong>{t("Marca")} {sessionMarks.indexOf(mark) + 1}</strong>{!compact && <time dateTime={mark.createdAt}>{new Date(mark.createdAt).toLocaleTimeString(dateLocale(locale), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>}</div><button type="button" className="icon-button" aria-label={t("Quitar marca {number}", { number: sessionMarks.indexOf(mark) + 1 })} title={t("Quitar marca")} disabled={busy} onClick={() => void run(() => removeMark(mark.id))}><Icon name="trash" /></button></div>
            <MarkContext mark={mark} locale={locale} />{mark.note && <p>{mark.note}</p>}
          </li>)}</ol>
          {!selectedStep && presentedQueries.filter(event => !event.stepId || !visibleStepIds.has(event.stepId)).map(event => <div className="recording-network" key={event.id}><NetworkEvent event={event} locale={locale} /></div>)}
          {!selectedStep && internalQueries.length > 0 && <details className="recording-internal-queries"><summary>{t("Consultas internas")} · {internalQueries.length}</summary>{internalQueries.map(event => <div className="recording-network" key={event.id}><NetworkEvent event={event} locale={locale} /></div>)}</details>}
          {snapshot?.partial.isPartial && <p className="subtle error">{t("Registro parcial")}: {snapshot.partial.reasons.map(reason => t(reason)).join(' · ')}</p>}
          {selectedStep && <p className="subtle">{t("Mostrando solo {target}. La aplicación sigue en su estado actual.", { target: selectedStep.targetId ? t("esta marca") : t("este paso") })}</p>}
        </> : view === 'documents' ? <>
          {wikiError && <p role="alert">{wikiError}</p>}
          {(context?.context.knowledge?.documents.length || context?.context.rules.length) ? <h3>{t('Archivos locales')}</h3> : null}
          {(context?.context.knowledge?.documents.length || context?.context.rules.length) ? <ul className="recording-document-list">{[false, true].map(scoped => {
            const documents = [...(context?.context.knowledge?.documents.filter(document => Boolean(document.routes) === scoped) ?? []),
              ...(!scoped && context?.context.rules.length ? [{ id: 'project-rules', label: t('Reglas del proyecto'), content: context.context.rules.join('\n\n') }] : [])];
            return documents.length ? <Fragment key={String(scoped)}>
              <li className="document-group" role="presentation">{t(scoped ? 'Esta página' : 'General')}</li>
              {documents.map(document => {
                const href = documentHref(document.id);
                return <li key={document.id}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{document.label}</a> : <span>{document.label}</span>}<button type="button" className="icon-button" aria-label={t("Copiar {label}", { label: document.label })} title={t("Copiar documento")} disabled={busy} onClick={() => void run(() => copyText(document.content))}><Icon name="copy" /></button></li>;
              })}
            </Fragment> : null;
          })}
          </ul> : null}
          {wiki && <><h3>{t('Wiki')}</h3><WikiDocuments wiki={wiki} locale={locale} pathname={window.location.pathname} copy={text => run(() => copyText(text))} /></>}
          {!wiki && !wikiError && !context?.context.knowledge?.documents.length && !context?.context.rules.length && <p className={t("empty")}>{t("Este proyecto todavía no configuró documentos.")}</p>}
        </> : view === 'import' ? showWikiImport && wiki ? <>
          <WikiRecordingPicker key={wiki.manageUrl} wiki={wiki} locale={locale} disabled={busy || recording} onChoose={item => void run(() => chooseWikiRecording(item))} />
          <div className="recording-import-alternative"><button type="button" className="text-button" disabled={busy} onClick={() => { setImportSource('json'); setError(''); }}>{t('Importar JSON')}</button></div>
        </> : <form className="recording-import" onSubmit={event => { event.preventDefault(); void run(() => pasteRecording()); }}>
          {wiki?.manageUrl && <button type="button" className="text-button" disabled={busy} onClick={() => { setImportSource('wiki'); setError(''); }}><Icon name="back" />{t('Grabaciones del proyecto')}</button>}
          <p className="subtle">{t("Pegá el JSON de otra grabación. Conserva marcas, pasos y consultas; crea una copia con fechas actuales.")}</p>
          <label className="field">{t("JSON de la grabación")}<textarea rows={9} value={importText} maxLength={RECORDING_JSON_MAX_CHARACTERS} spellCheck={false} autoComplete="off" onChange={event => { setImportText(event.target.value); setError(''); }} placeholder={'{ "schemaVersion": "1.1", … }'} /></label>
          <button className="primary" type="submit" disabled={busy || recording || !importText.trim()}>{t("Importar grabación")}</button>
        </form> : <p className={t("empty")}>{t("Comenzá una grabación para registrar el recorrido.")}</p>}
        {message && <p className="subtle" role="status">{t(message)}</p>}{fallback && <label className="field">{fallbackFormat}<textarea readOnly rows={8} value={fallback} onFocus={event => event.currentTarget.select()} /></label>}
      </div>{error && <p className="panel-error" role="alert">{t(error)}</p>}
    </section>}
    <div className="recording-controls" ref={dock} data-corner={placedCorner} data-expanded={expandedDock} data-compressed={dockPlacement?.compressed ?? false} data-pinned={dockPreferences.pinned} data-recording={recording} data-panel-open={open} role="toolbar" aria-label="Toolkit"
      style={dockPlacement ? { left: dockPlacement.x, right: 'auto', top: dockPlacement.y + (placedCorner.startsWith('top') ? 0 : 48), bottom: 'auto', transform: placedCorner.startsWith('top') ? 'none' : 'translateY(-100%)', maxHeight: Math.max(48, dockPlacement.viewportHeight - 24) } : undefined}
      onPointerEnter={event => { if (event.pointerType === 'mouse') { cancelDockLeave(); setDockHover(true); } }}
      onPointerMove={event => { if (event.pointerType === 'mouse') { cancelDockLeave(); if (!dockHover) setDockHover(true); } }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') leaveDock(); }}
      onPointerDownCapture={event => { dockPointerFocus.current = true; dockTouchReveal.current = event.pointerType !== 'mouse' && !dockExpanded && !dockPlacement?.compressed; setDockFocused(false); if (event.pointerType !== 'mouse') { cancelDockLeave(); setDockTouchOpen(true); } }}
      onKeyDownCapture={() => { dockPointerFocus.current = false; setDockFocused(true); }}
      onFocusCapture={() => { cancelDockLeave(); if (!dockPointerFocus.current) setDockFocused(true); }}
      onBlurCapture={() => queueMicrotask(() => { const focus = root.activeElement; if (!focus || !dock.current?.contains(focus)) setDockFocused(false); })}>
      <div className="recording-reveal" aria-hidden={!expandedDock} inert={!expandedDock}>
      <div className="recording-stack" aria-label={t("Grabaciones guardadas")}>{recordingItems.map((item, index) => <div className="recording-stack-item" key={item.sessionId ?? item.id} data-recording-id={item.sessionId ?? item.id}><button type="button" className="recording-bubble" data-tone={index % 3} aria-label={t("Abrir grabación: {title}", { title: recordingTitle(item.title, compact, locale) })} title={compact ? t("Grabación") : `${item.title} · ${new Date(item.updatedAt).toLocaleString(dateLocale(locale), { hour12: false })}`} disabled={busy || recording} aria-description={t("{count} pasos", { count: compact ? item.contentStepCount : item.stepCount })} onClick={() => void run(() => item.sessionId === session?.id ? openCurrentRecording() : openRecording(item.id))}><Icon name="record" /><span className="recording-number" aria-hidden="true">{compact ? item.contentStepCount : item.stepCount}</span></button><button type="button" className="bubble-discard" aria-label={t("Descartar grabación: {title}", { title: recordingTitle(item.title, compact, locale) })} title={t("Descartar grabación")} disabled={busy} onClick={() => void run(() => deleteRecording(item.id))}><Icon name="close" /></button></div>)}
        <button type="button" className="recording-bubble recording-import-badge" aria-label={t(wiki?.manageUrl ? 'Agregar grabación' : 'Pegar grabación')} title={t(wiki?.manageUrl ? 'Agregar grabación' : 'Pegar grabación JSON')} disabled={busy || recording} onClick={showImport}><Icon name="plus" /></button>
      </div>
      {recordingItems.length > 0 && <div className="recording-divider" aria-hidden="true" />}
      <div className="recording-secondary">{recording && <><button type="button" ref={selectButton} className="recording-small" aria-label={t("Seleccionar")} title={t("Seleccionar zonas para comentar")} aria-pressed={selecting} disabled={busy} onClick={() => void run(toggleSelection)}><Icon name="select" /></button></>}<button type="button" className="recording-small recording-network-toggle" aria-label={t("Grabar tráfico de red")} aria-pressed={recordNetwork} title={recordNetwork ? t("Red habilitada: registra peticiones durante la grabación") : t("Red desactivada: no registra peticiones")} disabled={busy || props.activity === false} onClick={() => void run(changeNetworkRecording)}><Icon name={recordNetwork ? 'network' : 'network-off'} /></button>
        <button type="button" ref={launcher} className="recording-small" aria-label={t("Documentos")} title={t("Documentos del proyecto")} aria-expanded={open && view === 'documents'} aria-controls={`${id}-panel`} onClick={() => void run(showDocuments)}><Icon name="guide" /></button>
      </div>
      </div>
      <div className="recording-island-anchor">
      <div className="recording-island" data-recording={recording}>
      <button type="button" className="recording-main" data-recording={recording} aria-label={recording ? t("Detener grabación") : t("Comenzar grabación")} title={recording ? t("Detener grabación") : t("Comenzar grabación")} disabled={busy || props.activity === false} onClick={() => { if (dockTouchReveal.current) { dockTouchReveal.current = false; return; } void run(record); }}>
        {recording ? <><span className="recording-dot" aria-hidden="true" /><span className="recording-timer" role="timer" aria-live="off" aria-label={t("Tiempo de grabación")}>{timer}</span><span className="recording-stop" aria-hidden="true"><span /></span></> : <><span className="recording-placeholder" aria-hidden="true">--:--</span><Icon name="record" /></>}
      </button>
      </div>
      <div className="recording-dock-actions" aria-hidden={!showDockActions} inert={!showDockActions}>
        <button type="button" className="recording-dock-action" aria-hidden={!showDockActions} inert={!showDockActions} aria-label={dockPreferences.pinned ? t("Desfijar herramientas") : t("Fijar herramientas")} title={dockPreferences.pinned ? t("Desfijar herramientas") : t("Fijar herramientas")} aria-pressed={dockPreferences.pinned} onClick={() => changeDockPreferences({ pinned: !dockPreferences.pinned })}><Icon name={dockPreferences.pinned ? 'pin-off' : 'pin'} /></button>
        <button type="button" ref={positionTrigger} className="recording-dock-action" aria-label={t("Cambiar posición")} title={t("Cambiar posición")} aria-haspopup="menu" aria-expanded={positionMenuOpen} aria-controls={`${id}-position-menu`} onClick={togglePositionMenu}><Icon name="move" /></button>
      </div>
      </div>
      {positionMenuOpen && <div className="recording-position-menu" ref={positionMenu} style={dockPlacement ? { maxHeight: dockPlacement.menuMaxHeight } : undefined} id={`${id}-position-menu`} role="menu" aria-label={t("Posición de la toolbar")} onKeyDown={event => {
        const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']; if (!keys.includes(event.key)) return;
        event.preventDefault(); const items = Array.from(positionMenu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"],[role="menuitem"]') ?? []);
        const current = items.findIndex(item => item === root.activeElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length;
        items[next]?.focus({ preventScroll: true }); items[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }}>{toolbarCorners.map(item => <button type="button" key={item.value} role="menuitemradio" aria-checked={dockPreferences.corner === item.value} onClick={() => chooseCorner(item.value)}>{t(item.label)}</button>)}<button type="button" role="menuitem" className="recording-hide" disabled={busy} onClick={() => void run(async () => {
        if (editingId) await finishMark(!activeMark?.note.trim());
        if (recording) await operation('stopRecording');
        persistMarks(); props.onDismiss();
      })}>{t('Ocultar hasta recargar')}</button></div>}
    </div>
    {!open && !editingId && (message || error) && <div className={`toast${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>{t(error || message)}</div>}
  </div>, root);
}

function MarkContext({ mark, locale }: { mark: AnnotationContext; locale: ToolbarLocale }) {
  const t = createTranslator(locale);
  const position = mark.element ? annotationPosition(document, mark) : null;
  return <><small>{mark.label}</small><small>{recordedRoute(mark.context, mark.pathname)} · Viewport {mark.viewport.width > 0 && mark.viewport.height > 0 ? `${mark.viewport.width}×${mark.viewport.height}` : t("no registrado")}</small>
    {position && position.status !== 'matched' && <small data-position={position.status}>{t(position.status === 'ambiguous' ? 'Referencia ambigua' : 'Posición histórica')}</small>}
    {mark.element?.source && <small>{mark.element.source}</small>}
    {mark.kind === 'group' && <details className="recording-group-members"><summary>{t('{count} elementos seleccionados', { count: mark.elementCount ?? mark.relatedElements.length })}</summary><ul>{mark.relatedElements.map((element, index) => <li key={index}>{element.accessibleName || element.text || element.tag}<small>{element.selector ?? element.locator?.value ?? element.tag}</small></li>)}</ul>{(mark.elementCount ?? 0) > mark.relatedElements.length && <small>{t('Se guardaron {shown} referencias de {total} elementos.', { shown: mark.relatedElements.length, total: mark.elementCount! })}</small>}</details>}</>;
}

function NetworkEvent({ event, locale }: { event: ReviewEvent; locale: ToolbarLocale }) {
  const t = createTranslator(locale);
  const observed = event as ReviewEvent & { requestBody?: Body; responseBody?: Body; simulation?: 'slow' | 'offline' };
  const diagnostic = flightErrorDiagnostic(event);
  const outcomes = { pending: t("En curso"), success: t("Completada"), http_error: t("Error HTTP"), network_error: t("Error de red"), aborted: t("Cancelada"), incomplete: t("Sin resultado registrado") };
  return <details className="recording-query" open={event.outcome !== 'success' || diagnostic}><summary><strong>{event.method ?? 'OTHER'} {recordingResource(event, t)} · {event.status ? `HTTP ${event.status}` : event.outcome ? outcomes[event.outcome] : t("Sin resultado")}</strong></summary><small>{event.durationMs == null ? '' : `${event.durationMs} ms`}{observed.simulation ? ` · ${t("Simulación")}: ${observed.simulation === 'slow' ? t("red lenta") : t("sin conexión")}` : ''}{diagnostic ? ` · ${t('diagnóstico de error Flight en la vista previa')}` : ''}</small>
    {([['requestBody', t("Payload")], ['responseBody', t("Respuesta")]] as const).map(([key, label]) => { const body = observed[key]; if (!body) return null;
      if (body.status === 'omitted' && body.reason === 'empty') return null;
      return <details className="network-body" key={key}><summary>{label}{body.status === 'truncated' ? ` · ${t('Truncado · límite {count}', { count: body.charLimit })}` : body.status === 'omitted' ? ` · ${t('Omitido')}` : ''}{body.redacted ? ` · ${t('Datos ocultos')}` : ''}</summary>{body.text && <pre tabIndex={0}>{body.text}</pre>}{body.reason && <p className="subtle">{t(activityBodyReason(body.reason))}</p>}{body.status === 'truncated' && <p className="subtle">{t("Se conservaron hasta {count} caracteres.", { count: body.charLimit })}</p>}</details>; })}
  </details>;
}
