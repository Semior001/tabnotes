// All notes page glue: lists every stored note split into open tabs, recently
// closed tabs, other notes and the bin, and exports and imports notes. Pure
// logic lives in lib/notes.ts.

import {
  classify, closedDaysLeftText, countText, matches, idFromStorageKey, notesFromStorage, noteUrl, storageKey, edit, trash, restore, daysLeftText,
  exportSummary, importSummary, rowText, searchParts, selectRange, setTemporary, shortDate, DEFAULT_TITLE, type ClosedNotes, type Entry, type Note, type RecentEntry, type Sections, type Settings, type StopMessage,
} from '../lib/notes.ts';
import { exportZip, importFiles, saveBlob } from '../transfer.ts';

// what became of a note a bulk action touched: gone means there was nothing
// left to do, which is neither a success to count nor a failure to report
type Outcome = 'written' | 'gone' | 'failed';
// a status line's past tense, participle and tail
type Words = [string, string, string];

(function () {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const searchEl = $<HTMLInputElement>('search');
  const binEl = $<HTMLDetailsElement>('bin-details');
  const barEl = $('bar');
  const noteBase = browser.runtime.getURL('note/note.html');
  const sections = ['open', 'recent', 'other', 'bin'] as const;
  const PREVIEW_LEN = 200;
  let groups: Sections = { open: [], recent: [], other: [], bin: [] };
  // computed per refresh, as search renders on every keystroke
  let texts = new Map<string, ReturnType<typeof rowText>>();
  // buttons of the last render by data-action, to keep keyboard focus on the
  // same action when a refresh replaces them
  let rendered = new Map<string, HTMLElement>();
  let seq = 0;
  let applied = 0;
  let loaded = false;
  let defaultTitle = DEFAULT_TITLE;
  let closedNotes: ClosedNotes = {};
  // the Bin's state before a search opened it, null with no such search
  let binBefore: boolean | null = null;
  // live and Bin selections stay apart, so a permanent delete cannot be mixed
  // into a move; state lives here, as refresh replaces every row
  let selected = new Set<string>();
  let scope: 'live' | 'bin' | null = null;
  let anchor: string | null = null;
  let busy = false;
  // notes the last move binned, which Undo restores
  let undo: string[] = [];
  let visible = { open: [] as string[], recent: [] as string[], other: [] as string[], bin: [] as string[] };

  // settings names notes through its default title and closedNotes holds their
  // countdowns; other keys do not change the list
  const affectsList = (key: string) => idFromStorageKey(key) !== null || key === 'settings' || key === 'closedNotes';

  const warn = (what: string) => (err: unknown) => console.warn(`tabnotes: ${what}:`, err);
  const warnOr = <T>(what: string, fallback: T) => (err: unknown): T => {
    warn(what)(err);
    return fallback;
  };

  // user data only ever goes through textContent, never innerHTML
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const n = document.createElement(tag);
    n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // every action refreshes afterwards, whether it succeeded or not; name is
  // stable across renders, unlike label, and keys the kept focus
  const button = (name: string, label: string, run: () => Promise<unknown>) => {
    const b = el('button', 'action', label);
    b.type = 'button';
    b.dataset.action = name;
    b.addEventListener('click', () => run().then(() => refresh()));
    return b;
  };

  // a closing tab's pagehide write can land after tabs.remove resolves, so
  // tabs are stopped first; tabs that do not reply have nothing to save
  const closeTabs = async (item: Entry) => {
    const ids = item.tabs.map((t) => t.tabId);
    if (ids.length === 0) return;
    await Promise.all(
      ids.map((tabId) =>
        browser.runtime.sendMessage({ type: 'stop', id: item.id, tabId } satisfies StopMessage).catch(warn('stop note tab')),
      ),
    );
    await browser.tabs.remove(ids).catch(warn('close note tabs'));
  };

  // reload re-reads the note after its tabs stopped, so their final flush is
  // kept; null when it is gone, undefined when it cannot be read
  const reload = async (key: string): Promise<Note | null | undefined> => {
    try {
      const stored = await browser.storage.local.get(key);
      return stored[key] || null;
    } catch (err) {
      warn('reload note')(err);
      return undefined;
    }
  };

  const landed = (write: Promise<void>, what: string): Promise<Outcome> =>
    write.then(() => 'written' as const, (err) => {
      warn(what)(err);
      return 'failed' as const;
    });

  // a second trash would reset the note's 30 days, so a note binned from
  // elsewhere since the list was drawn is left alone
  const trashItem = async (item: Entry): Promise<Outcome> => {
    await closeTabs(item);
    const key = storageKey(item.id);
    const fresh = await reload(key);
    if (fresh === undefined) return 'failed';
    if (fresh === null || fresh.deletedAt !== null) return 'gone';
    return landed(browser.storage.local.set({ [key]: trash(fresh, Date.now()) }), 'trash note');
  };

  // open note tabs pick the restored state up through storage.onChanged; a
  // blank note is removed, as edit() does for any blank note outside the bin
  const restoreItem = async ({ id }: { id: string }): Promise<Outcome> => {
    const key = storageKey(id);
    const fresh = await reload(key);
    if (fresh === undefined) return 'failed';
    if (fresh === null || fresh.deletedAt === null) return 'gone';
    const next = edit(restore(fresh, Date.now()), fresh.content, fresh.updatedAt);
    if (next !== null) return landed(browser.storage.local.set({ [key]: next }), 'restore note');
    const removed = await landed(browser.storage.local.remove(key), 'remove blank note');
    return removed === 'written' ? 'gone' : removed;
  };

  // confirm blocks this page while other tabs run, so a note restored from its
  // tab behind the dialog must survive
  const removeItem = async (item: Entry): Promise<Outcome> => {
    await closeTabs(item);
    const key = storageKey(item.id);
    const fresh = await reload(key);
    if (fresh === undefined) return 'failed';
    if (fresh === null || fresh.deletedAt === null) return 'gone';
    return landed(browser.storage.local.remove(key), 'delete note');
  };

  // open tabs adopt the kind through storage.onChanged, so nothing is stopped; a
  // note already of that kind is not stamped, which would restart its 30 days
  const setKindItem = (temporary: boolean) => async ({ id }: { id: string }): Promise<Outcome> => {
    const key = storageKey(id);
    const fresh = await reload(key);
    if (fresh === undefined) return 'failed';
    if (fresh === null || fresh.deletedAt !== null || (fresh.temporary === true) === temporary) return 'gone';
    return landed(browser.storage.local.set({ [key]: setTemporary(fresh, temporary, Date.now()) }), 'change note kind');
  };

  const report = (outcomes: Outcome[], [done, part, tail]: Words) => {
    const written = outcomes.filter((o) => o === 'written').length;
    const failed = outcomes.filter((o) => o === 'failed').length;
    const text = failed === 0
      ? `${done} ${countText(written, 'note')}${tail}`
      : `${done} ${written} of ${countText(written + failed, 'note')}${tail}. ${failed} could not be ${part}.`;
    $('status-text').textContent = text;
    $('status').hidden = written + failed === 0;
  };

  // A run owns what it acts on: the selection is cleared and later clicks are
  // ignored, as a second trash would reset deletedAt. Storage and tab events
  // still render during it, which is why the items are taken up front.
  const bulk = async <T extends { id: string }>(
    items: T[],
    act: (item: T) => Promise<Outcome>,
    words: Words,
    undoable: (done: string[], failed: string[]) => string[],
  ) => {
    if (busy || items.length === 0) return;
    busy = true;
    undo = [];
    $('status-undo').hidden = true;
    clearSelection();
    render();
    const outcomes = await Promise.all(items.map(act));
    const ids = (o: Outcome) => items.filter((_, i) => outcomes[i] === o).map((item) => item.id);
    busy = false;
    undo = undoable(ids('written'), ids('failed'));
    report(outcomes, words);
    $('status-undo').hidden = undo.length === 0;
    if (undo.length > 0) $('status-undo').focus();
  };

  const MOVED: Words = ['Moved', 'moved', ' to the Bin'];
  const RESTORED: Words = ['Restored', 'restored', ''];
  const DELETED: Words = ['Deleted', 'deleted', ' forever'];
  const TO_PERMANENT: Words = ['Changed', 'changed', ' to permanent'];
  const TO_TEMPORARY: Words = ['Changed', 'changed', ' to temporary'];

  const moveItems = (items: Entry[]) => bulk(items, trashItem, MOVED, (done) => done);
  const restoreItems = (items: Entry[]) => bulk(items, restoreItem, RESTORED, () => []);
  const setKindItems = (items: Entry[], temporary: boolean) =>
    bulk(items, setKindItem(temporary), temporary ? TO_TEMPORARY : TO_PERMANENT, () => []);
  const undoMove = () => bulk(undo.map((id) => ({ id })), restoreItem, RESTORED, (_, failed) => failed);

  const deleteItems = (items: Entry[], question: string) => {
    if (busy || !confirm(question)) return Promise.resolve();
    return bulk(items, removeItem, DELETED, () => []);
  };

  // Export and import share busy with bulk runs, so an import cannot plan
  // against storage a run is changing, and they end a pending Undo like a run.
  // An export keeps the selection: it changes nothing. Imported notes appear
  // through storage.onChanged. Refused while busy with a message, as a picked
  // file would otherwise be dropped unseen.
  const transfer = async (what: string, run: () => Promise<string>) => {
    if (busy) {
      $('status-text').textContent = `Could not ${what}: another action is running.`;
      $('status').hidden = false;
      return;
    }
    busy = true;
    undo = [];
    $('status-undo').hidden = true;
    let text: string;
    try {
      text = await run();
    } catch (err) {
      warn(what)(err);
      text = `Could not ${what}: ${err instanceof Error ? err.message : String(err)}.`;
    }
    busy = false;
    $('status-text').textContent = text;
    $('status').hidden = false;
  };

  const exportNotes = (ids: string[] | null) => transfer('export notes', async () => {
    const got = await exportZip(ids);
    saveBlob(got.blob, got.name);
    return exportSummary(got.notes, got.broken);
  });

  const deleteQuestion = (items: Entry[]) =>
    items.length === 1 ? `Delete "${texts.get(items[0].id)?.name}" forever?` : `Delete ${items.length} notes forever?`;

  const kindButton = (item: Entry) => {
    const { temporary } = item.note;
    return button('kind', temporary ? 'Make permanent' : 'Make temporary', () => setKindItems([item], !temporary));
  };

  // each row's item matches its section, which the types cannot follow through
  // the loop in render, so RecentEntry below is cast
  const actions = (section: keyof Sections, item: Entry): HTMLButtonElement[] => {
    switch (section) {
      case 'open': {
        const tab = item.tabs[0];
        return [
          button('go', 'Go to tab', () =>
            Promise.all([
              browser.tabs.update(tab.tabId, { active: true }).catch(warn('focus tab')),
              browser.windows.update(tab.windowId, { focused: true }).catch(warn('focus window')),
            ]),
          ),
          kindButton(item),
          button('trash', 'Move to Bin', () => moveItems([item])),
        ];
      }
      case 'recent': {
        const { fromWindow, windowTabCount, sessionId } = item as RecentEntry;
        return [
          button('restore-session', fromWindow ? `Restore window (${windowTabCount} tabs)` : 'Restore tab', () =>
            browser.sessions.restore(sessionId).catch(warn('restore session')),
          ),
          kindButton(item),
          button('trash', 'Move to Bin', () => moveItems([item])),
        ];
      }
      case 'other':
        return [
          button('open', 'Open', () =>
            browser.tabs.create({ url: noteUrl(noteBase, item.id) }).catch(warn('open note')),
          ),
          kindButton(item),
          button('trash', 'Move to Bin', () => moveItems([item])),
        ];
      case 'bin':
        return [
          button('restore', 'Restore', () => restoreItems([item])),
          button('delete-forever', 'Delete forever', () => deleteItems([item], deleteQuestion([item]))),
        ];
    }
  };

  const scopeOf = (section: keyof Sections) => (section === 'bin' ? 'bin' : 'live');
  const scopeIds = (s: 'live' | 'bin') => (s === 'bin' ? visible.bin : [...visible.open, ...visible.recent, ...visible.other]);

  const clearSelection = () => {
    selected = new Set();
    scope = null;
    anchor = null;
  };

  const enterScope = (section: keyof Sections) => {
    if (scope !== scopeOf(section)) clearSelection();
    scope = scopeOf(section);
  };

  const pick = (section: keyof Sections, id: string, checked: boolean, range: boolean) => {
    enterScope(section);
    const ids = range && anchor !== null ? selectRange(scopeIds(scopeOf(section)), anchor, id) : [id];
    for (const i of ids) {
      if (checked || range) selected.add(i);
      else selected.delete(i);
    }
    anchor = id;
    render();
  };

  // user text, so hits are nodes rather than markup
  const hits = (className: string, text: string) => {
    const parts = searchParts(text, searchEl.value, PREVIEW_LEN);
    if (parts.every((p) => !p.hit)) return el('span', className, parts.map((p) => p.text).join(''));
    const span = el('span', className);
    span.append(...parts.map((p) => el(p.hit ? 'mark' : 'span', '', p.text)));
    return span;
  };

  // the first action of a row runs from its main area, which names it for
  // assistive tech and in the tooltip: a restore can reopen a whole window
  const mainArea = (action: HTMLButtonElement | undefined, name: string, preview: string) => {
    const parts = [hits('name', name), hits('preview', preview)];
    if (!action) {
      const area = el('div', 'row-main');
      area.append(...parts);
      return area;
    }
    const label = `${action.textContent}: ${name}`;
    action.className = 'row-main';
    action.textContent = '';
    action.title = label;
    action.setAttribute('aria-label', label);
    action.append(...parts);
    return action;
  };

  const entry = (section: keyof Sections, item: Entry, now: number) => {
    const li = el('li', selected.has(item.id) ? 'entry selected' : 'entry');
    const { name, preview } = texts.get(item.id)!;
    const box = el('input', 'pick');
    box.type = 'checkbox';
    box.checked = selected.has(item.id);
    box.setAttribute('aria-label', `Select ${name}`);
    box.dataset.action = `${item.id} pick`;
    rendered.set(box.dataset.action, box);
    box.addEventListener('click', (e) => {
      // not every platform focuses a clicked checkbox, and the search field may be about to hide
      box.focus();
      pick(section, item.id, box.checked, e.shiftKey);
    });
    const acts = actions(section, item);
    for (const b of acts) {
      b.dataset.action = `${item.id} ${b.dataset.action}`;
      rendered.set(b.dataset.action, b);
    }
    const { note } = item;
    const binned = note.deletedAt !== null;
    const age = note.deletedAt !== null ? el('span', 'days', daysLeftText(note, now)) : el('span', 'date', shortDate(note.updatedAt, now));
    age.title = new Date(note.updatedAt).toLocaleString();
    const bar = el('div', 'actions');
    bar.append(...(binned ? acts : acts.slice(1)));
    li.append(box, mainArea(binned ? undefined : acts[0], name, preview));
    if (!binned && note.temporary) {
      li.append(el('span', 'temporary', 'Temporary'));
      // the map can be one interval stale, so an open note shows no clock
      if (section !== 'open') li.append(el('span', 'days', closedDaysLeftText(closedNotes[item.id], note, now)));
    }
    li.append(age, bar);
    return li;
  };

  const renderBar = () => {
    const active = document.activeElement as HTMLElement | null;
    const inBar = active !== null && barEl.contains(active);
    const was = !barEl.hidden;
    const on = selected.size > 0;
    barEl.hidden = !on;
    $('header').hidden = on;
    $('bar-count').textContent = `${selected.size} selected`;
    $('bar-move').hidden = scope !== 'live';
    $('bar-permanent').hidden = scope !== 'live';
    $('bar-temporary').hidden = scope !== 'live';
    $('bar-restore').hidden = scope !== 'bin';
    $('bar-delete').hidden = scope !== 'bin';
    // hiding the focused control would drop focus on the page
    if (was && !on && (inBar || active === null || active === document.body)) searchEl.focus();
  };

  const render = () => {
    const q = searchEl.value;
    const now = Date.now();
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.action;
    rendered = new Map();
    const rows = {
      open: groups.open.filter((item) => matches(item, q, defaultTitle)),
      recent: groups.recent.filter((item) => matches(item, q, defaultTitle)),
      other: groups.other.filter((item) => matches(item, q, defaultTitle)),
      bin: groups.bin.filter((item) => matches(item, q, defaultTitle)),
    };
    visible = {
      open: rows.open.map((i) => i.id),
      recent: rows.recent.map((i) => i.id),
      other: rows.other.map((i) => i.id),
      bin: rows.bin.map((i) => i.id),
    };
    // by scope, not by all visible rows: a Bin selection must lose a note
    // restored elsewhere, or Delete forever would remove a live note
    if (scope !== null) {
      const ids = new Set(scopeIds(scope));
      selected = new Set([...selected].filter((id) => ids.has(id)));
      if (selected.size === 0) clearSelection();
    }
    let shown = 0;
    for (const s of sections) {
      const items = rows[s].map((item) => entry(s, item, now));
      shown += items.length;
      $(s).replaceChildren(...items);
      $(`${s}-section`).hidden = items.length === 0;
      $(`${s}-count`).textContent = `(${items.length})`;
      const picked = visible[s].filter((id) => selected.has(id)).length;
      const all = $<HTMLInputElement>(`${s}-all`);
      all.checked = picked > 0 && picked === items.length;
      all.indeterminate = picked > 0 && picked < items.length;
    }
    const emptyEl = $('empty');
    emptyEl.hidden = !loaded || shown > 0;
    emptyEl.textContent = q.trim() ? `No notes match "${q.trim()}".` : 'No notes yet. Create one with New permanent note or New temporary note.';
    if (focused) rendered.get(focused)?.focus();
    renderBar();
  };

  const refresh = async (): Promise<void> => {
    const id = ++seq;
    let data;
    try {
      // never get(null): that would load the bytes of every image
      const keys = await browser.storage.local.getKeys();
      data = await Promise.all([
        browser.storage.local.get(keys.filter(affectsList)),
        browser.tabs.query({}),
        browser.sessions.getRecentlyClosed(),
      ]);
    } catch (err) {
      warn('refresh')(err);
      $('error').hidden = false;
      return;
    }
    // events can fire in bursts; a slower, older refresh must not overwrite
    // the result of a newer one, but may still apply when the newer one failed
    if (id < applied) return;
    applied = id;
    $('error').hidden = true;
    loaded = true;
    const [stored, tabs, closed] = data;
    groups = classify(notesFromStorage(stored), tabs, closed, noteBase);
    defaultTitle = (stored.settings as Settings | undefined)?.defaultTitle || DEFAULT_TITLE;
    closedNotes = (stored.closedNotes as ClosedNotes | undefined) ?? {};
    texts = new Map(sections.flatMap((s) => groups[s]).map((item) => [item.id, rowText(item.note, defaultTitle)]));
    render();
  };

  // only on these transitions, so a refresh cannot reopen a Bin the user closed
  searchEl.addEventListener('input', () => {
    const q = searchEl.value;
    if (q.trim() === '' && binBefore !== null) {
      binEl.open = binBefore;
      binBefore = null;
    }
    if (q.trim() !== '' && binBefore === null && groups.bin.some((item) => matches(item, q, defaultTitle))) {
      binBefore = binEl.open;
      binEl.open = true;
    }
    render();
  });
  const selectedItems = () => sections.flatMap((s) => groups[s]).filter((item) => selected.has(item.id));
  $('bar-move').addEventListener('click', () => moveItems(selectedItems()).then(() => refresh()));
  $('bar-restore').addEventListener('click', () => restoreItems(selectedItems()).then(() => refresh()));
  $('bar-delete').addEventListener('click', () => {
    const items = selectedItems();
    deleteItems(items, deleteQuestion(items)).then(() => refresh());
  });
  $('empty-bin').addEventListener('click', () => {
    const items = groups.bin;
    deleteItems(items, `Delete ${items.length === 1 ? 'the note' : `all ${items.length} notes`} in the Bin forever?`).then(() => refresh());
  });
  $('export-all').addEventListener('click', () => exportNotes(null));
  $('bar-export').addEventListener('click', () => exportNotes(selectedItems().map((item) => item.id)));
  const fileEl = $<HTMLInputElement>('import-file');
  $('import-notes').addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', () => {
    const files = [...(fileEl.files ?? [])];
    // cleared, so picking the same file again fires change
    fileEl.value = '';
    if (files.length === 0) return;
    transfer('import notes', async () => {
      const result = await importFiles(files);
      if ('stopped' in result) warn('import notes')(result.stopped);
      return importSummary(result);
    });
  });
  $('status-undo').addEventListener('click', () => undoMove().then(() => refresh()));
  $('bar-clear').addEventListener('click', () => {
    clearSelection();
    render();
  });
  for (const s of sections) {
    const all = $<HTMLInputElement>(`${s}-all`);
    all.addEventListener('click', () => {
      all.focus();
      enterScope(s);
      for (const id of visible[s]) {
        if (all.checked) selected.add(id);
        else selected.delete(id);
      }
      render();
    });
  }
  binEl.addEventListener('toggle', () => {
    if (binEl.open || scope !== 'bin') return;
    const inside = binEl.contains(document.activeElement);
    clearSelection();
    render();
    if (inside) $('bin-summary').focus();
  });
  for (const kind of ['permanent', 'temporary'] as const) {
    $(`bar-${kind}`).addEventListener('click', () => setKindItems(selectedItems(), kind === 'temporary').then(() => refresh()));
    $(`new-${kind}`).addEventListener('click', () => {
      browser.tabs.create({ url: noteUrl(noteBase, crypto.randomUUID(), kind === 'temporary') }).catch(warn(`new ${kind} note`));
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected.size > 0) {
      clearSelection();
      render();
      return;
    }
    const target = e.target as HTMLInputElement;
    const typing = target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type !== 'checkbox');
    // a selection hides the search field; without preventDefault the / lands in it
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || typing || selected.size > 0) return;
    e.preventDefault();
    searchEl.focus();
  });
  $('settings').addEventListener('click', () => {
    browser.runtime.openOptionsPage().catch(warn('open settings'));
  });
  browser.storage.onChanged.addListener((changes) => {
    if (Object.keys(changes).some(affectsList)) refresh();
  });
  browser.sessions.onChanged.addListener(() => refresh());
  browser.tabs.onRemoved.addListener(() => refresh());
  // moving a tab to another window or replacing it changes windowId / tabId
  browser.tabs.onAttached.addListener(() => refresh());
  browser.tabs.onReplaced.addListener(() => refresh());
  // title, status and favicon updates cannot change which note a tab maps to
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) refresh();
  });
  refresh();
})();
