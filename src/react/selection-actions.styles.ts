export const selectionActionsStyles = String.raw`
.selection-actions {
  position: fixed;
  right: 20px;
  bottom: max(78px, calc(env(safe-area-inset-bottom) + 60px));
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 12px;
  border-radius: 12px;
  box-sizing: border-box;
  max-height: calc(100dvh - 102px);
  overflow-y: auto;
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 8px 28px #0004;
}
.selection-actions-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 12px;
}
.selection-actions-head > svg {
  color: var(--accent);
}
.selection-actions-identity {
  min-width: 0;
  flex: 1;
}
.selection-actions-identity strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
}
.selection-actions-identity > span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11px;
}
.selection-actions-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
}
.selection-actions-clear:hover:not(:disabled) {
  background: var(--raised);
  color: var(--ink);
}
.selection-actions-evidence {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.selection-actions-evidence img {
  display: block;
  width: 48px;
  height: 36px;
  flex: none;
  object-fit: contain;
  border-radius: 4px;
  background: #161719;
}
.selection-actions-evidence > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-size: 11px;
}
.selection-actions-evidence > span svg {
  width: 14px;
  height: 14px;
  color: var(--accent);
}
.selection-actions-primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  min-height: 36px;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #12271c;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
}
.selection-actions-primary:hover:not(:disabled) {
  background: #cbf0db;
}
.selection-actions-primary svg {
  width: 16px;
  height: 16px;
}
.selection-note { display: grid; gap: 6px; margin-bottom: 10px; color: var(--muted); font-size: 11px; }
.selection-note textarea { box-sizing: border-box; width: 100%; min-height: 58px; max-height: 160px; padding: 8px 10px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; background: var(--field); color: var(--ink); font: inherit; font-size: 12px; line-height: 1.5; }
.selection-note textarea::placeholder { color: var(--placeholder, #a7aaaf); }
.selection-actions-tools { display: flex; gap: 6px; margin-top: 6px; }
.selection-actions-tools button { display: inline-flex; justify-content: center; align-items: center; gap: 5px; flex: 1; min-height: 32px; padding: 5px 6px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font-size: 11px; }
.selection-actions-tools button:hover:not(:disabled) { background: var(--raised); color: var(--ink); }
.selection-actions-tools svg { width: 14px; height: 14px; }
.selection-actions-status { margin: 5px 0 0; padding: 5px 2px 0; color: var(--muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.selection-actions-status[data-error="true"] { color: var(--danger, #ffb8b8); }
.selection-note textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.selection-actions button:disabled, .selection-note textarea:disabled { opacity: .55; cursor: default; }
.selection-modes { display: flex; flex-wrap: wrap; justify-content: center; gap: 3px; min-width: 0; }
.selection-modes button { min-height: 32px; padding: 5px 9px; border: 0; border-radius: 8px; color: var(--muted); background: transparent; font: inherit; font-size: 12px; }
.selection-modes button[aria-pressed="true"] { color: var(--ink); background: var(--raised); }
.selection-modes button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.annotation-pin { position: fixed; z-index: 3; display: grid; place-items: center; min-width: 24px; height: 24px; padding: 0 4px; border: 0; border-radius: 50%; background: var(--accent); color: #12271c; box-shadow: 0 2px 6px #0003; font-size: 11px; font-weight: 600; cursor: pointer; }
.annotation-pin[aria-pressed="true"] { outline: 2px solid var(--inspector-border, #3d8660); outline-offset: 2px; }
.annotation-pin:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
.annotation-region { position: fixed; pointer-events: none; border: 1px dashed var(--accent); box-sizing: border-box; background: #b7e6cc0a; }
.annotation-list { display: grid; gap: 0; padding: 0; margin: 0; list-style: none; }
.annotation-list li { padding: 10px 0; border-bottom: 1px solid var(--line); }
.annotation-list button { text-align: left; }
.annotation-list p { margin: 5px 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
@media (max-width: 600px) { .inspector-banner { flex-wrap: wrap; justify-content: center; width: max-content; max-width: calc(100vw - 24px); box-sizing: border-box; } .inspector-banner > span { flex-basis: 100%; text-align: center; font-size: 11px; } }
.selection-actions-context {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  margin-top: 4px;
  padding: 5px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
}
.selection-actions-context:hover:not(:disabled) {
  background: var(--raised);
  color: var(--ink);
}
.selection-actions-context svg {
  width: 13px;
  height: 13px;
}
.selection-actions button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.shell[data-corner$=left] > .selection-actions {
  right: auto;
  left: 20px;
}
.shell[data-corner^=top] > .selection-actions {
  top: max(78px, calc(env(safe-area-inset-top) + 60px));
  bottom: auto;
}
@media (max-width: 480px) {
  .selection-actions {
    right: 12px;
    bottom: max(74px, calc(env(safe-area-inset-bottom) + 60px));
  }
  .shell[data-corner$=left] > .selection-actions {
    left: 12px;
  }
  .shell[data-corner^=top] > .selection-actions {
    top: max(74px, calc(env(safe-area-inset-top) + 60px));
  }
}
@media (prefers-contrast: more) {
  .selection-actions {
    outline: 1px solid var(--line);
  }
}
`;
