// Options page glue: edits settings.defaultTitle, the title of new notes,
// fontSize, the editor and preview font size of every note tab, and theme,
// the colour mode of every page.

import { DEFAULT_TITLE, TITLE_HINT, fontSizeFrom, themeFrom, type Settings } from '../lib/notes.ts';

(async function () {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const inputEl = $<HTMLInputElement>('default-title');
  const sizeEl = $<HTMLInputElement>('font-size');
  const themeEl = $<HTMLSelectElement>('theme');
  $('title-hint').textContent = TITLE_HINT;

  const warn = (what: string) => (err: unknown) => console.warn(`tabnotes: ${what}:`, err);
  const warnOr = <T>(what: string, fallback: T) => (err: unknown): T => {
    warn(what)(err);
    return fallback;
  };

  // wired before the load so the page can still be left when loading fails
  $('all-notes').addEventListener('click', async () => {
    const url = browser.runtime.getURL('recovery/recovery.html');
    const all = await browser.tabs.query({}).catch(warnOr('query tabs', []));
    const tab = all.find((t) => typeof t.url === 'string' && t.url.startsWith(url));
    if (!tab) {
      await browser.tabs.create({ url }).catch(warn('open recovery page'));
      return;
    }
    await Promise.all([
      browser.tabs.update(tab.id!, { active: true }).catch(warn('focus recovery tab')),
      browser.windows.update(tab.windowId!, { focused: true }).catch(warn('focus recovery window')),
    ]);
  });

  // note tabs change fontSize with shortcuts. Registered before the load so a
  // change landing during it wins over the possibly older loaded value. The
  // field always shows the latest stored size, even while focused: tracking
  // focus misfires on a tab switch, where the field blurs but stays the
  // document's active element. A draft not yet committed is replaced.
  let sizeChanged = false;
  let themeChanged = false;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.hasOwn(changes, 'fontSize')) {
      sizeChanged = true;
      sizeEl.value = String(fontSizeFrom(changes.fontSize.newValue));
    }
    if (Object.hasOwn(changes, 'theme')) {
      themeChanged = true;
      themeEl.value = themeFrom(changes.theme.newValue);
    }
  });

  // the inputs start disabled in options.html and stay so on a failed load,
  // so a stored value is never overwritten by one typed over an empty field
  const stored: { settings?: Settings; fontSize?: unknown; theme?: unknown } | null = await browser.storage.local
    .get(['settings', 'fontSize', 'theme'])
    .catch(warnOr('load settings', null));
  if (stored === null) {
    $('error').hidden = false;
    return;
  }
  inputEl.value = stored.settings?.defaultTitle || DEFAULT_TITLE;
  inputEl.disabled = false;
  if (!sizeChanged) sizeEl.value = String(fontSizeFrom(stored.fontSize));
  sizeEl.disabled = false;
  if (!themeChanged) themeEl.value = themeFrom(stored.theme);
  themeEl.disabled = false;

  // one tiny key, so every input is saved at once and nothing is lost on close
  inputEl.addEventListener('input', () => {
    const settings: Settings = { defaultTitle: inputEl.value.trim() || DEFAULT_TITLE };
    browser.storage.local.set({ settings }).catch(warn('save settings'));
  });

  // on change, not input: typing "16" would first broadcast "1", clamped to
  // 10, to every open note tab
  sizeEl.addEventListener('change', () => {
    const fontSize = fontSizeFrom(parseFloat(sizeEl.value));
    sizeEl.value = String(fontSize);
    browser.storage.local.set({ fontSize }).catch(warn('save font size'));
  });

  themeEl.addEventListener('change', () => {
    browser.storage.local.set({ theme: themeFrom(themeEl.value) }).catch(warn('save theme'));
  });
})();
