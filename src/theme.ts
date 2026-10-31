// Blocking theme script, loaded in every page's head: localStorage is the only
// store a page can read before first paint, so it mirrors the mode for that
// paint alone, and storage.local stays the source of truth.

import { themeFrom, type ThemeMode } from './lib/notes.ts';

(function () {
  const warn = (what: string) => (err: unknown) => console.warn(`tabnotes: ${what}:`, err);

  // data-theme goes first, so a failing mirror still leaves the right theme
  const apply = (mode: ThemeMode) => {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem('theme', mode);
    } catch (err) {
      warn('write theme mirror')(err);
    }
  };

  try {
    document.documentElement.dataset.theme = themeFrom(localStorage.getItem('theme'));
  } catch (err) {
    warn('read theme mirror')(err);
  }

  // registered before the read, whose older value must not undo a newer change
  let changed = false;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, 'theme')) return;
    changed = true;
    apply(themeFrom(changes.theme.newValue));
  });

  browser.storage.local.get('theme').then((stored: { theme?: unknown }) => {
    if (!changed) apply(themeFrom(stored.theme));
  }).catch(warn('load theme'));
})();
