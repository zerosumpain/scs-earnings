// Tiny DOM helpers (no framework).

/**
 * Attributes whose PRESENCE is the value. `hidden: false` must remove the
 * attribute, not write hidden="false" — which hides the element. Every other
 * attribute stringifies, so `aria-selected: false` still renders correctly as
 * aria-selected="false", which is what a tablist needs.
 */
const BOOLEAN_ATTRS = new Set(['hidden', 'disabled', 'checked', 'open', 'required', 'readonly', 'multiple', 'selected']);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, any> = {}, children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (BOOLEAN_ATTRS.has(k)) { if (v) e.setAttribute(k, ''); else e.removeAttribute(k); }
    else e.setAttribute(k, String(v));
  }
  for (const c of children) e.append(c);
  return e;
}

export const $ = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
export const clear = (el: HTMLElement) => { el.innerHTML = ''; return el; };

/** Append a list of children, skipping the nulls a conditional produces. */
export function append(parent: HTMLElement, children: (Node | string | null | undefined | false)[]): HTMLElement {
  for (const c of children) if (c) parent.append(c);
  return parent;
}

/** Escape for the few places that build markup as a string (table twins). */
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/**
 * Inline markup, safely.
 *
 * Study copy carries `<b>` on the load-bearing noun and `[3]` citation marks.
 * Everything else is escaped, so a source title can never inject markup, and
 * the citation becomes a superscript that links to the sources list.
 */
export function richText(s: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const html = esc(s)
    .replace(/&lt;b&gt;/g, '<b>')
    .replace(/&lt;\/b&gt;/g, '</b>')
    .replace(/\[(\d+)\]/g, '<a class="fs-cite" href="#sources">[$1]</a>');
  const host = document.createElement('span');
  host.innerHTML = html;
  while (host.firstChild) frag.append(host.firstChild);
  return frag;
}

/** A <span> carrying rich study copy. */
export function rich(tag: keyof HTMLElementTagNameMap, attrs: Record<string, any>, s: string): HTMLElement {
  const e = h(tag, attrs);
  e.append(richText(s));
  return e;
}
