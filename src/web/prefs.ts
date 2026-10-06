import { useSyncExternalStore } from 'react';

/**
 * Display preferences, kept in THIS browser only (localStorage). Config fails soft
 * (AGENTS.md): unreadable or missing storage means defaults, never an error. Each
 * machine keeps its own; nothing here is data.
 */
export interface Prefs {
  density: 'compact' | 'comfortable';
  theme: 'system' | 'light' | 'dark';
  /** Open a part beside the table on wide screens instead of replacing the page. */
  sidePanel: boolean;
}
export const DEFAULT_PREFS: Prefs = { density: 'compact', theme: 'system', sidePanel: true };
const KEY = 'partlib.prefs.v1';

function read(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      density: v.density === 'comfortable' ? 'comfortable' : 'compact',
      theme: v.theme === 'light' || v.theme === 'dark' ? v.theme : 'system',
      sidePanel: v.sidePanel !== false,
    };
  } catch { return DEFAULT_PREFS; }
}

let current = read();
const listeners = new Set<() => void>();

export function applyPrefs(p: Prefs = current): void {
  const el = document.documentElement;
  el.dataset.density = p.density;
  if (p.theme === 'system') delete el.dataset.theme; else el.dataset.theme = p.theme;
}

export function setPrefs(patch: Partial<Prefs>): void {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* not saved; still applies this session */ }
  applyPrefs();
  listeners.forEach((l) => l());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => current);
}

export function clearSaved(prefix: string): void {
  try { Object.keys(localStorage).filter((k) => k.startsWith(prefix)).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
}
