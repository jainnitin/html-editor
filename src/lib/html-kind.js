/** A pasted block should go back as a block; a complete page stays a page. */
export function isHtmlFragment(html) {
  return !/<(?:!doctype|html|head|body)(?:\s|>)/i.test(html);
}
