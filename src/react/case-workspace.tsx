import { useEffect, useState } from 'react';
import type { ReviewCaseMode, ReviewCaseOriginal, ReviewSnapshot } from '../review/types.js';
import { Icon } from './icons.js';

export const caseModes = [
  { mode: 'test', label: 'Probar', question: '¿Qué querés comprobar?', description: 'Comprobá una funcionalidad.' },
  { mode: 'design', label: 'Mejorar diseño', question: '¿Qué querés crear o mejorar?', description: 'Proponé una funcionalidad o mejorá una pantalla.' },
  { mode: 'report', label: 'Reportar', question: '¿Qué pasó?', description: 'Contá un problema y cómo aparece.' },
] as const;

const empty: ReviewCaseOriginal = { title: '', detail: '', steps: [], expected: '', additionalContext: '' };
const stepsFrom = (text: string) => text.split('\n').map(line => line.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean).slice(0, 50);
export interface CaseDraft { original: ReviewCaseOriginal; stepText: string }

interface Props {
  snapshot: ReviewSnapshot | undefined;
  newMode: ReviewCaseMode | 'choose' | null;
  busy: boolean;
  recording: boolean;
  captureConnected: boolean;
  canRecord: boolean;
  timer: string;
  getDraft: (key: string, fallback: CaseDraft) => CaseDraft;
  onDraftChange: (key: string, value: CaseDraft) => void;
  onChoose: (mode: ReviewCaseMode) => void;
  onCancelNew: () => void;
  onStart: (mode: ReviewCaseMode, original: ReviewCaseOriginal) => Promise<void>;
  onSelect: () => void;
  onRecord: () => void;
  includeProjectContext: boolean;
  onIncludeProjectContextChange: (value: boolean) => void;
  onCopy: (original: ReviewCaseOriginal) => Promise<void>;
  onExport: (original: ReviewCaseOriginal) => Promise<void>;
}

/** One editable case. Refinement belongs to the user's chat. */
export function CaseWorkspace(props: Props) {
  const current = props.snapshot?.case;
  const starting = props.newMode !== null || !current;
  const mode = caseModes.find(item => item.mode === (props.newMode === 'choose' ? 'test' : props.newMode ?? current?.mode ?? 'test'))!;
  const draftKey = starting ? `new-${mode.mode}` : current.id;
  const initial = () => props.getDraft(draftKey, { original: starting ? { ...empty, steps: [] } : current.original, stepText: starting ? '' : current.original.steps.join('\n') });
  const [draft, setDraft] = useState<ReviewCaseOriginal>(() => initial().original);
  const [stepText, setStepText] = useState(() => initial().stepText);
  useEffect(() => {
    const saved = initial();
    setDraft(saved.original); setStepText(saved.stepText);
  }, [draftKey]);
  function change(key: keyof ReviewCaseOriginal, value: string) {
    if (key === 'steps') setStepText(value);
    const next = { ...draft, [key]: key === 'steps' ? stepsFrom(value) : value };
    setDraft(next);
    props.onDraftChange(draftKey, { original: next, stepText: key === 'steps' ? value : stepText });
  }
  return <section className="case-workspace" aria-label="Caso actual">
    {starting ? <form onSubmit={event => { event.preventDefault(); void props.onStart(mode.mode, draft); }}>
      <div className="case-mode-selector" role="group" aria-label="Tipo de caso">{caseModes.map(item => <button
        type="button" key={item.mode} aria-pressed={mode.mode === item.mode} disabled={props.busy}
        onClick={() => props.onChoose(item.mode)}>{item.label}</button>)}</div>
      <label className="field">Título<input autoFocus required maxLength={200} value={draft.title} onChange={event => change('title', event.target.value)} placeholder="Un nombre breve para este caso" /></label>
      <label className="field">{mode.question}<textarea required rows={3} maxLength={4000} value={draft.detail} onChange={event => change('detail', event.target.value)} placeholder={mode.mode === 'design' ? 'Contá la idea o la mejora que querés lograr.' : 'Contalo con tus palabras.'} /></label>
      <button className="primary" disabled={props.busy || props.recording || !draft.title.trim() || !draft.detail.trim()} type="submit">Comenzar caso<Icon name="arrow" /></button>
      {props.recording && <p className="subtle">Detené la grabación antes de comenzar otro caso.</p>}
      {current && <button type="button" className="text-button muted" onClick={props.onCancelNew}>Volver al caso actual</button>}
      <p className="subtle case-start-note">Sin iniciar grabaciones ni capturas.</p>
    </form> : <form onSubmit={event => { event.preventDefault(); void props.onCopy(draft); }}>
      <div className="case-identity"><span>{mode.label}</span>{props.recording && <span>Grabando</span>}</div>
      <h3>{draft.title}</h3><p className="case-description">{draft.detail}</p>
      <details><summary>Editar título y descripción</summary>
        <label className="field">Título<input required maxLength={200} value={draft.title} onChange={event => change('title', event.target.value)} /></label>
        <label className="field">{mode.question}<textarea rows={3} maxLength={4000} value={draft.detail} onChange={event => change('detail', event.target.value)} /></label>
      </details>
      <label className="field">{mode.mode === 'design' ? 'Cómo debería funcionar' : 'Cómo reproducirlo'}<textarea rows={3} maxLength={12000} value={stepText} onChange={event => change('steps', event.target.value)} placeholder={mode.mode === 'design' ? 'Describí el recorrido o los cambios que buscás.' : 'Un paso por línea. También podés grabar el recorrido.'} /></label>
      <div className="case-tools" role="group" aria-label="Agregar evidencia al caso">
        <button type="button" className="secondary" disabled={props.busy} onClick={props.onSelect}><Icon name="select" />Seleccionar</button>
        <button type="button" className={`secondary${props.recording ? ' error' : ''}`} disabled={props.busy || !props.canRecord} onClick={props.onRecord}><Icon name={props.recording ? 'stop' : 'record'} />{props.recording ? `Detener · ${props.timer}` : 'Grabar recorrido'}</button>
      </div>
      {props.recording && <p className="subtle" role="status">{`Grabando acciones${props.captureConnected ? ' e imágenes de inicio y fin' : ', sin capturas automáticas'}.`}</p>}
      <label className="field">Comportamiento esperado<textarea rows={3} maxLength={4000} value={draft.expected} onChange={event => change('expected', event.target.value)} placeholder="Qué debería ocurrir. Podés revisarlo con tu chat." /></label>
      <details><summary>Contexto adicional</summary><label className="field">Información que ayude a entender el caso<textarea rows={3} maxLength={4000} value={draft.additionalContext} onChange={event => change('additionalContext', event.target.value)} /></label></details>
      <div className="case-next">
        <label className="consent"><input type="checkbox" checked={props.includeProjectContext} disabled={props.busy} onChange={event => props.onIncludeProjectContextChange(event.target.checked)} /><span>Incluir contexto del proyecto</span></label>
        <p className="subtle case-context-help">Agrega reglas, dominio y documentos.</p>
        <button className="primary" type="submit" disabled={props.busy || !draft.title.trim()}><Icon name="copy" />{props.recording ? 'Detener y copiar MD' : 'Copiar MD'}</button>
        <button className="secondary case-download" type="button" disabled={props.busy || !draft.title.trim()} onClick={() => void props.onExport(draft)}><Icon name="download" />{props.recording ? 'Detener y descargar evidencias' : 'Descargar evidencias'}</button>
        <p className="subtle case-start-note">Refiná el texto en tu chat.</p>
      </div>
    </form>}
  </section>;
}
