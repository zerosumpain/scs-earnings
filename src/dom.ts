// Tiny DOM helpers (no framework).
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
    else e.setAttribute(k, String(v));
  }
  for (const c of children) e.append(c);
  return e;
}
export const $ = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
export const clear = (el: HTMLElement) => { el.innerHTML = ''; return el; };
