/**
 * DOM helpers shared by every module.
 *
 * The document being edited lives inside an iframe, so `doc()` and `win()`
 * always mean "the report", never the app shell around it.
 */

export const $ = (id) => document.getElementById(id);

export const frame = $('frame');

export const doc = () => frame.contentDocument;
export const win = () => frame.contentWindow;

export const baseName = (p) => (p ? p.split(/[/\\]/).pop() : '');

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[c]));

let toastTimer;

/** Transient status line. Never used for anything the user must act on. */
export function toast(msg, ms = 1800) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, ms);
}
