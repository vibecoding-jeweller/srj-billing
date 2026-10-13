import type { KeyboardEvent } from 'react';

/**
 * Enter moves to the next field marked with data-nav (Shift+Enter keeps a newline in text areas).
 * On the last field, `onLast` runs instead.
 */
export function focusNextOnEnter(e: KeyboardEvent<HTMLElement>, onLast?: () => void) {
  if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (!t.hasAttribute('data-nav')) return;
  if (t.tagName === 'TEXTAREA' && e.shiftKey) return;
  e.preventDefault();
  const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')).filter(
    (el) => !(el as HTMLInputElement).disabled && el.offsetParent !== null,
  );
  const i = all.indexOf(t);
  const next = all[i + 1];
  if (next) {
    next.focus();
    if (next instanceof HTMLInputElement) next.select();
  } else onLast?.();
}
