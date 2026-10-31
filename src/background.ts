// Background script: the toolbar button opens a new note tab under the
// current tab, binned notes past their bin days are purged, and images no
// note references are swept.

import {
  noteUrl, notesFromStorage, storageKey, idFromStorageKey, expired, imageKey, sweepImages,
  withoutReferenced, orphansAfterFailedRemove, sameOrphans, type ImageOrphans,
} from './lib/notes.ts';

(function () {
  const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

  const warn = (what: string) => (err: unknown) => console.warn(`tabnotes: ${what}:`, err);
  const warnOr = <T>(what: string, fallback: T) => (err: unknown): T => {
    warn(what)(err);
    return fallback;
  };

  // fires only because browser_action has no default_popup; openerTabId is
  // what Sidebery nests the note under, index places it next to the parent;
  // windowId keeps it in the parent's window, which tabs.create requires of
  // an opener when that window is not the last focused one
  browser.browserAction.onClicked.addListener((tab) => {
    const url = noteUrl(browser.runtime.getURL('note/note.html'), crypto.randomUUID());
    const props = { url, openerTabId: tab.id, windowId: tab.windowId, index: tab.index + 1 };
    browser.tabs.create(props).catch(warn('open note tab'));
  });

  const purge = async () => {
    const removeKeys = async (keys: string[], what: string): Promise<boolean> => {
      if (keys.length === 0) return true;
      return browser.storage.local.remove(keys).then(() => true).catch(warnOr(what, false));
    };

    const readNotes = async (what: string) => {
      const keys = await browser.storage.local.getKeys().catch(warnOr(`list keys for ${what}`, null));
      if (keys === null) return null;
      // never get(null): that would load the bytes of every image
      const noteKeys = keys.filter((k) => idFromStorageKey(k) !== null);
      const stored = await browser.storage.local.get([...noteKeys, 'imageOrphans'])
        .catch(warnOr(`load notes for ${what}`, null));
      return stored === null ? null : { keys, stored };
    };

    const read = await readNotes('purge');
    if (read === null) return;
    const { keys: allKeys, stored } = read;
    const now = Date.now();
    const notes = notesFromStorage(stored);
    const expiredIds = Object.keys(notes).filter((id) => expired(notes[id], now));
    // a note that failed to go stays stored, so its references still count
    if (await removeKeys(expiredIds.map(storageKey), 'purge notes')) {
      for (const id of expiredIds) delete notes[id];
    }

    const orphans = (stored.imageOrphans as ImageOrphans | undefined) ?? {};
    const sweep = sweepImages(allKeys, notes, orphans, now);
    // an image past its grace can get a reference again, from undo or a copied
    // note, and storage has no transactions: this read leaves only saves that
    // land just before the remove, and text a tab has not saved yet
    const removeImages = async (): Promise<ImageOrphans> => {
      if (sweep.remove.length === 0) return sweep.orphans;
      const fresh = await readNotes('image sweep');
      // the first sweep's changes go too: a failed read writes nothing
      if (fresh === null) return orphans;
      const current = withoutReferenced(sweep, notesFromStorage(fresh.stored));
      const removed = await removeKeys(current.remove.map(imageKey), 'purge images');
      return removed ? current.orphans : orphansAfterFailedRemove(current, orphans);
    };
    const kept = await removeImages();
    if (sameOrphans(kept, orphans)) return;
    await browser.storage.local.set({ imageOrphans: kept }).catch(warn('save image orphans'));
  };

  // a persistent background page keeps running, so no alarms permission
  purge();
  setInterval(purge, PURGE_INTERVAL_MS);
})();
