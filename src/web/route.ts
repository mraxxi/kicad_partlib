import { useEffect, useState } from 'react';

/**
 * Hash routing with query parameters (#/parts?q=0603&cat=...). Filters live in the
 * URL so the browser's back button and a refresh both keep your view; the first
 * thing the old state-in-a-component version lost was your place after opening a part.
 */
export interface Route { path: string; params: URLSearchParams }

function parse(): Route {
  const h = location.hash.replace(/^#/, '') || '/';
  const i = h.indexOf('?');
  return { path: i < 0 ? h : h.slice(0, i), params: new URLSearchParams(i < 0 ? '' : h.slice(i + 1)) };
}

const EVENT = 'partlib:route';

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    window.addEventListener(EVENT, on);
    return () => { window.removeEventListener('hashchange', on); window.removeEventListener(EVENT, on); };
  }, []);
  return route;
}

/** Update query parameters in place (no history entry, no scroll jump); null removes one. */
export function setParams(updates: Record<string, string | null>): void {
  const r = parse();
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === '') r.params.delete(k); else r.params.set(k, v);
  }
  const qs = r.params.toString();
  history.replaceState(null, '', `#${r.path}${qs ? `?${qs}` : ''}`);
  window.dispatchEvent(new Event(EVENT));
  try { if (r.path === '/parts') sessionStorage.setItem('partlib.partsQuery', qs); } catch { /* storage may be unavailable */ }
}

/** Where "back to all parts" should go: the Parts view as you left it. */
export function partsHref(): string {
  try {
    const qs = sessionStorage.getItem('partlib.partsQuery');
    return qs ? `#/parts?${qs}` : '#/parts';
  } catch { return '#/parts'; }
}
