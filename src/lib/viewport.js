/**
 * The iframe the report lives in: editing affordances, and detection of regions
 * the report draws for itself.
 */

import { doc, toast } from './dom.js';
import { S } from './state.js';
import { clearHover } from './trim.js';

/**
 * Injected into every opened document. These styles are stripped on save, so
 * they never reach the file on disk.
 */
export function ensureStyle(d) {
  if (!d || d.getElementById('he-style')) return;
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

/** Push the current mode onto the document. */
export function applyModes() {
  const d = doc();
  if (!d || !d.body) return;
  d.body.contentEditable = S.editing && !S.trimming ? 'true' : 'false';
  d.body.spellcheck = S.editing;
  d.documentElement.classList.toggle('he-edit', S.editing);
  d.documentElement.classList.toggle('he-trim', S.trimming);
  if (!S.trimming) clearHover();
}

/** Index path from `root` to `el`, used to line up two copies of one tree. */
const pathTo = (el, root) => {
  const p = [];
  for (let n = el; n && n !== root; n = n.parentElement) {
    p.unshift([...n.parentNode.children].indexOf(n));
  }
  return p;
};

const nodeAt = (path, root) => {
  let n = root;
  for (const i of path) {
    n = n?.children[i];
    if (!n) return null;
  }
  return n;
};

const VOID_TAGS = /^(BR|HR|IMG|INPUT|META|LINK|SCRIPT|STYLE|SOURCE|TRACK|WBR|COL)$/;

/**
 * Flag regions the report builds at runtime.
 *
 * Some reports ship empty containers and fill them from their own scripts — the
 * eval reports populate dozens of JSON tree views this way. Those regions look
 * editable but are rebuilt on every load, so edits there silently vanish. We
 * diff the live DOM against an inert parse of the file to find them.
 */
export function markGeneratedRegions() {
  const d = doc();
  if (!d) return;
  try {
    const inert = new DOMParser().parseFromString(S.sourceHtml, 'text/html');
    const empties = [...inert.body.querySelectorAll('*')].filter(
      (el) =>
        !el.children.length &&
        !el.textContent.trim() &&
        !VOID_TAGS.test(el.tagName)
    );

    let n = 0;
    for (const el of empties) {
      const live = nodeAt(pathTo(el, inert.body), d.body);
      if (live && (live.children.length || live.textContent.trim())) {
        live.classList.add('he-generated');
        n++;
      }
    }
    if (n) {
      toast(
        `${n} region${n > 1 ? 's are' : ' is'} rendered by this report’s own ` +
          'scripts — outlined in amber while editing.',
        4200
      );
    }
  } catch {
    /* Detection is best-effort; a parse failure just means no outlines. */
  }
}

/** Warn the first time the user types inside a script-generated region. */
export function warnIfGenerated(el) {
  if (S.warnedGenerated || !el?.closest?.('.he-generated')) return;
  S.warnedGenerated = true;
  toast(
    'Heads up: this block is drawn by the report’s own JavaScript — edits ' +
      'here will not survive a reload.',
    5200
  );
}

/**
 * Serialize the live document back to a standalone file, undoing every
 * affordance the editor added.
 */
export function serialize() {
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

  // Tabbed reports hide their panels with JavaScript and show them all when it
  // is unavailable. Restore that fallback so the saved file still reads as one
  // long document without scripts.
  if (root.querySelector('.tab[data-panel]')) {
    root.querySelectorAll('.panel[hidden]').forEach((el) => el.removeAttribute('hidden'));
    root.querySelector('.tabs')?.setAttribute('hidden', '');
  }

  return `<!doctype html>\n${root.outerHTML}\n`;
}
