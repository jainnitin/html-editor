/**
 * Find and replace.
 *
 * Replacement walks text nodes only, so it can never corrupt a tag name, class
 * or attribute — the failure mode of a naive string replace over markup.
 */

import { $, doc, win, toast } from './dom.js';
import { S, markDirty } from './state.js';
import { pushCustom } from './history.js';
import { track, bucket } from './telemetry.js';

/** Text inside these elements is code or markup, never prose. */
const SKIP_TEXT = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/;

function textNodes() {
  const d = doc();
  const out = [];
  if (!d) return out;
  const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      SKIP_TEXT.test(n.parentNode?.tagName || '') || !n.nodeValue.trim()
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
  return out;
}

const query = () => $('fq').value;
const cased = () => $('fcase').checked;

function countMatches(q, matchCase) {
  if (!q) return 0;
  const needle = matchCase ? q : q.toLowerCase();
  let total = 0;
  for (const n of textNodes()) {
    const hay = matchCase ? n.nodeValue : n.nodeValue.toLowerCase();
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      total++;
    }
  }
  return total;
}

export function refreshCount() {
  const q = query();
  const n = countMatches(q, cased());
  $('fcount').textContent = q ? `${n} match${n === 1 ? '' : 'es'}` : '';
  return n;
}

export function findStep(backwards) {
  const q = query();
  if (!q) return;
  win().focus();
  if (!win().find(q, cased(), backwards, true, false, false, false)) {
    toast('No matches.');
  }
}

export function replaceOne() {
  if (!S.editing) {
    toast('Switch to Editing to replace.');
    return;
  }
  const q = query();
  if (!q) return;

  const sel = win().getSelection();
  const selected = sel && !sel.isCollapsed ? sel.toString() : null;
  const onMatch = cased()
    ? selected === q
    : selected?.toLowerCase() === q.toLowerCase();

  // Nothing selected yet: first press finds, second replaces.
  if (!onMatch) {
    findStep(false);
    return;
  }

  doc().execCommand('insertText', false, $('fr').value);
  markDirty();
  refreshCount();
  findStep(false);
}

export function replaceAll() {
  if (!S.editing) {
    toast('Switch to Editing to replace.');
    return;
  }
  const q = query();
  if (!q) return;

  const rep = $('fr').value;
  const matchCase = cased();
  const needle = matchCase ? q : q.toLowerCase();
  const touched = [];
  let n = 0;

  for (const node of textNodes()) {
    const hay = matchCase ? node.nodeValue : node.nodeValue.toLowerCase();
    if (!hay.includes(needle)) continue;

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

  if (!n) {
    toast('No matches.');
    return;
  }

  // One timeline entry for the whole sweep, in both directions.
  const after = touched.map(([node]) => node.nodeValue);
  pushCustom(
    () => touched.forEach(([node, old]) => { node.nodeValue = old; }),
    () => touched.forEach(([node], i) => { node.nodeValue = after[i]; })
  );
  markDirty();
  refreshCount();
  track('replace_all', { count: bucket(n) });
  toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'} — ⌘Z to undo`);
}

export function openFind() {
  if (!S.filePath) return;
  track('find_opened');
  $('findbar').hidden = false;
  $('fq').focus();
  $('fq').select();
  refreshCount();
}

export function closeFind() {
  $('findbar').hidden = true;
}

export const isFindOpen = () => !$('findbar').hidden;

export function bindFind() {
  $('fq').addEventListener('input', refreshCount);
  $('fcase').addEventListener('change', refreshCount);

  for (const id of ['fq', 'fr']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (id === 'fq') findStep(e.shiftKey);
        else replaceOne();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFind();
      }
    });
  }

  $('fnext').addEventListener('click', () => findStep(false));
  $('fprev').addEventListener('click', () => findStep(true));
  $('frone').addEventListener('click', replaceOne);
  $('frall').addEventListener('click', replaceAll);
  $('fclose').addEventListener('click', closeFind);
}
