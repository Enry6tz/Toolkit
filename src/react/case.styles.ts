export const caseStyles = String.raw`
:host{
  position:fixed;inset:0 auto auto 0;width:0;height:0;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;
  color-scheme:dark;
  --surface:rgba(13,14,17,.94);--raised:rgba(25,27,32,.94);--ink:#fafafa;--muted:#c5c7ce;
  --line:rgba(255,255,255,.22);--field:#181a1f;--placeholder:#a1a4ae;
  --accent:#ff7048;--danger:#ffd49a;--inspector-border:#ff7048;
  --record-font:"AI Context Cascadia Code","Cascadia Code",ui-monospace,SFMono-Regular,Consolas,monospace;
}
  .annotation-region[data-position="historical"]{border-style:dotted;opacity:.55}
  .panel,.selection-actions,.inspector-banner,.annotation-pin{pointer-events:auto}
  .recording-document-list>.document-group{padding:14px 0 5px;border:0;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em}
  .recording-position-menu>.recording-hide{margin-top:5px;border-top:1px solid var(--line);padding-top:10px}
.shell{color:var(--ink)}
button:disabled{cursor:default;opacity:.5}
button:hover:not(:disabled){color:var(--ink)}
.icon-button{color:var(--muted)}
.icon-button:hover:not(:disabled),.secondary:hover:not(:disabled){background:rgba(255,255,255,.09)}
.primary,.selection-save{background:var(--mark-color,var(--accent));color:#08090b}
.primary:hover:not(:disabled),.selection-save:hover:not(:disabled){background:var(--mark-color,var(--accent));color:#08090b;filter:brightness(1.12)}
.field input,.field textarea,.field select,.selection-note textarea{background:var(--field);color:var(--ink);border-color:var(--line);caret-color:var(--accent)}
.field input::placeholder,.field textarea::placeholder,.selection-note textarea::placeholder{color:var(--placeholder)}
.field input:hover,.field textarea:hover,.field select:hover{border-color:#8d949f}
.field input:focus,.field textarea:focus,.selection-note textarea:focus{border-color:var(--accent);background:#1c1f25}
.field input,.field textarea{font-size:13px}
.panel,.selection-actions,.inspector-banner,.toast,.annotation-comment{
  background:var(--surface);border:1px solid var(--line);color:var(--ink);
  backdrop-filter:blur(24px) saturate(1.25);-webkit-backdrop-filter:blur(24px) saturate(1.25);
  box-shadow:0 10px 30px #08090b26;
}
.panel-head h2{font-size:13px;line-height:1.4;font-weight:500;letter-spacing:-.02em;overflow-wrap:anywhere}
.panel-body{padding-top:10px}
.panel-error,.toast.error{color:var(--danger);background:#3b3026}
.panel-error{flex-shrink:0}
.subtle,summary{color:var(--muted)}
.error{color:var(--danger)!important}
summary:hover{color:var(--ink)}
.text-button{color:var(--accent)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#181b20;color:#e2e5ec;max-height:300px;overflow:auto;font-size:11px;line-height:1.6;padding:12px;border-radius:8px}
::selection{background:var(--accent);color:#08090b}
::-webkit-scrollbar{width:7px;height:7px}
::-webkit-scrollbar-thumb{background:#7e8490;border:2px solid transparent;background-clip:padding-box;border-radius:8px}
.recording-controls{
  position:fixed;right:20px;bottom:max(18px,env(safe-area-inset-bottom));display:flex;flex-direction:column;
  align-items:center;gap:6px;max-height:calc(100dvh - 36px);width:204px;pointer-events:none;z-index:7;
}
.recording-controls button{pointer-events:auto}
.recording-controls[data-corner$=left]{right:auto;left:20px}
.recording-controls[data-corner^=top]{bottom:auto;top:max(18px,env(safe-area-inset-top));flex-direction:column-reverse}
.recording-reveal{
  display:flex;flex-direction:column;align-items:center;gap:6px;min-height:0;flex-shrink:1;width:204px;
  opacity:0;visibility:hidden;pointer-events:none;transform:translateY(48px) scale(.88);transform-origin:bottom center;
  clip-path:inset(100% -8px -8px -8px);transition:opacity 160ms ease-out,transform 280ms cubic-bezier(.16,1,.3,1),clip-path 280ms cubic-bezier(.16,1,.3,1),visibility 280ms;
}
.recording-controls[data-expanded=true] .recording-reveal{opacity:1;visibility:visible;transform:translateY(0) scale(1);clip-path:inset(-8px);pointer-events:auto}
.recording-controls[data-compressed=true] .recording-reveal{position:absolute;opacity:0;visibility:hidden;pointer-events:none}
.recording-controls[data-corner^=top] .recording-reveal{flex-direction:column-reverse;transform-origin:top center;transform:translateY(-48px) scale(.88);clip-path:inset(-8px -8px 100% -8px)}
.recording-controls[data-corner^=top][data-expanded=true] .recording-reveal{transform:translateY(0) scale(1);clip-path:inset(-8px)}
.recording-island-anchor{position:relative;display:flex;justify-content:center;flex:none;width:204px;height:48px;pointer-events:none}
.recording-island{
  display:flex;align-items:center;flex:none;width:112px;height:48px;border-radius:26px;background:#08090b;
  box-shadow:0 5px 18px #08090b30;overflow:hidden;pointer-events:auto;isolation:isolate;
  transition:width 240ms cubic-bezier(.16,1,.3,1);
}
.recording-controls[data-expanded=false][data-recording=true] .recording-island{width:128px}
.recording-controls[data-expanded=true] .recording-island{width:148px}
.recording-main{
  display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;width:112px;height:48px;padding:0 16px;
  border:0;border-radius:24px;background:transparent;color:#4ade80;
  transition:background-color 120ms ease-out,width 240ms cubic-bezier(.16,1,.3,1);
}
.recording-controls[data-expanded=false][data-recording=true] .recording-main{width:128px;padding:0 12px;gap:7px}
.recording-controls[data-expanded=true] .recording-main{width:148px}
.recording-main:hover:not(:disabled){background:#1c1c20;color:#4ade80}
.recording-main[data-recording=true],.recording-main[data-recording=true]:hover:not(:disabled){color:#f5f5f7}
.recording-main:active:not(:disabled){transform:none;background:#27282b}
.recording-main>svg{width:22px;height:22px;margin-left:auto}
.recording-dock-actions{position:absolute;inset:0;pointer-events:none;opacity:0;visibility:hidden;transition:opacity 140ms ease-out,visibility 140ms}
.recording-controls[data-expanded=true] .recording-dock-actions{opacity:1;visibility:visible}
.recording-controls[data-compressed=true] .recording-dock-actions{opacity:1;visibility:visible}
.recording-dock-action{position:absolute;right:0;top:0;display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:9px;background:transparent;color:#08090b}
.recording-dock-action:last-child{top:24px}
.recording-dock-action svg{width:14px;height:14px}
.recording-dock-action:last-child svg{width:16px;height:16px}
.recording-dock-action:hover:not(:disabled),.recording-dock-action[aria-pressed=true],.recording-dock-action[aria-expanded=true]{background:rgba(255,255,255,.65);color:#08090b}
.recording-controls[data-compressed=true] .recording-dock-action{background:var(--raised);color:var(--ink);border:1px solid var(--line)}
.recording-controls[data-compressed=true] .recording-dock-action[aria-pressed=true]{color:var(--accent)}
.recording-main:focus-visible{outline-offset:-4px}
.recording-dock-action:focus-visible{outline-offset:-2px}
  .recording-position-menu{position:absolute;right:0;bottom:57px;display:flex;flex-direction:column;gap:2px;width:204px;padding:6px;border:1px solid var(--line);border-radius:16px;background:rgba(24,26,30,.95);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);box-shadow:0 8px 24px #08090b26;pointer-events:auto;z-index:2;overflow:auto;overscroll-behavior:contain}
.recording-position-menu button{min-height:36px;border:0;border-radius:10px;padding:8px 12px;background:transparent;color:var(--muted);font-size:11px;line-height:1.5;text-align:left}
.recording-position-menu button:hover:not(:disabled),.recording-position-menu button[aria-checked=true]{background:rgba(255,255,255,.11);color:var(--ink)}
.recording-controls:has(.recording-position-menu) .recording-reveal{visibility:hidden;opacity:0;pointer-events:none}
.recording-controls[data-corner^=top] .recording-position-menu{top:57px;bottom:auto}
.recording-placeholder,.recording-timer{font-family:var(--record-font);font-size:14px;font-weight:500;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:.015em;white-space:nowrap}
.recording-placeholder{color:#a1a4ae;margin-right:auto}
.recording-timer{color:#ff5f57}
.recording-dot{width:9px;height:9px;flex:none;border-radius:50%;background:#ff453a;animation:recording-pulse 1400ms ease-in-out infinite}
@keyframes recording-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.recording-stop{display:grid;place-items:center;flex:none;width:28px;height:28px;border:1.5px solid #f5f5f7;border-radius:50%}
.recording-stop>span{width:10px;height:10px;background:#ff453a;border-radius:3px}
.recording-main:focus-visible,.recording-bubble:focus-visible,.recording-small:focus-visible,.bubble-discard:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.recording-stack{
  display:flex;flex-direction:column;align-items:center;align-self:center;gap:4px;width:204px;padding:5px 70px;
  max-height:calc(100dvh - 220px);overflow-y:auto;overflow-x:hidden;flex-shrink:1;scrollbar-width:none;pointer-events:auto;
}
.recording-controls[data-corner^=top] .recording-stack{flex-direction:column-reverse}
.recording-stack::-webkit-scrollbar{display:none}
.recording-stack:empty{display:none}
.recording-stack-item{position:relative;display:flex;align-items:center;justify-content:center;width:64px;min-height:30px;flex:none}
.recording-bubble,.recording-small,.bubble-discard{
  display:grid;place-items:center;padding:0;flex:none;border:1px solid var(--line);background:var(--raised);color:#e8ebf0;
  backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);box-shadow:0 3px 12px #08090b18;
}
.recording-bubble{display:flex;justify-content:center;gap:6px;width:64px;height:24px;border-radius:8px}
.recording-number{font-family:var(--record-font);font-size:10px;font-weight:500;line-height:1;font-variant-numeric:tabular-nums}
.recording-import-badge{background:rgba(8,9,11,.72);border-color:#ffffff55;min-height:24px;margin:3px 0}
.recording-controls[data-corner^=top] .recording-import-badge{order:-1}
.recording-import textarea{font-family:var(--record-font);font-size:11px;resize:vertical;min-height:120px}
.recording-import .primary{margin-top:12px}
.recording-import-alternative{margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}
.wiki-recording-list{padding:0;margin:0;list-style:none}
.wiki-recording-list>li+li{border-top:1px solid var(--line)}
.wiki-recording-choice{display:flex;align-items:center;gap:12px;width:100%;padding:14px 8px;border:0;border-radius:7px;background:transparent;text-align:start;color:var(--ink)}
.wiki-recording-choice:hover:not(:disabled){background:var(--raised)}
.wiki-recording-choice>svg:first-child{color:var(--accent)}
.wiki-recording-choice>svg:last-child{margin-inline-start:auto;color:var(--muted);width:14px;height:14px;flex:none}
.wiki-recording-choice>span{min-width:0;flex:1}
.wiki-recording-choice strong{display:block;font:500 12px/1.5 var(--record-font);overflow-wrap:anywhere}
.wiki-recording-choice small{margin-top:4px;font-size:10px;line-height:1.5;overflow-wrap:anywhere}
.wiki-recording-copy-note{margin-top:14px}
.wiki-recording-picker .text-button,.recording-import .text-button,.recording-import-alternative .text-button{min-height:32px;gap:7px}
.recording-import-label{font:11px/1.4 var(--record-font);border-bottom:1px dotted var(--muted);cursor:help}
.recording-import-label:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}
.recording-format-copy{position:relative;overflow:visible}
.copy-format{position:absolute;top:calc(100% + 3px);left:50%;transform:translateX(-50%);z-index:2;pointer-events:none;opacity:0;background:#08090b;color:#fafafa;border:1px solid #ffffff55;border-radius:5px;padding:3px 5px;font:10px/1.2 var(--record-font);transition:opacity .12s ease}
.recording-format-copy:hover .copy-format,.recording-format-copy:focus-visible .copy-format{opacity:1}
.recording-header-actions:has(:focus-visible) .recording-format-copy:not(:focus-visible) .copy-format{opacity:0}
@media(hover:none){.recording-format-copy:focus .copy-format{opacity:1}}
.recording-small{position:relative;width:46px;height:22px;border-radius:7px}
.recording-small::before{content:"";position:absolute;inset:-3px 0}
.recording-bubble svg{width:13px;height:13px}
.recording-small svg{width:12px;height:12px}
.recording-bubble:hover:not(:disabled),.recording-small:hover:not(:disabled),.bubble-discard:hover:not(:disabled){background:#303238;color:#fff}
.recording-small[aria-pressed=true]{background:#4a2016;color:#ff987a;border-color:#ff7048}
.recording-secondary{display:flex;flex-direction:row;justify-content:center;align-items:center;gap:4px;width:148px;flex:none}
.recording-divider{width:96px;height:1px;flex:none;background:#8b8d94;opacity:.55}
.recording-network-toggle{color:#92959f;background:var(--raised)}
.recording-network-toggle[aria-pressed=true]{background:#4a2016;color:#ff987a;border-color:#ff7048}
.recording-network-toggle[aria-pressed=true]:hover:not(:disabled){background:#632c1e;color:#ffbd9e}
.bubble-discard{position:absolute;border-radius:7px;opacity:0;pointer-events:none!important;transition:opacity 100ms ease-out}
.bubble-discard{width:19px;height:19px;right:-6px;top:-4px}
.bubble-discard svg{width:11px;height:11px}
.recording-stack-item:hover .bubble-discard,.recording-stack-item:focus-within .bubble-discard{opacity:1;pointer-events:auto!important}
.recording-panel{right:252px;bottom:18px;width:420px;max-height:calc(100dvh - 36px);max-width:calc(100vw - 276px);z-index:5;border-radius:18px}
.shell[data-corner$=left]>.recording-panel{left:252px;right:auto}
.shell[data-corner^=top]>.recording-panel{top:18px;bottom:auto}
.recording-panel .panel-head{align-items:flex-start;padding-bottom:12px}
.recording-panel .panel-head>.icon-button{flex:none}
.recording-panel .panel-head h2{min-width:0;margin:3px 0 0}
.recording-header-actions{display:flex;gap:0;flex:none}
.recording-header-actions .icon-button{width:27px;height:27px}
.recording-header-actions .recording-resume{color:var(--accent)}
.recording-header-actions svg{width:15px;height:15px}
.recording-filters{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:18px 0 14px}
.recording-filters .text-button{margin-left:auto}
.recording-timeline{list-style:none;padding:0;margin:0}
.recording-timeline>li{position:relative;padding:0 0 16px;margin-bottom:12px;border-bottom:1px solid rgba(255,255,255,.12)}
.recording-step-row,.recording-mark-row{display:flex;align-items:flex-start;gap:5px}
.recording-step-row .recording-step{flex:1;min-width:0}
.recording-step-row>.icon-button,.recording-mark-row>.icon-button{flex:none;margin-top:4px}
.recording-mark-row>strong{flex:1;min-width:0;margin-top:6px}
.recording-step{display:grid;grid-template-columns:19px minmax(0,1fr) auto;align-items:start;gap:8px;width:100%;padding:7px 5px;border:0;border-radius:8px;background:transparent;text-align:left;color:var(--ink);font:inherit;font-size:11px;line-height:1.5}
.recording-step:hover:not(:disabled){background:rgba(255,255,255,.07)}
.recording-step[aria-pressed=true]{background:color-mix(in srgb,var(--mark-color,var(--accent)) 22%,#111216);color:var(--mark-color,var(--accent))}
.recording-timeline [data-annotation-id] .recording-step strong{color:var(--mark-color,var(--accent))}
.recording-step>span{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.recording-step strong{font-weight:500;overflow-wrap:anywhere}
.recording-step time{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;margin-top:1px}
.recording-timeline small,.recording-marks small,.recording-network small{display:block;font-size:10px;color:var(--muted);line-height:1.6;overflow-wrap:anywhere}
.recording-timeline>li>small{padding:0 5px 0 32px}
.recording-timeline p,.recording-marks p{font-size:12px;line-height:1.65;overflow-wrap:anywhere;margin:7px 0}
.recording-network{margin:12px 0 0 32px;font-size:11px;overflow-wrap:anywhere}
.recording-network strong{font-size:11px;font-weight:500;line-height:1.6}
.network-body{margin-top:8px}
.network-body summary{font-size:11px}
.recording-query>summary{font-size:11px;line-height:1.6;cursor:pointer}
.recording-query[open]>summary{margin-bottom:5px}
.recording-internal-queries{margin:16px 0 0;padding-top:12px;border-top:1px solid var(--line);color:var(--muted)}
.recording-internal-queries>summary{font-size:11px;cursor:pointer}
.recording-group-members{margin:6px 0 0 32px;font-size:11px;color:var(--muted)}
.recording-group-members summary{cursor:pointer;font-size:11px}
.recording-group-members ul{padding-left:16px;margin:8px 0}
.recording-group-members li{margin:6px 0;overflow-wrap:anywhere}
.recording-internal-queries .recording-network{margin-left:0}
.recording-query summary:focus-visible,.recording-internal-queries>summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:3px}
@media(max-width:600px){.selection-key-hint{display:none}}
.network-body pre{max-height:220px;margin:7px 0;font-size:10px}
.recording-marks{margin-top:22px}
.recording-marks h3{font-size:13px;font-weight:600;margin-bottom:14px}
.recording-marks ol{list-style:none;margin:0;padding:0}
.recording-marks li{padding:0 0 14px;margin-bottom:14px;border-bottom:1px solid rgba(255,255,255,.12)}
.recording-marks strong{font-size:12px;font-weight:500;overflow-wrap:anywhere}
.recording-session-notes{font-size:12px;line-height:1.65;white-space:pre-wrap;margin-top:12px;color:var(--muted);overflow-wrap:anywhere}
.recording-document-list{list-style:none;padding:0;margin:0}
.recording-document-list li{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.12)}
.recording-document-list a{flex:1;min-width:0;font-size:12px;color:var(--accent);text-decoration:none;line-height:1.5;overflow-wrap:anywhere}
.recording-document-list a:hover{text-decoration:underline;text-underline-offset:3px}
.recording-document-list .icon-button{flex:none}
.recording-panel h2,.recording-step,.recording-panel small,.recording-step time,.recording-document-list a,.recording-network pre,.annotation-pin{font-family:var(--record-font)}
.annotation-comment{position:fixed;margin:0;width:max-content;max-width:220px;max-height:110px;overflow:auto;padding:10px 12px;border-radius:12px;font-size:12px;line-height:1.5;pointer-events:none;overflow-wrap:anywhere;z-index:2}
.annotation-pin{background:var(--mark-color,var(--accent));color:#08090b;border:1px solid var(--mark-color,var(--accent));box-shadow:0 2px 7px #08090b26}
.annotation-pin:hover:not(:disabled){color:#08090b;background:var(--mark-color,var(--accent));filter:brightness(1.12)}
.annotation-pin[aria-pressed=true]{outline-color:var(--mark-color,var(--accent))}
.annotation-corner{position:fixed;z-index:2;pointer-events:none;border-top:2px solid var(--mark-color,var(--accent));border-left:2px solid var(--mark-color,var(--accent));border-top-left-radius:3px}
.annotation-region,.highlight{border:2px dashed var(--mark-color,var(--accent));background:color-mix(in srgb,var(--mark-color,var(--accent)) 12%,transparent);border-radius:4px}
.annotation-region{z-index:1}
.highlight>span{background:var(--mark-color,var(--accent));color:#08090b}
.highlight[data-multiple=true]{border:1px dashed var(--mark-color,var(--accent));background:transparent}
.selection-member{border-style:solid}
.annotation-comment{border-color:color-mix(in srgb,var(--mark-color,var(--accent)) 65%,transparent)}
.selection-actions{z-index:6;border-radius:16px}
.selection-actions{border-color:var(--mark-color,var(--accent))}
.selection-actions-head>svg{color:var(--mark-color,var(--accent))}
.selection-actions .selection-note textarea:focus-visible{outline-color:var(--mark-color,var(--accent));border-color:var(--mark-color,var(--accent))}
.selection-modes button[aria-pressed=true]{background:#4a2016;color:#ff987a}
.selection-actions .selection-note textarea,.selection-actions .selection-note textarea:focus{background:#16171a;transition:none}
.selection-actions-identity strong{color:var(--ink)}
.selection-actions-identity span,.selection-actions-clear,.selection-note,.selection-actions-status{color:var(--muted)}
.selection-actions-clear:hover:not(:disabled){background:rgba(255,255,255,.09);color:var(--ink)}
.selection-actions-status[data-error=true]{color:var(--danger)}
.selection-note{font-size:12px}
.selection-note textarea{font-size:13px}
.selection-note-actions{display:flex;justify-content:flex-end;gap:6px}
.selection-save{display:grid;place-items:center;min-width:36px;min-height:34px;padding:7px;border:0;border-radius:8px}
.shell>.recording-controls~.toast{left:auto;right:252px;bottom:18px;width:max-content;max-width:min(350px,calc(100vw - 276px));padding:10px 13px;border-radius:12px;overflow-wrap:anywhere;z-index:8}
.shell[data-corner$=left]>.recording-controls~.toast{left:252px;right:auto}
.shell[data-corner^=top]>.recording-controls~.toast{top:18px;bottom:auto}
@supports not (backdrop-filter:blur(1px)){
  .panel,.selection-actions,.inspector-banner,.toast,.annotation-comment{background:#0d0e11}
  .recording-bubble,.recording-small,.bubble-discard{background:#191b20}
  .recording-network-toggle[aria-pressed=true]{background:#4a2016}
}
@media(prefers-reduced-transparency:reduce),(prefers-contrast:more){
  .panel,.selection-actions,.inspector-banner,.toast,.annotation-comment{background:#0d0e11;backdrop-filter:none;-webkit-backdrop-filter:none}
  .recording-bubble,.recording-small,.bubble-discard{background:#191b20;backdrop-filter:none;-webkit-backdrop-filter:none}
  .recording-network-toggle[aria-pressed=true]{background:#4a2016}
}
.selection-actions{background:#08090b;backdrop-filter:none;-webkit-backdrop-filter:none}
@media(prefers-contrast:more){.recording-main:focus-visible,.recording-bubble:focus-visible,.recording-small:focus-visible{outline-width:3px}:host{--line:#b7bcc7}}
@media(hover:none),(pointer:coarse){.bubble-discard{opacity:1;pointer-events:auto!important;transition:none}}
@media(prefers-reduced-motion:reduce){.recording-main,.recording-island,.recording-reveal,.recording-dock-actions{transition:none}.recording-dot{animation:none}.recording-reveal,.recording-controls[data-corner^=top] .recording-reveal{transform:none}}
@media(max-width:600px){
  .recording-controls{right:12px;bottom:max(12px,env(safe-area-inset-bottom))}
  .recording-controls[data-corner$=left]{left:12px}
  .recording-controls[data-corner^=top]{top:max(12px,env(safe-area-inset-top))}
  .shell>.recording-panel,.shell[data-corner$=left]>.recording-panel{left:12px;right:12px;bottom:78px;width:calc(100vw - 24px);max-width:calc(100vw - 24px);max-height:calc(100dvh - 104px)}
  .shell[data-corner^=top]>.recording-panel{top:78px;bottom:auto}
  .recording-panel .panel-head{flex-wrap:wrap}
  .recording-panel .panel-head h2{flex-basis:calc(100% - 40px);order:0}
  .recording-panel .panel-head>.icon-button{order:1}
  .recording-header-actions{order:2;margin-top:4px}
  .recording-step{grid-template-columns:17px minmax(0,1fr);gap:7px}
  .recording-step time{grid-column:2}
  .recording-timeline>li>small{padding-left:29px}
  .recording-network{margin-left:29px}
  .recording-stack{max-height:calc(100dvh - 250px)}
  .recording-controls[data-panel-open=true] .recording-stack,.recording-controls[data-panel-open=true] .recording-secondary,.recording-controls[data-panel-open=true] .recording-divider{display:none}
  .shell>.recording-controls~.toast,.shell[data-corner$=left]>.recording-controls~.toast{left:12px;right:12px;top:12px;bottom:auto;width:auto;max-width:none;font-size:11px}
  .shell[data-corner^=top]>.recording-controls~.toast{top:auto;bottom:max(12px,env(safe-area-inset-bottom))}
}
`;
