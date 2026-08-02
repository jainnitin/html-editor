import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save, message, ask } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';

const FILTERS = [{ name: 'HTML', extensions: ['html', 'htm', 'bak'] }];

/* Blocks the Trim tool may remove, smallest-first — the shapes generated
   reports actually use. */
const TRIM_TARGETS = [
  'tr', 'li', '.scard', '.card', 'figure', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
  'table', 'ul', 'ol', 'section', 'article', '.panel'
];

const SKIP_TEXT = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/;

const $ = (id) => document.getElementById(id);
const frame = $('frame');
const drop = $('drop');
const fmtbar = $('fmtbar');
const findbar = $('findbar');
const linkDlg = $('linkdlg');
const auditDlg = $('auditdlg');
const appWindow = getCurrentWindow();

let filePath = null;
let sourceHtml = '';
let dirty = false;
let mode = 'edit';          // 'edit' | 'view' — the pulldown
let editing = true;         // mirrors mode === 'edit'
let autosave = true;
let saving = false;
let saveTimer = null;
let trimming = false;
let currentLink = null;
let hoverEl = null;
let warnedGenerated = false;
const backedUp = new Set();

const doc = () => frame.contentDocument;
const win = () => frame.contentWindow;
const baseName = (p) => (p ? p.split('/').pop() : '');

/* ---------------- chrome ---------------- */

function setTitle() {
  const name = filePath ? baseName(filePath) : 'No file open';
  const mark = dirty && !autosave ? '● ' : '';
  appWindow.setTitle(`${mark}${name} — HTML Editor`).catch(() => {});
}

function markDirty() {
  if (!dirty) { dirty = true; setTitle(); }
  setSaveState();
  scheduleSave();
}

const stateEl = () => $('savestate');

/* Silent while auto-save is doing its job. The readout only appears when the
   user actually has to act — i.e. auto-save is off and there are edits on the
   floor. */
function setSaveState() {
  const el = stateEl();
  if (!el) return;
  const needsAction = filePath && dirty && !autosave;
  el.textContent = needsAction ? 'Unsaved — ⌘S' : '';
  el.className = needsAction ? 'edited' : '';
}

/* Debounced: write once the typing stops rather than on every keystroke. */
function scheduleSave() {
  if (!autosave || !filePath) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { doSave(true); }, 1200);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (autosave && dirty && filePath) await doSave(true);
}

let toastTimer;
function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- open ---------------- */

async function openDialog() {
  const picked = await open({ multiple: false, filters: FILTERS });
  if (picked) await loadPath(picked);
}

async function loadPath(path) {
  if (!(await confirmDiscard())) return;
  try {
    const html = await invoke('read_text_file', { path });
    filePath = path;
    sourceHtml = html;
    dirty = false;
    mode = 'edit';
    editing = true;
    trimming = false;
    warnedGenerated = false;
    closeFind();
    syncButtons();
    drop.classList.add('hide');
    frame.srcdoc = html;
    setTitle();
    setSaveState();
    invoke('push_recent', { path }).catch(() => {});
  } catch (e) {
    await message(`Could not open that file.\n\n${e}`, { title: 'Open failed', kind: 'error' });
  }
}

/* ---------------- iframe wiring ---------------- */

frame.addEventListener('load', () => {
  const d = doc();
  if (!d || !d.body) return;

  d.body.addEventListener('input', onInput);
  d.addEventListener('click', onDocClick, true);
  d.addEventListener('mousemove', onDocMove, true);
  d.addEventListener('mouseleave', clearHover);
  d.addEventListener('keydown', handleShortcut);
  d.addEventListener('selectionchange', syncActive);

  ensureStyle(d);
  markGeneratedRegions();
  applyModes();
});

function onInput() {
  markDirty();
  if (warnedGenerated) return;
  const sel = win()?.getSelection();
  const node = sel?.anchorNode;
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  if (el?.closest?.('.he-generated')) {
    warnedGenerated = true;
    toast('Heads up: this block is drawn by the report\u2019s own JavaScript — edits here will not survive a reload.', 5200);
  }
}

function onDocClick(e) {
  if (trimming) {
    e.preventDefault();
    e.stopPropagation();
    trimBlock(e.altKey);
    return;
  }
  const a = e.target.closest?.('a');
  if (!a) return;
  e.preventDefault();
  if (editing) { openLinkDialog(a); return; }
  const href = a.getAttribute('href') || '';
  if (/^https?:/i.test(href)) openUrl(href).catch(() => {});
  else if (href.startsWith('#')) {
    doc().getElementById(href.slice(1))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

/* Regions the report builds at runtime: empty in the source file, populated in
   the live DOM. Editing them is a trap, so they get flagged. */
function markGeneratedRegions() {
  const d = doc();
  try {
    const stat = new DOMParser().parseFromString(sourceHtml, 'text/html');
    const path = (el, root) => {
      const p = [];
      for (let n = el; n && n !== root; n = n.parentElement) {
        p.unshift([...n.parentNode.children].indexOf(n));
      }
      return p;
    };
    const at = (p, root) => {
      let n = root;
      for (const i of p) { n = n?.children[i]; if (!n) return null; }
      return n;
    };
    const empties = [...stat.body.querySelectorAll('*')].filter(
      (el) => !el.children.length && !el.textContent.trim() &&
        !/^(BR|HR|IMG|INPUT|META|LINK|SCRIPT|STYLE|SOURCE|TRACK|WBR|COL)$/.test(el.tagName)
    );
    let n = 0;
    for (const el of empties) {
      const live = at(path(el, stat.body), d.body);
      if (live && (live.children.length || live.textContent.trim())) {
        live.classList.add('he-generated');
        n++;
      }
    }
    if (n) toast(`${n} region${n > 1 ? 's are' : ' is'} rendered by this report\u2019s own scripts — outlined in amber while editing.`, 4200);
  } catch { /* detection is best-effort */ }
}

/* ---------------- modes ---------------- */

function applyModes() {
  const d = doc();
  if (!d || !d.body) return;
  d.body.contentEditable = editing && !trimming ? 'true' : 'false';
  d.body.spellcheck = editing;
  d.documentElement.classList.toggle('he-edit', editing);
  d.documentElement.classList.toggle('he-trim', trimming);
  if (!trimming) clearHover();
}

const MODE_LABEL = { edit: 'Editing', view: 'Viewing' };

function syncButtons() {
  fmtbar.classList.toggle('locked', !editing);
  $('trim').classList.toggle('on', trimming);
  const btn = $('modebtn');
  btn.className = `m-${mode}`;
  $('modelabel').textContent = MODE_LABEL[mode];
  const chosen = document.querySelector(`#modemenu button[data-mode="${mode}"]`);
  $('modeicon').innerHTML = chosen ? chosen.querySelector('svg').outerHTML : '';
  for (const b of document.querySelectorAll('#modemenu button')) {
    b.classList.toggle('on', b.dataset.mode === mode);
  }
}

function setMode(next) {
  if (!filePath) { closeModeMenu(); return; }
  closeModeMenu();
  if (next === mode) return;
  mode = next;
  editing = mode === 'edit';
  if (!editing) trimming = false;
  syncButtons();
  applyModes();
  if (editing) win().focus();
}

const toggleEdit = () => setMode(editing ? 'view' : 'edit');

/* Trim is a tool you flick on and off inside Editing, not a place you live. */
function toggleTrim() {
  if (!filePath) return;
  if (!editing) { mode = 'edit'; editing = true; }
  trimming = !trimming;
  syncButtons();
  applyModes();
  if (trimming) toast('Trimming — click a block to delete it. Hold ⌥ for its parent, Esc to stop.', 3200);
}

/* ---- pulldown ---- */

function openModeMenu() {
  $('modemenu').hidden = false;
  $('modebtn').setAttribute('aria-expanded', 'true');
}
function closeModeMenu() {
  $('modemenu').hidden = true;
  $('modebtn').setAttribute('aria-expanded', 'false');
}
function toggleModeMenu() {
  if (!filePath) return;
  $('modemenu').hidden ? openModeMenu() : closeModeMenu();
}

/* Injected once per document: trim/generated affordances, kept out of the saved
   file by serialize(). */
function ensureStyle(d) {
  if (d.getElementById('he-style')) return;
  const s = d.createElement('style');
  s.id = 'he-style';
  s.textContent = `
.he-trim *{cursor:crosshair!important}
.he-trim .he-hover{outline:2px solid #dc2626!important;outline-offset:1px;
background:rgba(220,38,38,.07)!important}
.he-edit .he-generated{outline:1px dashed rgba(217,119,6,.75);outline-offset:2px}
.he-find-hit{background:#ffe066;color:#111}`;
  d.head.appendChild(s);
}

/* ---------------- trim ---------------- */

function blockFor(el, goUp) {
  const d = doc();
  if (!el || el === d.body) return null;
  let hit = null;
  for (const sel of TRIM_TARGETS) {
    const m = el.closest?.(sel);
    if (m && m !== d.body) { hit = m; break; }
  }
  if (!hit) hit = el.closest?.('div,section,header,footer,aside') || null;
  if (hit === d.body || hit === d.documentElement) return null;
  if (goUp && hit?.parentElement && hit.parentElement !== d.body) hit = hit.parentElement;
  return hit;
}

function onDocMove(e) {
  if (!trimming) return;
  const el = blockFor(e.target, e.altKey);
  if (el === hoverEl) return;
  clearHover();
  hoverEl = el;
  hoverEl?.classList.add('he-hover');
}

function clearHover() {
  hoverEl?.classList.remove('he-hover');
  hoverEl = null;
}

function describe(el) {
  const cls = typeof el.className === 'string'
    ? el.className.split(/\s+/).filter((c) => c && !c.startsWith('he-'))[0] : '';
  return el.tagName.toLowerCase() + (cls ? `.${cls}` : '');
}

function trimBlock(goUp) {
  const el = hoverEl || blockFor(doc().activeElement, goUp);
  if (!el) return;
  const label = describe(el);
  el.classList.remove('he-hover');
  hoverEl = null;
  const parent = el.parentNode;
  const next = el.nextSibling;
  undoStack.push(() => parent.insertBefore(el, next));
  el.remove();
  markDirty();
  toast(`Removed <${label}> — ⌘Z to undo`);
}

/* Trim and Replace All bypass the browser's undo stack, so keep our own and
   drain it before falling back to execCommand. */
const undoStack = [];

function undo() {
  if (undoStack.length) { undoStack.pop()(); markDirty(); return; }
  doc().execCommand('undo', false, null);
  markDirty();
}

/* ---------------- formatting ---------------- */

function exec(cmd) {
  const d = doc();
  if (!d || !editing) return;
  if (cmd === 'undo') return undo();
  try { d.execCommand('styleWithCSS', false, false); } catch { /* noop */ }
  d.execCommand(cmd, false, null);
  markDirty();
  win().focus();
  syncActive();
}

for (const b of document.querySelectorAll('[data-cmd]')) {
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => exec(b.dataset.cmd));
}

function syncActive() {
  const d = doc();
  if (!d || !editing) return;
  for (const b of document.querySelectorAll('[data-cmd]')) {
    const cmd = b.dataset.cmd;
    if (cmd === 'undo' || cmd === 'redo' || cmd === 'unlink') continue;
    let on = false;
    try { on = d.queryCommandState(cmd); } catch { /* noop */ }
    b.classList.toggle('active', on);
  }
}

/* ---------------- find & replace ---------------- */

function textNodes() {
  const d = doc();
  const out = [];
  if (!d) return out;
  const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (SKIP_TEXT.test(n.parentNode?.tagName || '') || !n.nodeValue.trim())
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n);
  return out;
}

function countMatches(q, cased) {
  if (!q) return 0;
  const needle = cased ? q : q.toLowerCase();
  let total = 0;
  for (const n of textNodes()) {
    const hay = cased ? n.nodeValue : n.nodeValue.toLowerCase();
    let i = hay.indexOf(needle);
    while (i !== -1) { total++; i = hay.indexOf(needle, i + needle.length); }
  }
  return total;
}

function refreshCount() {
  const q = $('fq').value;
  const n = countMatches(q, $('fcase').checked);
  $('fcount').textContent = q ? `${n} match${n === 1 ? '' : 'es'}` : '';
  return n;
}

function findStep(backwards) {
  const q = $('fq').value;
  if (!q) return;
  win().focus();
  const ok = win().find(q, $('fcase').checked, backwards, true, false, false, false);
  if (!ok) toast('No matches.');
}

function replaceOne() {
  if (!editing) { toast('Switch to Edit mode to replace.'); return; }
  const q = $('fq').value;
  if (!q) return;
  const sel = win().getSelection();
  const cased = $('fcase').checked;
  const hit = sel && !sel.isCollapsed &&
    (cased ? sel.toString() === q : sel.toString().toLowerCase() === q.toLowerCase());
  if (!hit) { findStep(false); return; }
  doc().execCommand('insertText', false, $('fr').value);
  markDirty();
  refreshCount();
  findStep(false);
}

function replaceAll() {
  if (!editing) { toast('Switch to Edit mode to replace.'); return; }
  const q = $('fq').value;
  if (!q) return;
  const rep = $('fr').value;
  const cased = $('fcase').checked;
  const needle = cased ? q : q.toLowerCase();
  const touched = [];
  let n = 0;

  for (const node of textNodes()) {
    const hay = cased ? node.nodeValue : node.nodeValue.toLowerCase();
    if (hay.indexOf(needle) === -1) continue;
    touched.push([node, node.nodeValue]);
    let out = '';
    let from = 0;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, from)) {
      out += node.nodeValue.slice(from, i) + rep;
      from = i + needle.length;
      n++;
    }
    node.nodeValue = out + node.nodeValue.slice(from);
  }

  if (!n) { toast('No matches.'); return; }
  undoStack.push(() => touched.forEach(([node, old]) => { node.nodeValue = old; }));
  markDirty();
  refreshCount();
  toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'} — ⌘Z to undo`);
}

function openFind() {
  if (!filePath) return;
  findbar.hidden = false;
  $('fq').focus();
  $('fq').select();
  refreshCount();
}

function closeFind() {
  findbar.hidden = true;
}

$('fq').addEventListener('input', refreshCount);
$('fcase').addEventListener('change', refreshCount);
$('fq').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('fr').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('fnext').addEventListener('click', () => findStep(false));
$('fprev').addEventListener('click', () => findStep(true));
$('frone').addEventListener('click', replaceOne);
$('frall').addEventListener('click', replaceAll);
$('fclose').addEventListener('click', closeFind);

/* ---------------- links ---------------- */

function anchorTarget(href) {
  const d = doc();
  const id = href.slice(1);
  if (!id) return true;
  return !!(d.getElementById(id) || d.querySelector(`[name="${CSS.escape(id)}"]`));
}

function linkState(a) {
  const href = (a.getAttribute('href') || '').trim();
  if (!href || href === '#' || href.toLowerCase().startsWith('javascript:')) return 'empty';
  if (href.startsWith('#')) return anchorTarget(href) ? 'ok' : 'dead';
  if (/^(https?|mailto|tel):/i.test(href)) return 'ext';
  return 'ext';
}

function selectedAnchor() {
  const sel = win()?.getSelection();
  const node = sel?.anchorNode;
  const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  return el?.closest?.('a') || null;
}

function linkFromSelection() {
  if (!editing) { toast('Switch to Edit mode first (⌘E).'); return; }
  const a = selectedAnchor();
  if (a) { openLinkDialog(a); return; }
  const sel = win()?.getSelection();
  if (!sel || sel.isCollapsed) { toast('Select some text first, then ⌘K.'); return; }
  openLinkDialog(null, sel.toString());
}

function checkHrefWarning() {
  const href = $('lhref').value.trim();
  const w = $('lwarn');
  if (href.startsWith('#') && href.length > 1 && !anchorTarget(href)) {
    w.textContent = `Nothing in this document has id="${href.slice(1)}" — this jump link goes nowhere.`;
    w.hidden = false;
  } else {
    w.hidden = true;
  }
}

function openLinkDialog(a, seedText) {
  currentLink = a;
  $('linktitle').textContent = a ? 'Edit link' : 'Add link';
  $('ltext').value = a ? a.textContent : (seedText || '');
  $('lhref').value = a ? a.getAttribute('href') || '' : '';
  $('lremove').style.display = a ? '' : 'none';
  checkHrefWarning();
  linkDlg.showModal();
  $('lhref').focus();
  $('lhref').select();
}

function applyLink() {
  const text = $('ltext').value;
  const href = $('lhref').value.trim();
  if (currentLink) {
    if (href) currentLink.setAttribute('href', href);
    if (text !== currentLink.textContent) currentLink.textContent = text;
  } else if (href) {
    doc().execCommand('createLink', false, href);
    const made = selectedAnchor();
    if (made && text && text !== made.textContent) made.textContent = text;
  }
  markDirty();
  linkDlg.close();
}

$('lhref').addEventListener('input', checkHrefWarning);
$('lcancel').addEventListener('click', () => linkDlg.close());
$('lok').addEventListener('click', applyLink);
$('lremove').addEventListener('click', () => {
  if (currentLink) {
    const p = currentLink.parentNode;
    while (currentLink.firstChild) p.insertBefore(currentLink.firstChild, currentLink);
    p.removeChild(currentLink);
    markDirty();
  }
  linkDlg.close();
});
linkDlg.addEventListener('close', () => { currentLink = null; win()?.focus(); });
linkDlg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
});

/* ---------------- link audit ---------------- */

const PILL = { ok: 'jump ok', dead: 'dead jump', ext: 'external', empty: 'no target' };

function showAudit() {
  const d = doc();
  if (!d) return;
  const anchors = [...d.querySelectorAll('a')];
  const list = $('auditlist');
  const sum = $('auditsum');

  if (!anchors.length) {
    sum.textContent = 'This document has no links at all.';
    list.innerHTML = '';
    auditDlg.showModal();
    return;
  }

  const states = anchors.map(linkState);
  const bad = states.filter((s) => s === 'dead' || s === 'empty').length;
  sum.textContent = `${anchors.length} link${anchors.length === 1 ? '' : 's'} — ` +
    `${states.filter((s) => s === 'ok').length} working jumps, ` +
    `${states.filter((s) => s === 'ext').length} external, ` +
    `${bad} broken.`;

  list.innerHTML = anchors.map((a, i) => {
    const href = a.getAttribute('href') || '';
    const st = states[i];
    return `<div class="arow" data-i="${i}">
      <span class="t">${escapeHtml(a.textContent.trim() || '(no text)')}</span>
      <span class="pill ${st}">${PILL[st]}</span>
      <span class="h">${escapeHtml(href || '(missing href)')}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.arow').forEach((row) => {
    row.addEventListener('click', () => {
      const a = anchors[+row.dataset.i];
      a.scrollIntoView({ block: 'center', behavior: 'smooth' });
      auditDlg.close();
      if (editing) openLinkDialog(a);
    });
  });
  auditDlg.showModal();
}

$('aclose').addEventListener('click', () => auditDlg.close());

/* ---------------- save ---------------- */

function serialize() {
  const d = doc();
  const root = d.documentElement.cloneNode(true);
  root.classList.remove('he-edit', 'he-trim');
  root.querySelector('#he-style')?.remove();
  root.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  root.querySelectorAll('[spellcheck]').forEach((el) => el.removeAttribute('spellcheck'));
  root.querySelectorAll('.he-hover, .he-generated, .he-find-hit').forEach((el) => {
    el.classList.remove('he-hover', 'he-generated', 'he-find-hit');
    if (!el.getAttribute('class')) el.removeAttribute('class');
  });
  // Keep the no-JavaScript fallback of tabbed reports intact.
  if (root.querySelector('.tab[data-panel]')) {
    root.querySelectorAll('.panel[hidden]').forEach((el) => el.removeAttribute('hidden'));
    root.querySelector('.tabs')?.setAttribute('hidden', '');
  }
  return `<!doctype html>\n${root.outerHTML}\n`;
}

async function doSave(auto) {
  if (!filePath || saving) return;
  clearTimeout(saveTimer);
  const backup = !backedUp.has(filePath);
  saving = true;
  try {
    const madeBackup = await invoke('write_text_file', {
      path: filePath, contents: serialize(), backup
    });
    backedUp.add(filePath);
    dirty = false;
    setTitle();
    setSaveState();
    if (madeBackup) toast(`Original kept as ${baseName(filePath)}.bak`, 2600);
    else if (!auto) toast('Saved ✓');
  } catch (e) {
    setSaveState();
    await message(`Could not write the file.\n\n${e}`, { title: 'Save failed', kind: 'error' });
  } finally {
    saving = false;
  }
}

async function setAutosave(on) {
  autosave = on;
  await invoke('set_autosave', { on }).catch(() => {});
  if (on) { await flushSave(); } else { clearTimeout(saveTimer); }
  setTitle();
  setSaveState();
  toast(on ? 'Auto-save on — writes 1.2s after you stop typing.' : 'Auto-save off — ⌘S to save.', 2600);
}

/* Preview the file as a browser sees it. Flush first so what opens is what you
   just typed. */
async function openInBrowser() {
  if (!filePath) { toast('No file open.'); return; }
  if (dirty) await (autosave ? flushSave() : doSave(true));
  try {
    await invoke('open_in_browser', { path: filePath });
  } catch (e) {
    await message(`Could not open the file in a browser.\n\n${e}`,
      { title: 'Open in Browser failed', kind: 'error' });
  }
}

async function doSaveAs() {
  if (!filePath) return;
  const picked = await pickTarget();
  if (!picked) return;
  filePath = picked;
  backedUp.add(picked);
  await doSave();
  invoke('push_recent', { path: picked }).catch(() => {});
}

/* Write a copy elsewhere but keep editing the original — handy for spinning
   variants of a report off one source. */
async function doSaveCopy() {
  if (!filePath) return;
  const picked = await pickTarget('copy');
  if (!picked) return;
  try {
    await invoke('write_text_file', { path: picked, contents: serialize(), backup: false });
    toast(`Copy written to ${baseName(picked)} — still editing ${baseName(filePath)}`, 3000);
  } catch (e) {
    await message(`Could not write the copy.\n\n${e}`, { title: 'Save failed', kind: 'error' });
  }
}

function pickTarget(kind) {
  const base = baseName(filePath).replace(/\.bak$/i, '').replace(/\.html?$/i, '');
  const suggested = kind === 'copy' ? `${base} copy.html` : `${base}.html`;
  return save({ defaultPath: suggested, filters: FILTERS });
}

/* ---------------- unsaved-changes guard ---------------- */

async function confirmDiscard() {
  if (!dirty) return true;
  if (autosave) { await flushSave(); return true; }
  return ask('You have unsaved changes. Discard them?', {
    title: 'Unsaved changes',
    kind: 'warning',
    okLabel: 'Discard',
    cancelLabel: 'Cancel'
  });
}

appWindow.onCloseRequested(async (event) => {
  if (!dirty) return;
  event.preventDefault();
  if (autosave) { await flushSave(); appWindow.destroy(); return; }
  if (await confirmDiscard()) { dirty = false; appWindow.destroy(); }
});

// Losing focus is a natural commit point.
window.addEventListener('blur', () => { flushSave(); });

/* ---------------- drag & drop ---------------- */

getCurrentWebview().onDragDropEvent(({ payload }) => {
  if (payload.type === 'over' || payload.type === 'enter') drop.classList.add('over');
  else drop.classList.remove('over');
  if (payload.type === 'drop' && payload.paths?.length) loadPath(payload.paths[0]);
});

/* ---------------- commands ---------------- */

const COMMANDS = {
  open: openDialog,
  save: doSave,
  save_as: doSaveAs,
  save_copy: doSaveCopy,
  mode_edit: () => setMode('edit'),
  mode_view: () => setMode('view'),
  toggle_edit: toggleEdit,
  toggle_trim: toggleTrim,
  find: openFind,
  link: linkFromSelection,
  unlink: () => exec('unlink'),
  bold: () => exec('bold'),
  italic: () => exec('italic'),
  underline: () => exec('underline'),
  strike: () => exec('strikeThrough'),
  clear: () => exec('removeFormat'),
  undo: () => exec('undo'),
  redo: () => exec('redo'),
  audit: showAudit,
  recent_clear: () => invoke('clear_recents').catch(() => {}),
  toggle_autosave: () => setAutosave(!autosave),
  browser: openInBrowser,
  reveal: () => {
    if (!filePath) { toast('No file open.'); return; }
    revealItemInDir(filePath).catch(() => {});
  }
};

listen('menu', (e) => {
  const id = e.payload;
  if (id.startsWith('recent:')) { loadPath(id.slice(7)); return; }
  COMMANDS[id]?.();
});

function handleShortcut(e) {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'f') { e.preventDefault(); openFind(); }
  else if (k === 'k' && editing) { e.preventDefault(); linkFromSelection(); }
  else if (k === 'l' && e.shiftKey) { e.preventDefault(); showAudit(); }
  else if (k === 's') { e.preventDefault(); e.shiftKey ? doSaveAs() : doSave(); }
  else if (k === 'o') { e.preventDefault(); openDialog(); }
  else if (k === 'e') { e.preventDefault(); toggleEdit(); }
  else if (k === 'd') { e.preventDefault(); toggleTrim(); }
}
document.addEventListener('keydown', handleShortcut);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('modemenu').hidden) closeModeMenu();
  else if (trimming) toggleTrim();
  else if (!findbar.hidden) closeFind();
});

/* ---------------- bindings ---------------- */

$('modebtn').addEventListener('click', (e) => { e.stopPropagation(); toggleModeMenu(); });
for (const b of document.querySelectorAll('#modemenu button')) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}
document.addEventListener('click', closeModeMenu);
$('trim').addEventListener('click', toggleTrim);
$('find').addEventListener('click', openFind);
$('link').addEventListener('click', linkFromSelection);
$('links').addEventListener('click', showAudit);
$('browser').addEventListener('click', openInBrowser);

/* ---------------- opened from Finder ---------------- */

listen('open-files', (e) => {
  const paths = e.payload;
  if (Array.isArray(paths) && paths.length) loadPath(paths[0]);
});

invoke('get_settings')
  .then((s) => { autosave = s.autosave !== false; setTitle(); setSaveState(); })
  .catch(() => {});

invoke('frontend_ready')
  .then((paths) => { if (paths?.length) loadPath(paths[0]); })
  .catch(() => {});

syncButtons();
setTitle();
