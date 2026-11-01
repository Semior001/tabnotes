// Background script: the toolbar button opens a new note tab under the
// current tab, binned notes past their bin days are purged, images no note
// references are swept, and temporary notes closed for too long are binned.

import {
  noteUrl, notesFromStorage, storageKey, idFromStorageKey, expired, imageKey, sweepImages,
  withoutReferenced, orphansAfterFailedRemove, sameFirstSeen, noteIdFromUrl, sweepClosed,
  closedAfterFailedWrite, stillDue, trashClosed, type ImageOrphans, type ClosedNotes,
} from './lib/notes.ts';

(function () {
  const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const CLOSE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
  const noteBase = browser.runtime.getURL('note/note.html');

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
    const url = noteUrl(noteBase, crypto.randomUUID());
    const props = { url, openerTabId: tab.id, windowId: tab.windowId, index: tab.index + 1 };
    browser.tabs.create(props).catch(warn('open note tab'));
  });

  const readNotes = async (what: string, mapKey: string) => {
    const keys = await browser.storage.local.getKeys().catch(warnOr(`list keys for ${what}`, null));
    if (keys === null) return null;
    // never get(null): that would load the bytes of every image
    const noteKeys = keys.filter((k) => idFromStorageKey(k) !== null);
    const stored = await browser.storage.local.get([...noteKeys, mapKey])
      .catch(warnOr(`load notes for ${what}`, null));
    return stored === null ? null : { keys, stored };
  };

  const purge = async () => {
    const removeKeys = async (keys: string[], what: string): Promise<boolean> => {
      if (keys.length === 0) return true;
      return browser.storage.local.remove(keys).then(() => true).catch(warnOr(what, false));
    };

    const read = await readNotes('purge', 'imageOrphans');
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
      const fresh = await readNotes('image sweep', 'imageOrphans');
      // the first sweep's changes go too: a failed read writes nothing
      if (fresh === null) return orphans;
      const current = withoutReferenced(sweep, notesFromStorage(fresh.stored));
      const removed = await removeKeys(current.remove.map(imageKey), 'purge images');
      return removed ? current.orphans : orphansAfterFailedRemove(current, orphans);
    };
    const kept = await removeImages();
    if (sameFirstSeen(kept, orphans)) return;
    await browser.storage.local.set({ imageOrphans: kept }).catch(warn('save image orphans'));
  };

  const expireClosed = async () => {
    const openNoteIds = async (what: string) => {
      const tabs = await browser.tabs.query({}).catch(warnOr(what, null));
      if (tabs === null) return null;
      return new Set(tabs.flatMap((tab) => noteIdFromUrl(tab.url, noteBase) ?? []));
    };

    // any failed read stops the sweep: with no tab list every note looks closed
    const read = await readNotes('close sweep', 'closedNotes');
    if (read === null) return;
    const open = await openNoteIds('list tabs for close sweep');
    if (open === null) return;
    const now = Date.now();
    const notes = notesFromStorage(read.stored);
    const closed = (read.stored.closedNotes as ClosedNotes | undefined) ?? {};
    const sweep = sweepClosed(notes, open, closed, now);

    // unlike a tab, this writes a note it does not hold: storage has no
    // transactions, so the read narrows the race with a save and does not close
    // it. null means a read failed and the map stays as it is.
    const binDue = async (): Promise<ClosedNotes | null> => {
      if (sweep.due.length === 0) return sweep.closed;
      const fresh = await browser.storage.local.get(sweep.due.map(storageKey))
        .catch(warnOr('load due notes', null));
      if (fresh === null) return null;
      const openNow = await openNoteIds('list tabs for due notes');
      if (openNow === null) return null;
      const due = stillDue(sweep.due, notes, notesFromStorage(fresh), openNow);
      const failed = await Promise.all(due.map(({ id, note }) =>
        browser.storage.local.set({ [storageKey(id)]: trashClosed(note, now) })
          .then(() => null).catch(warnOr('bin closed note', id))));
      return closedAfterFailedWrite(sweep, failed.filter((id) => id !== null), closed);
    };

    const kept = await binDue();
    if (kept === null || sameFirstSeen(kept, closed)) return;
    await browser.storage.local.set({ closedNotes: kept }).catch(warn('save closed notes'));
  };

  // a persistent background page keeps running, so no alarms permission
  purge();
  setInterval(purge, PURGE_INTERVAL_MS);
  // not at startup: this page starts before session restore, so open tabs
  // would look closed. A sweep during a slow restore can only add an entry,
  // which a later one clears, as binning needs an entry already 30 days old.
  setInterval(expireClosed, CLOSE_SWEEP_INTERVAL_MS);
})();
