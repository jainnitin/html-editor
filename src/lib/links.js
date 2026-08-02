/**
 * Link editing and the link audit.
 *
 * Generated reports lean on in-page navigation (`href="#section"`), so a
 * renamed or trimmed heading leaves a link pointing at nothing. Both the editor
 * dialog and the audit resolve jump targets against the live document.
 */

import { $, doc, win, toast, escapeHtml } from './dom.js';
import { S, markDirty } from './state.js';
import { track, bucket } from './telemetry.js';

const linkDlg = $('linkdlg');
const auditDlg = $('auditdlg');

let currentLink = null;

/** Does `#foo` actually land somewhere in this document? */
function anchorTarget(href) {
  const d = doc();
  const id = href.slice(1);
  if (!id) return true;
  return !!(d.getElementById(id) || d.querySelector(`[name="${CSS.escape(id)}"]`));
}

/** 'ok' | 'dead' | 'ext' | 'empty' */
export function linkState(a) {
  const href = (a.getAttribute('href') || '').trim();
  if (!href || href === '#' || href.toLowerCase().startsWith('javascript:')) return 'empty';
  if (href.startsWith('#')) return anchorTarget(href) ? 'ok' : 'dead';
  return 'ext';
}

function selectedAnchor() {
  const sel = win()?.getSelection();
  const node = sel?.anchorNode;
  const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  return el?.closest?.('a') || null;
}

export function linkFromSelection() {
  if (!S.editing) {
    toast('Switch to Editing first (⌘E).');
    return;
  }
  const a = selectedAnchor();
  if (a) {
    openLinkDialog(a);
    return;
  }
  const sel = win()?.getSelection();
  if (!sel || sel.isCollapsed) {
    toast('Select some text first, then ⌘K.');
    return;
  }
  openLinkDialog(null, sel.toString());
}

function checkHrefWarning() {
  const href = $('lhref').value.trim();
  const w = $('lwarn');
  const dead = href.startsWith('#') && href.length > 1 && !anchorTarget(href);
  if (dead) {
    w.textContent = `Nothing in this document has id="${href.slice(1)}" — this jump link goes nowhere.`;
  }
  w.hidden = !dead;
}

export function openLinkDialog(a, seedText) {
  currentLink = a;
  $('linktitle').textContent = a ? 'Edit link' : 'Add link';
  $('ltext').value = a ? a.textContent : seedText || '';
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
  track('link_edited', { action: currentLink ? 'updated' : 'created' });
  linkDlg.close();
}

function unwrapLink() {
  if (currentLink) {
    const p = currentLink.parentNode;
    while (currentLink.firstChild) p.insertBefore(currentLink.firstChild, currentLink);
    p.removeChild(currentLink);
    markDirty();
  }
  linkDlg.close();
}

/* ---- audit ---- */

const PILL = { ok: 'jump ok', dead: 'dead jump', ext: 'external', empty: 'no target' };

export function showAudit() {
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
  const count = (s) => states.filter((x) => x === s).length;
  sum.textContent =
    `${anchors.length} link${anchors.length === 1 ? '' : 's'} — ` +
    `${count('ok')} working jumps, ${count('ext')} external, ` +
    `${count('dead') + count('empty')} broken.`;

  list.innerHTML = anchors
    .map((a, i) => {
      const href = a.getAttribute('href') || '';
      const st = states[i];
      return `<div class="arow" data-i="${i}">
      <span class="t">${escapeHtml(a.textContent.trim() || '(no text)')}</span>
      <span class="pill ${st}">${PILL[st]}</span>
      <span class="h">${escapeHtml(href || '(missing href)')}</span>
    </div>`;
    })
    .join('');

  for (const row of list.querySelectorAll('.arow')) {
    row.addEventListener('click', () => {
      const a = anchors[+row.dataset.i];
      a.scrollIntoView({ block: 'center', behavior: 'smooth' });
      auditDlg.close();
      if (S.editing) openLinkDialog(a);
    });
  }

  track('link_audit', {
    total: bucket(anchors.length),
    broken: bucket(count('dead') + count('empty'))
  });
  auditDlg.showModal();
}

export function bindLinks() {
  $('lhref').addEventListener('input', checkHrefWarning);
  $('lcancel').addEventListener('click', () => linkDlg.close());
  $('lok').addEventListener('click', applyLink);
  $('lremove').addEventListener('click', unwrapLink);
  $('aclose').addEventListener('click', () => auditDlg.close());

  linkDlg.addEventListener('close', () => {
    currentLink = null;
    win()?.focus();
  });
  linkDlg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyLink();
    }
  });
}
