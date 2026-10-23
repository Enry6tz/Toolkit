import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icons.js';
import { markStyle } from './mark-colors.js';
import { createTranslator, resolveLocale } from '../core/locale.js';
import type { ToolbarLocale } from '../core/locale.js';
export interface SelectionActionsProps {
  locale?: ToolbarLocale;
  name: string; tag: string; busy: boolean; note: string; pending: boolean;
  position?: string; status?: string; error?: string;
  color: string;
  onNoteChange(value: string): void; onDone(): void; onCancel(): void; onClear(): void;
  anchor?: { x: number; y: number; width: number; height: number } | undefined;
}
/** A note sits beside the mark; saving returns to the same selection mode. */
export function SelectionActions(props: SelectionActionsProps) {
  const t = createTranslator(resolveLocale(props.locale));
  const field = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null), lastAnchor = useRef(props.anchor);
  if (props.anchor) lastAnchor.current = props.anchor;
  const [height, setHeight] = useState(220);
  useLayoutEffect(() => {
    const node = panel.current; if (!node) return;
    const measure = () => setHeight(node.getBoundingClientRect().height);
    measure(); const observer = new ResizeObserver(measure); observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!props.busy) field.current?.focus({ preventScroll: true }); }, [props.busy]);
  const width = Math.min(300, innerWidth - 24), anchor = lastAnchor.current;
  // Keep the chosen side while scrolling; flipping above/below on each frame makes writing jump.
  const below = useRef(anchor ? anchor.y + anchor.height + 230 < innerHeight : true).current;
  const left = anchor ? Math.max(12, Math.min(innerWidth - width - 12, anchor.x + Math.min(anchor.width, 160))) : undefined;
  const top = anchor ? Math.max(12, Math.min(innerHeight - height - 12, below ? anchor.y + anchor.height + 10 : anchor.y - height - 10)) : undefined;
  return <section ref={panel} className="selection-actions" aria-label={t("Comentario de la marca")} aria-busy={props.busy}
    style={{ ...markStyle(props.color), ...(anchor ? { left, top, width, right: 'auto', bottom: 'auto' } : {}) }}>
    <header className="selection-actions-head"><Icon name="select" /><div className="selection-actions-identity"><strong title={props.name}>{props.name || t("Zona seleccionada")}</strong><span>{props.position} · {props.tag}</span></div>
      <button type="button" className="selection-actions-clear" aria-label={props.pending ? t("Cancelar marca") : t("Cerrar nota")} title={props.pending ? t("Cancelar marca") : t("Cerrar nota")} disabled={props.busy} onClick={props.pending ? props.onCancel : props.onDone}><Icon name="close" /></button></header>
    <label className="selection-note">{t("Tu observación")}<textarea ref={field} rows={3} maxLength={2000} value={props.note} disabled={props.busy}
      onChange={event => props.onNoteChange(event.currentTarget.value)} placeholder={t("Escribí lo que querés señalar…")}
      onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' && !event.shiftKey && props.note.trim()) { event.preventDefault(); props.onDone(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.pending ? props.onCancel() : props.onDone(); } }} /></label>
    <div className="selection-note-actions"><button type="button" className="selection-save" aria-label={t("Guardar marca")} title={t("Guardar marca · Enter")} disabled={props.busy || !props.note.trim()} onClick={props.onDone}><Icon name="check" /></button>
      {!props.pending && <button type="button" className="selection-actions-clear" aria-label={t("Quitar marca")} title={t("Quitar marca")} disabled={props.busy} onClick={props.onClear}><Icon name="trash" /></button>}</div>
    {(props.status || props.error) && <p className="selection-actions-status" data-error={Boolean(props.error)} role={props.error ? 'alert' : 'status'}>{t(props.error || props.status || '')}</p>}
  </section>;
}
