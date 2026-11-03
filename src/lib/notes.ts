// Pure note logic shared by the note, All notes and background pages and
// node tests. Must not touch the DOM or browser.*.

import type { MarkedExtension, Token, Tokens } from 'marked';

// LiveNote and BinnedNote split on deletedAt, so the bin countdown can only be
// asked of a note known to be binned. temporary is absent on a permanent note,
// never false, so notes stored before the flag existed stay permanent.
// restoredAt restarts the close clock: an All notes restore keeps updatedAt,
// and no sweep may have seen the note binned to clear its closedNotes entry.
interface LiveNote {
  title: string;
  content: string;
  updatedAt: number;
  deletedAt: null;
  temporary?: true;
  restoredAt?: number;
}

// binDays is set only on an auto-expired note; absent means BIN_DAYS
export type BinnedNote = Omit<LiveNote, 'deletedAt'> & { deletedAt: number; binDays?: number };

export type Note = LiveNote | BinnedNote;

// NoteChange is a storage.onChanged entry for a note key
export interface NoteChange {
  newValue?: Note;
}

export interface Settings {
  defaultTitle: string;
  temporary?: true;
}

export const DEFAULT_TITLE = 'Notes';

interface TitleVars {
  date: string;
  time: string;
  weekday: string;
  tab: string;
  host: string;
}

// TITLE_HINT lists what expandTitle accepts, for Settings and the rename input
export const TITLE_HINT = 'Variables: {date}, {time}, {weekday}, {tab} (the tab the note was opened from), {host} (its hostname). '
  + 'Functions: trunc N, lower, upper, as in {tab | trunc 30}.';

// ImageValue is the stored value of an image:<id> key
export interface ImageValue {
  dataUrl: string;
}

// ImageFile is the part of a File that decides whether it can be stored
export interface ImageFile {
  name: string;
  type: string;
  size: number;
}

// ImageOrphans maps an unreferenced image id to the time a sweep first found
// it so; the background page is its only writer.
export type ImageOrphans = Record<string, number>;

// ImageSweep is what a sweep decided: the ids to remove, and the orphans map
// as it should stand once they are gone.
export interface ImageSweep {
  remove: string[];
  orphans: ImageOrphans;
}

// ClosedNotes maps a live temporary note to the time a sweep first found it
// with no open tab; the background page is its only writer.
export type ClosedNotes = Record<string, number>;

// ClosedSweep is what a sweep decided: the ids to bin, and the map as it should
// stand once they are binned.
interface ClosedSweep {
  closed: ClosedNotes;
  due: string[];
}

// StopMessage asks a note tab to flush and stop writing, see All notes
export interface StopMessage {
  type: 'stop';
  id: string;
  tabId: number;
}

interface TabRef {
  tabId: number;
  windowId: number;
}

// Entry is one row of an All notes section
export interface Entry<N extends Note = Note> {
  id: string;
  note: N;
  tabs: TabRef[];
}

export interface RecentEntry extends Entry {
  sessionId: string;
  fromWindow: boolean;
  windowTabCount: number;
}

export interface Sections {
  open: Entry[];
  recent: RecentEntry[];
  other: Entry[];
  bin: Entry<BinnedNote>[];
}

// Pane is one of the two scrolling panes of the note page in split mode
export type Pane = 'editor' | 'preview';

// ThemeMode is the stored theme choice; system follows the OS preference
export type ThemeMode = 'system' | 'light' | 'dark';

// ScrollAnchor pairs a scroll position in one pane with the matching one in
// the other
interface ScrollAnchor {
  from: number;
  to: number;
}

// ZipEntry is one central directory entry; data is its compressed bytes, null
// when the local header or the data lie past the end of the zip.
export interface ZipEntry {
  name: string;
  compression: number;
  size: number;
  originalSize: number;
  data: Uint8Array | null;
}

export interface ExportResult {
  blob: Blob;
  name: string;
  notes: number;
  // ids of referenced images whose stored data URL does not decode
  broken: string[];
}

export interface ImportedNote {
  id: string;
  note: Note;
}

// LocalState is what an import checks against: the content of every stored
// note, and the ids stored or open in a note tab, as a cleared note's tab has
// no key but still holds its id.
interface LocalState {
  contents: Set<string>;
  taken: Set<string>;
}

interface ImportPlan {
  write: Record<string, Note>;
  // the notes skipped as already stored, whose images an import still restores
  identical: Note[];
  duplicates: number;
}

// ImportResult says what an import did; stopped is the error of the failed
// write that ended it, kept as thrown so the page logs it with its stack.
export interface ImportResult {
  imported: number;
  images: number;
  identical: number;
  copies: number;
  rejected: Record<string, number>;
  stopped?: unknown;
}

// ZipPath is how an import treats a zip entry by its name, name being it
// without leading ./ segments.
type ZipPath =
  | { kind: 'skip'; name: string }
  | { kind: 'unsupported'; name: string }
  | { kind: 'note'; name: string }
  | { kind: 'image'; name: string; id: string; mime: string };

// canOpen reports whether tabs.create accepts the URL; Firefox rejects
// file:, data:, javascript: and privileged about: URLs.
export function canOpen(url: unknown): boolean {
  if (typeof url !== 'string' || url === '') return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

// createDebouncer debounces run(); flush() runs a pending call synchronously
// so it can be called from pagehide without awaiting anything.
export function createDebouncer(run: () => void, delayMs: number): { schedule(): void; flush(): void; pending(): boolean } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, delayMs);
    },
    flush() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      run();
    },
    pending() {
      return timer !== undefined;
    },
  };
}

// every note lives under its own storage key so several note tabs can save
// at once without overwriting each other
const KEY_PREFIX = 'note:';
const IMAGE_KEY_PREFIX = 'image:';
const IMAGE_SCHEME = 'tabnotes-image:';
const ID_CHARS = '[0-9a-f-]{36}';
const ID_RE = new RegExp(`^${ID_CHARS}$`);
const IMAGE_REF_RE = new RegExp(`${IMAGE_SCHEME}(${ID_CHARS})`, 'g');
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const BIN_DAYS = 30;
const TEMPORARY_DAYS = 30;
const EXPIRED_BIN_DAYS = 7;
const IMAGE_GRACE_DAYS = 7;
const FONT_SIZE_DEFAULT = 14;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 32;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
// MAX_NOTE_BYTES limits one note file on import, as MAX_IMAGE_BYTES does one
// image; MAX_IMPORT_BYTES limits a zip file and the declared sizes admitted
// from it. MAX_ZIP_ENTRIES is the most entries an export can hold (zipFits),
// checked before the walk, as a zip64 record can claim billions.
export const MAX_NOTE_BYTES = MAX_IMAGE_BYTES;
export const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 0xffff;
// the front matter keys of a note file, in the order noteFile writes them
const NOTE_FILE_KEYS = ['id', 'title', 'updatedAt', 'deletedAt', 'temporary', 'binDays', 'restoredAt'] as const;
type NoteFileKey = typeof NOTE_FILE_KEYS[number];
// an image subtype as a file extension: starting with a letter or digit, so
// it cannot form a `..` name
const IMAGE_EXT = '[a-z0-9][a-z0-9.+-]*';
const EXPORT_REF_RE = new RegExp(`\\(${IMAGE_SCHEME}(${ID_CHARS})\\)`, 'g');
const IMPORT_REF_RE = new RegExp(`\\(\\.\\./images/(${ID_CHARS})\\.${IMAGE_EXT}\\)`, 'g');
const IMAGE_PATH_RE = new RegExp(`^images/(${ID_CHARS})\\.(${IMAGE_EXT})$`);
const IMAGE_MIME_RE = new RegExp(`^image/(${IMAGE_EXT})$`);
// STORAGE_FULL_HINT follows a failed write, of an image or a note
export const STORAGE_FULL_HINT = `Storage may be full, and deleted images free space only after ${IMAGE_GRACE_DAYS} days.`;
// KIND_HINT is the tooltip of the kind button on the note page
export const KIND_HINT = `Temporary notes move to the Bin after ${TEMPORARY_DAYS} days closed and are deleted ${EXPIRED_BIN_DAYS} days later. Click to switch.`;
// WELCOME_TITLE is the title of the welcome note
export const WELCOME_TITLE = 'Welcome to tabnotes';
// WELCOME_TEXT is the content of the note opened on first install and from
// Settings. It holds no URL (the static scan covers src/) and no raw HTML,
// which the preview shows escaped.
export const WELCOME_TEXT = `# Welcome to tabnotes

Each tab holds one note. It is saved as you type and stays in this Firefox profile: nothing leaves your computer.

## Try it

- [ ] Tick this box
- [ ] Press \`Ctrl+E\` (\`Cmd+E\` on macOS) to switch between both panes, the editor only and the preview only
- [ ] Click the title above to rename this note; a template like \`{date}\` fills in the date
- [ ] Click **Permanent** in the header to make this note temporary, and again to switch it back
- [ ] Open **All notes** in the header to find every note, open or closed

Hover over a code block to copy it:

\`\`\`js
const note = { title: 'Groceries', content: '- [ ] milk' };
console.log(note.title);
\`\`\`

## Permanent and temporary notes

A permanent note stays until you delete it. A temporary note moves to the Bin once it has been closed for ${TEMPORARY_DAYS} days. The Bin keeps notes for ${BIN_DAYS} days, or ${EXPIRED_BIN_DAYS} days for a temporary note that got there by itself, then deletes them.

\`\`\`mermaid
flowchart LR
  open[Open in a tab] -->|close the tab| closed[Closed]
  closed -->|reopen| open
  closed -->|temporary, ${TEMPORARY_DAYS} days| bin[Bin]
  open -->|Move to Bin| bin
  bin -->|Restore in All notes| closed
  bin -->|Restore in its tab| open
  bin -->|${BIN_DAYS} or ${EXPIRED_BIN_DAYS} days| deleted[Deleted]
\`\`\`

## Images

Drop or paste an image into the editor. It is stored with your notes.

## All notes and Settings

**All notes** lists open, recently closed and other notes, and the Bin, and can export notes to a zip and import them back. **Settings** sets the title template, the kind of notes the toolbar button creates, the theme and the font size, and **Open the welcome note** there brings this note back.

## Pin the button

Firefox may offer to pin the tabnotes button right after install. Otherwise it is in the Extensions menu (the puzzle piece in the toolbar): click the gear next to tabnotes and choose **Pin to Toolbar**.

## Before you remove tabnotes

Removing tabnotes deletes its notes. Export them first, from All notes or Settings.
`;
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// idAfter returns the id following prefix in s, or null if s is anything else
function idAfter(prefix: string, s: string): string | null {
  if (!s.startsWith(prefix)) return null;
  const id = s.slice(prefix.length);
  return ID_RE.test(id) ? id : null;
}

export function storageKey(id: string): string {
  return KEY_PREFIX + id;
}

export function idFromStorageKey(key: string): string | null {
  return idAfter(KEY_PREFIX, key);
}

export function imageKey(id: string): string {
  return IMAGE_KEY_PREFIX + id;
}

export function idFromImageKey(key: string): string | null {
  return idAfter(IMAGE_KEY_PREFIX, key);
}

// noteIdFromUrl returns the note id of a note-page URL, noteBase being
// runtime.getURL('note/note.html'), or null for any other URL.
export function noteIdFromUrl(url: string | undefined, noteBase: string): string | null {
  if (typeof url !== 'string' || !url.startsWith(noteBase + '?')) return null;
  // the prefix check guarantees a parseable moz-extension URL
  const id = new URL(url).searchParams.get('id');
  return id !== null && ID_RE.test(id) ? id : null;
}

// noteUrl is the note-page URL of a note, the inverse of noteIdFromUrl. With no
// temporary the note page picks the kind from settings.
export function noteUrl(noteBase: string, id: string, temporary?: boolean): string {
  const url = noteBase + '?id=' + id;
  return temporary === undefined ? url : `${url}&temporary=${temporary ? 1 : 0}`;
}

// temporaryFromUrl reads the kind noteUrl put into a note-page URL, or null
// with no valid parameter.
export function temporaryFromUrl(url: string): boolean | null {
  switch (new URL(url).searchParams.get('temporary')) {
    case '1': return true;
    case '0': return false;
    default: return null;
  }
}

// notesFromStorage picks the note entries out of a storage.local.get result
// as an id -> note map, skipping settings and any other key
export function notesFromStorage(stored: Record<string, unknown>): Record<string, Note> {
  const notes: Record<string, Note> = {};
  for (const [key, note] of Object.entries(stored)) {
    const id = idFromStorageKey(key);
    if (id !== null) notes[id] = note as Note;
  }
  return notes;
}

export function newNote(title: string, now: number, temporary: boolean): LiveNote {
  const note: LiveNote = { title, content: '', updatedAt: now, deletedAt: null };
  return temporary ? { ...note, temporary: true } : note;
}

export function welcomeNote(now: number): LiveNote {
  return { ...newNote(WELCOME_TITLE, now, false), content: WELCOME_TEXT };
}

// edit returns the edited note, or null when the note should be removed:
// blank content outside the bin. A binned note stays until restored or purged.
export function edit(note: Note, content: string, now: number): Note | null {
  if (!content.trim() && note.deletedAt === null) return null;
  return { ...note, content, updatedAt: now };
}

// nextStamp stays above updatedAt: a tab adopts an equal one, so the echo of an
// earlier write would take the change back.
const nextStamp = (note: Note, now: number) => Math.max(now, note.updatedAt + 1);

// rename returns the renamed note, or null for an empty title.
export function rename(note: Note, title: string, now: number): Note | null {
  if (title === '') return null;
  return { ...note, title, updatedAt: nextStamp(note, now) };
}

// setTemporary changes the kind. The same-kind check is the caller's: a stamp
// here would restart the 30 days.
export function setTemporary(note: LiveNote, temporary: boolean, now: number): LiveNote {
  const { temporary: _, ...rest } = note;
  const stamped: LiveNote = { ...rest, updatedAt: nextStamp(note, now) };
  return temporary ? { ...stamped, temporary: true } : stamped;
}

export function trash(note: Note, now: number): BinnedNote {
  return { ...note, deletedAt: now };
}

// trashClosed bins a temporary note closed for too long, for a shorter stay
// than a note binned by hand.
export function trashClosed(note: LiveNote, now: number): BinnedNote {
  return { ...trash(note, now), binDays: EXPIRED_BIN_DAYS };
}

export function restore(note: Note, now: number): LiveNote {
  // the cast only reaches binDays, which a live note does not have
  const { binDays: _, ...rest } = note as BinnedNote;
  return { ...rest, deletedAt: null, restoredAt: now };
}

const daysUntil = (start: number, days: number, now: number) =>
  Math.max(0, Math.ceil((start + days * DAY_MS - now) / DAY_MS));

export function daysLeft(note: BinnedNote, now: number): number {
  return daysUntil(note.deletedAt, note.binDays ?? BIN_DAYS, now);
}

// closedDaysLeft is the countdown of a closed temporary note. With no sighting
// yet its clock has not started.
export function closedDaysLeft(firstSeen: number | undefined, note: Note, now: number): number {
  return daysUntil(Math.max(firstSeen ?? now, note.updatedAt, note.restoredAt ?? 0), TEMPORARY_DAYS, now);
}

// countText is n with what, plural unless n is 1
export const countText = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

const leftText = (n: number) => `${countText(n, 'day')} left`;

// closedDaysLeftText is that countdown as All notes shows it
export function closedDaysLeftText(firstSeen: number | undefined, note: Note, now: number): string {
  return leftText(closedDaysLeft(firstSeen, note, now));
}

// daysLeftText is the bin countdown shown on the note page and All notes
export function daysLeftText(note: BinnedNote, now: number): string {
  return leftText(daysLeft(note, now));
}

export function expired(note: Note, now: number): boolean {
  return note.deletedAt !== null && daysLeft(note, now) === 0;
}

// classify splits notes into All notes sections. Binned notes go to bin
// regardless of tabs; others land in open > recent > other.
export function classify(
  notes: Record<string, Note>,
  tabs: browser.tabs.Tab[],
  closed: browser.sessions.Session[],
  noteBase: string,
): Sections {
  const open = new Map<string, Entry>();
  const bin = new Map<string, Entry<BinnedNote>>();
  for (const [id, note] of Object.entries(notes)) {
    if (note.deletedAt !== null) bin.set(id, { id, note, tabs: [] });
  }
  for (const tab of tabs) {
    const id = noteIdFromUrl(tab.url, noteBase);
    if (id === null || !Object.hasOwn(notes, id)) continue;
    // optional in the type for tabs out of the sessions API; these come from tabs.query
    const ref = { tabId: tab.id!, windowId: tab.windowId! };
    if (bin.has(id)) {
      bin.get(id)!.tabs.push(ref);
      continue;
    }
    if (!open.has(id)) open.set(id, { id, note: notes[id], tabs: [] });
    open.get(id)!.tabs.push(ref);
  }

  const recent = new Map<string, RecentEntry>();
  const recover = (tab: browser.tabs.Tab, sessionId: string | undefined, fromWindow: boolean, windowTabCount: number) => {
    const id = noteIdFromUrl(tab.url, noteBase);
    if (id === null || !Object.hasOwn(notes, id) || bin.has(id) || open.has(id) || recent.has(id)) return;
    // sessions.restore without an id restores the latest session, not this one
    if (sessionId === undefined) return;
    recent.set(id, { id, note: notes[id], tabs: [], sessionId, fromWindow, windowTabCount });
  };
  for (const s of closed) {
    if (s.tab) recover(s.tab, s.tab.sessionId, false, 1);
    if (!s.window) continue;
    const windowTabs = s.window.tabs ?? [];
    for (const tab of windowTabs) recover(tab, s.window.sessionId, true, windowTabs.length);
  }

  const other = Object.keys(notes)
    .filter((id) => !bin.has(id) && !open.has(id) && !recent.has(id))
    .map((id) => ({ id, note: notes[id], tabs: [] }));

  const byUpdated = (a: Entry, b: Entry) => b.note.updatedAt - a.note.updatedAt;
  return {
    open: [...open.values()].sort(byUpdated),
    recent: [...recent.values()].sort(byUpdated),
    other: other.sort(byUpdated),
    bin: [...bin.values()].sort((a, b) => b.note.deletedAt - a.note.deletedAt),
  };
}

const isDefaultTitle = (title: string, defaultTitle: string) => title === defaultTitle || title === DEFAULT_TITLE;

// matches is a case-insensitive substring search over title and content. A
// default title is skipped: it is not shown, and would match every such note.
export function matches(entry: Entry, query: string, defaultTitle: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const { title, content } = entry.note;
  return content.toLowerCase().includes(q) || (!isDefaultTitle(title, defaultTitle) && title.toLowerCase().includes(q));
}

// searchParts splits text around hits of query, for highlighting. Past max
// characters nothing shows, so a late first hit moves the window to it. An
// escaped regex, as toLowerCase() indexes shift on characters like İ.
export function searchParts(text: string, query: string, max: number): { text: string; hit: boolean }[] {
  const q = query.trim();
  if (q === '') return [{ text: text.slice(0, max), hit: false }];
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const lead = 20;
  const first = text.search(re);
  const start = first > lead ? first - lead : 0;
  const shown = text.slice(start, start + max);
  const parts = start > 0 ? [{ text: '...', hit: false }] : [];
  let at = 0;
  for (const m of shown.matchAll(re)) {
    if (m.index > at) parts.push({ text: shown.slice(at, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    at = m.index + m[0].length;
  }
  if (at < shown.length) parts.push({ text: shown.slice(at), hit: false });
  return parts;
}

// sourceLines splits a note into lines marked as inside a code fence or not,
// dropping the fence lines; an unclosed fence runs to the end, as in marked
function sourceLines(content: string): { text: string; fenced: boolean }[] {
  const lines: { text: string; fenced: boolean }[] = [];
  let fence: string | null = null;
  for (const text of content.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence === null) {
      if (m) fence = m[1];
      else lines.push({ text, fenced: false });
      continue;
    }
    const closes = m !== null && m[1][0] === fence[0] && m[1].length >= fence.length && m[2].trim() === '';
    if (closes) fence = null;
    else lines.push({ text, fenced: true });
  }
  return lines;
}

// inlinePlain strips the markdown of one line, by regex: this module has no
// runtime marked, and All notes would bundle it for a line of text otherwise
function inlinePlain(line: string): string {
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return '';
  return line
    .replace(/^\s*(?:>\s?)+/, '')
    .replace(/^\s*#{1,6}(?:\s+|$)/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])(?:\s+|$)/, '')
    .replace(/^\[[ xX]\](?:\s+|$)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*+|`+|~~/g, '')
    .replace(/(^|\W)_{1,2}(\S(?:.*?\S)?)_{1,2}(?=\W|$)/g, '$1$2')
    .trim();
}

const oneLine = (parts: string[]) => parts.join(' ').replace(/\s+/g, ' ').trim();

// a code-only note previews its code
function linesPreview(lines: { text: string; fenced: boolean }[]): string {
  const prose = lines.filter((l) => !l.fenced).map((l) => inlinePlain(l.text));
  return oneLine(prose) || oneLine(lines.filter((l) => l.fenced).map((l) => l.text));
}

// plainPreview is a note's content as one line of plain text
export function plainPreview(content: string): string {
  return linesPreview(sourceLines(content)) || oneLine([content]);
}

// rowText is what All notes shows for a note. A title is only ever the default
// the note was created with, which tells notes apart for nobody, so such a note
// is named by its first heading or line, and that line leaves the preview.
export function rowText(note: Note, defaultTitle: string): { name: string; preview: string } {
  if (!isDefaultTitle(note.title, defaultTitle)) return { name: note.title, preview: plainPreview(note.content) };
  const lines = sourceLines(note.content);
  const heading = lines.findIndex((l) => !l.fenced && /^ {0,3}#{1,6}\s+\S/.test(l.text));
  const prose = lines.findIndex((l) => !l.fenced && inlinePlain(l.text) !== '');
  const code = lines.findIndex((l) => l.fenced && l.text.trim() !== '');
  const at = [heading, prose, code].find((i) => i !== -1);
  if (at === undefined) return { name: note.title, preview: linesPreview(lines) };
  const { text, fenced } = lines[at];
  return {
    name: fenced ? text.trim() : inlinePlain(text),
    preview: linesPreview(lines.filter((_, i) => i !== at)),
  };
}

// selectRange is the ids from anchor to id in list order, or just id when the
// anchor has left the list
export function selectRange(ids: string[], anchor: string, id: string): string[] {
  const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)];
  if (a === -1 || b === -1) return [id];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// shortDate is a row's age, then its date; a clock behind the note's reads as now
export function shortDate(ts: number, now: number): string {
  const ago = now - ts;
  if (ago < MINUTE_MS) return 'now';
  if (ago < 60 * MINUTE_MS) return `${Math.floor(ago / MINUTE_MS)}m`;
  if (ago < DAY_MS) return `${Math.floor(ago / (60 * MINUTE_MS))}h`;
  if (ago < 7 * DAY_MS) return `${Math.floor(ago / DAY_MS)}d`;
  const date = new Date(ts);
  const year = date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year });
}

// titleVars has no host for anything but http(s): about: has none, and a
// moz-extension: hostname is a uuid, which a toolbar click from a note tab
// would put in the title.
export function titleVars(now: Date, source: { title?: string; url?: string } | null): TitleVars {
  const pad = (n: number) => String(n).padStart(2, '0');
  const url = source?.url ?? '';
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
    tab: source?.title ?? '',
    host: canOpen(url) ? new URL(url).hostname : '',
  };
}

// expandTitle makes one pass, so a value holding a placeholder is not expanded
// again. A placeholder it cannot evaluate stays as literal text.
export function expandTitle(template: string, vars: TitleVars): string {
  const apply = (value: string, call: string): string | null => {
    const [fn, ...args] = call.split(/\s+/);
    switch (fn) {
      case 'lower':
        return args.length === 0 ? value.toLowerCase() : null;
      case 'upper':
        return args.length === 0 ? value.toUpperCase() : null;
      case 'trunc': {
        if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) return null;
        const max = Number(args[0]);
        // Code points, so the cut cannot split a surrogate pair.
        const chars = [...value];
        return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
      }
      default:
        return null;
    }
  };
  const expanded = template.replace(/\{[^{}]*\}/g, (placeholder) => {
    const [name, ...calls] = placeholder.slice(1, -1).split('|').map((part) => part.trim());
    // own keys only, so {constructor} and {__proto__} stay literal
    let value = Object.hasOwn(vars, name) ? vars[name as keyof TitleVars] : null;
    for (const call of calls) {
      if (value !== null) value = apply(value, call);
    }
    return value ?? placeholder;
  });
  return expanded.trim();
}

// escapeHTML turns raw HTML in a note into text, so the preview renders
// markdown only: pasted <img>, <iframe> or <style> would otherwise load
// remote resources or restyle the page.
export function escapeHTML(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// codeBlockHTML renders a code block for the preview with a copy button in a
// wrapper, so the button does not scroll with the code; a diagram gets neither.
// lang is the info string, of which only the first word counts;
// highlight(code, lang) returns escaped highlighted HTML or null for an
// unknown language, which stays plain escaped text. The language never goes
// into the output, so a crafted info string cannot inject markup.
export function codeBlockHTML(
  text: string,
  lang: string | undefined,
  highlight: (code: string, lang: string) => string | null,
): string {
  const name = (lang || '').trim().split(/\s/)[0];
  if (name === 'mermaid') return `<pre class="mermaid">${escapeHTML(text)}</pre>\n`;
  const html = name === '' ? null : highlight(text, name);
  const cls = html === null ? '' : ' class="hljs"';
  return `<div class="code-block"><pre><code${cls}>${html ?? escapeHTML(text)}</code></pre><button class="copy" type="button">Copy</button></div>\n`;
}

// previewExtension is the marked configuration of the note preview, shared
// with the tests so they check the markup that ships. Every path to the
// preview's innerHTML that marked does not escape itself is closed here.
export function previewExtension(highlight: (code: string, lang: string) => string | null): MarkedExtension {
  return {
    renderer: {
      // complete comments are hidden as a browser would; an unclosed one stays
      // visible, so a typo cannot hide the rest of the note
      html: ({ text }) => escapeHTML(text.replace(/<!--[\s\S]*?-->/g, '')),
      code: ({ text, lang }) => codeBlockHTML(text, lang, highlight),
      // marked's default is disabled; a click toggles the source, see toggleBox
      checkbox: ({ checked }) => `<input ${checked ? 'checked="" ' : ''}type="checkbox">`,
      // marked's default puts the alt text in its attribute unescaped
      image({ href, title, tokens }) {
        const alt = escapeHTML(this.parser.parseInline(tokens, this.parser.textRenderer));
        try {
          // marked's cleanUrl, which it does not export: a lone surrogate
          // throws, and an image that has no URL shows its text
          const src = escapeHTML(encodeURI(href).replace(/%25/g, '%'));
          return `<img src="${src}" alt="${alt}"${title ? ` title="${escapeHTML(title)}"` : ''}>`;
        } catch {
          return alt;
        }
      },
    },
    tokenizer: {
      // An inline <pre>, <code>, <kbd> or <script> makes marked pass all later
      // text unescaped, to the end of the note, so that `a <pre> <input x`
      // would be markup. Tags are shown as text here, so nothing is raw.
      inlineText() {
        this.lexer.state.inRawBlock = false;
        return false;
      },
    },
  };
}

// taskOffsets maps each checkbox the preview renders, in document order, to
// the source offset of its `[`, or null when that task cannot be located.
// Tokens carry no offsets, so a sentinel goes after each task-like line's box
// and marked itself decides which ones landed on real tasks. Sentinels can
// change the structure of contrived notes, so each index must carry the same
// text in both lexes, and differing counts, sentinels already in the source or
// a failed flip check refuse the whole mapping: a box may fail to tick, never
// tick the wrong line.
export function taskOffsets(source: string, lex: (src: string) => Token[]): (number | null)[] | null {
  const OPEN = '\uE000';
  const CLOSE = '\uE001';
  if (source.includes(OPEN) || source.includes(CLOSE)) return null;
  const leadingTag = new RegExp(`^${OPEN}(\\d+)${CLOSE}`);
  const anyTag = new RegExp(`${OPEN}\\d+${CLOSE}`, 'g');

  const tasks = (tokens: Token[]): Tokens.ListItem[] => tokens.flatMap((t) => {
    if (t.type === 'blockquote') return tasks((t as Tokens.Blockquote).tokens);
    if (t.type !== 'list') return [];
    return (t as Tokens.List).items.flatMap((item) => [...(item.task ? [item] : []), ...tasks(item.tokens)]);
  });

  const boxes: number[] = [];
  const candidate = /^[ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)+\[[ xX]\][ \t]+/gm;
  const tagged = source.replace(candidate, (prefix: string, at: number) => {
    boxes.push(at + prefix.indexOf('['));
    return `${prefix}${OPEN}${boxes.length - 1}${CLOSE}`;
  });

  const real = tasks(lex(source));
  const found = tasks(lex(tagged));
  if (real.length !== found.length) return null;

  const offsets = found.map((item, i) => {
    const k = leadingTag.exec(item.text);
    if (k === null) return null;
    if (item.text.replace(anyTag, '') !== real[i].text) return null;
    return boxes[Number(k[1])];
  });

  // Offsets rise with the index, so if flipping them all changes exactly the
  // mapped indexes, each one is right. Text alone cannot show it: next to
  // identical tasks, a shifted index still compares equal.
  const flipped = source.split('');
  for (const at of offsets) {
    if (at !== null) flipped[at + 1] = toggleTask(flipped[at + 1]);
  }
  const after = tasks(lex(flipped.join('')));
  const proven = after.length === real.length
    && after.every((item, i) => (item.checked !== real[i].checked) === (offsets[i] !== null));
  return proven ? offsets : null;
}

// toggleTask is the task mark to write in place of mark, the character
// between a task's brackets.
export function toggleTask(mark: string): string {
  return mark === ' ' ? 'x' : ' ';
}

// previewBlocks pairs each top-level block but blank space with its source
// line. Tokens carry no offsets and link definitions no token, so blocks are
// searched for in order. Marked can rewrite a block's raw (a lazy line in a
// nested blockquote), and such a block takes the next text after the previous
// block without moving the search on. Lines only steer jumps and scrolling and
// never go backwards, so an imprecise one is harmless.
export function previewBlocks(source: string, tokens: Token[]): { line: number; token: Token }[] {
  let cursor = 0;
  let line = 0;
  let counted = 0;
  const lineAt = (at: number) => {
    for (; counted < at; counted++) {
      if (source[counted] === '\n') line++;
    }
    return line;
  };
  return tokens.filter((token) => token.type !== 'space').map((token) => {
    const found = source.indexOf(token.raw, cursor);
    if (found === -1) return { line: lineAt(cursor + source.slice(cursor).search(/\S|$/)), token };
    cursor = found + token.raw.length;
    return { line: lineAt(found), token };
  });
}

// scrollMap is the piecewise-linear image of value over anchors sorted by
// from, holding at both ends. With duplicate from values the first one wins,
// so a block at the very top does not move the start of the other pane.
export function scrollMap(anchors: ScrollAnchor[], value: number): number {
  const next = anchors.findIndex((a) => a.from >= value);
  if (next === 0) return anchors[0].to;
  if (next === -1) return anchors[anchors.length - 1].to;
  const a = anchors[next - 1];
  const b = anchors[next];
  return a.to + (value - a.from) * (b.to - a.to) / (b.from - a.from);
}

// scrollAnchors is the anchor list for scrollMap from block positions in
// document order: a block past either pane's maximum scroll cannot line up with
// its pair, and keeping it would stop that pane from reaching its end.
export function scrollAnchors(pairs: ScrollAnchor[], maxFrom: number, maxTo: number): ScrollAnchor[] {
  const inside = pairs.filter((p) => p.from < maxFrom && p.to < maxTo);
  return [{ from: 0, to: 0 }, ...inside, { from: maxFrom, to: maxTo }];
}

// imageLabel is the name a file goes by in messages and alt text: a clipboard
// image may have none.
export function imageLabel(name: string): string {
  return name.trim() || 'image';
}

// checkImageFiles splits the files of a drop or paste into the images that can
// be stored and a message for each of the others, or returns null if none of
// them is an image, as such drops and pastes are left to CodeMirror.
export function checkImageFiles<F extends ImageFile>(files: F[]): { fitting: F[]; problems: string[] } | null {
  const isImage = (f: F) => f.type.startsWith('image/');
  if (!files.some(isImage)) return null;
  const fitting: F[] = [];
  const problems: string[] = [];
  for (const f of files) {
    if (!isImage(f)) {
      problems.push(`${imageLabel(f.name)} was skipped: it is not an image.`);
      continue;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      problems.push(`${imageLabel(f.name)} is over the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB limit.`);
      continue;
    }
    fitting.push(f);
  }
  return { fitting, problems };
}

// pasteIsText says whether the text of a paste that also holds an image is what
// the user copied, as with office cells. A lone URL or path is only where the
// image came from: Copy Image and file managers may put one next to it, and for
// an image in the preview it is the whole data URL.
export function pasteIsText(text: string): boolean {
  return text !== '' && !/^(?:(?:https?|file):\/\/\S+|data:image\/\S+|\/\S.*|[a-z]:[\\/].*)$/i.test(text.trim());
}

// imageMarkdown is the note text referencing a stored image. name is a file
// name, so it can hold anything that would end the alt text early.
export function imageMarkdown(name: string, id: string): string {
  const alt = imageLabel(name.replace(/[\r\n]/g, '')).replace(/[\\`[\]]/g, '\\$&');
  return `![${alt}](${IMAGE_SCHEME}${id})`;
}

// imageRefs returns the image ids referenced anywhere in content, code blocks
// included: a false match only keeps an image longer, a missed one loses it.
export function imageRefs(content: string): Set<string> {
  return new Set(Array.from(content.matchAll(IMAGE_REF_RE), (m) => m[1]));
}

// imageIdFromHref returns the image id of a reference URL, or null for any
// other URL. imageHTML relies on it: this is the only validation of the id.
export function imageIdFromHref(href: string): string | null {
  return idAfter(IMAGE_SCHEME, href);
}

// imageHTML renders a reference for the preview. It has no src because the
// custom scheme would only be a CSP violation; the preview pass sets one. It
// is not draggable because a drag carries its src as text, and CodeMirror would
// insert that data URL into the note.
export function imageHTML(id: string, alt: string): string {
  return `<img data-image="${id}" alt="${escapeHTML(alt)}" draggable="false">`;
}

// referencedImages is the ids of the images these notes reference
export const referencedImages = (notes: Note[]) => new Set(notes.flatMap((note) => [...imageRefs(note.content)]));

// storedImageIds is the ids of the images among these storage keys
export const storedImageIds = (keys: string[]) => new Set(keys.map(idFromImageKey).filter((id) => id !== null));

// sweepImages decides which stored images to drop. Binned notes count as
// references, and the grace runs from the first sweep that found an image
// unreferenced, so undo and moving a reference work for an image of any age.
export function sweepImages(
  keys: string[],
  notes: Record<string, Note>,
  orphans: ImageOrphans,
  now: number,
): ImageSweep {
  const referenced = referencedImages(Object.values(notes));
  const sweep: ImageSweep = { remove: [], orphans: {} };
  for (const key of keys) {
    const id = idFromImageKey(key);
    if (id === null || referenced.has(id)) continue;
    const firstSeen = orphans[id] ?? now;
    if (now - firstSeen >= IMAGE_GRACE_DAYS * DAY_MS) {
      sweep.remove.push(id);
      continue;
    }
    sweep.orphans[id] = firstSeen;
  }
  return sweep;
}

// withoutReferenced narrows a sweep to the ids still unreferenced in fresher
// notes. It only drops ids, never runs a new sweep: an id referenced before and
// unreferenced now has no map entry yet, and its grace starts at the next sweep.
export function withoutReferenced(sweep: ImageSweep, notes: Record<string, Note>): ImageSweep {
  const referenced = referencedImages(Object.values(notes));
  return {
    remove: sweep.remove.filter((id) => !referenced.has(id)),
    orphans: Object.fromEntries(Object.entries(sweep.orphans).filter(([id]) => !referenced.has(id))),
  };
}

// orphansAfterFailedRemove is the map when sweep.remove could not be removed:
// an id leaves the map only once its image is gone, so the next sweep retries
// with the id's first sighting intact.
export function orphansAfterFailedRemove(sweep: ImageSweep, orphans: ImageOrphans): ImageOrphans {
  const kept = { ...sweep.orphans };
  for (const id of sweep.remove) kept[id] = orphans[id];
  return kept;
}

// sameFirstSeen compares two id -> first sighting maps by entry: key order
// follows getKeys in a swept map and insertion in the stored one.
export function sameFirstSeen(a: Record<string, number>, b: Record<string, number>): boolean {
  const entries = Object.entries(a);
  return entries.length === Object.keys(b).length && entries.every(([id, at]) => b[id] === at);
}

// sweepClosed runs the close clock over stored notes and the ids open in tabs.
// Only a live temporary note with no tab stays in the map, so one reopened,
// made permanent, binned or removed leaves it. closedDaysLeft counts updatedAt
// because an edit after a reopen between two sweeps shows the note was in use.
// A note is due only with an entry already old enough, so a first sighting
// never bins it.
export function sweepClosed(
  notes: Record<string, Note>,
  openIds: Set<string>,
  closed: ClosedNotes,
  now: number,
): ClosedSweep {
  const sweep: ClosedSweep = { closed: {}, due: [] };
  for (const [id, note] of Object.entries(notes)) {
    if (note.deletedAt !== null || !note.temporary || openIds.has(id)) continue;
    if (closedDaysLeft(closed[id], note, now) === 0) {
      sweep.due.push(id);
      continue;
    }
    sweep.closed[id] = closed[id] ?? now;
  }
  return sweep;
}

// stillDue narrows due ids to the notes safe to bin, given before as the notes
// the sweep saw and current and openNow as read again right before the write.
// updatedAt and restoredAt show a note changed since: a stale copy would undo
// the change, and a restore keeps updatedAt.
export function stillDue(
  due: string[],
  before: Record<string, Note>,
  current: Record<string, Note>,
  openNow: Set<string>,
): { id: string; note: LiveNote }[] {
  return due.flatMap((id) => {
    const note = current[id];
    if (note === undefined || note.deletedAt !== null || !note.temporary || openNow.has(id)) return [];
    const { updatedAt, restoredAt } = before[id];
    return note.updatedAt === updatedAt && note.restoredAt === restoredAt ? [{ id, note }] : [];
  });
}

// closedAfterFailedWrite is the map when failedIds could not be binned: an id
// leaves the map only once its note is binned, so the next sweep retries it.
export function closedAfterFailedWrite(sweep: ClosedSweep, failedIds: string[], closed: ClosedNotes): ClosedNotes {
  const kept = { ...sweep.closed };
  for (const id of failedIds) kept[id] = closed[id];
  return kept;
}

// toggleWrap is the replacement for a selection on Ctrl+B (marker '**') or
// Ctrl+I ('_'): it unwraps a selection already wrapped by marker and wraps
// any other, so an empty selection becomes the bare markers.
export function toggleWrap(selected: string, marker: string): string {
  const n = marker.length;
  if (selected.length >= 2 * n && selected.startsWith(marker) && selected.endsWith(marker)) {
    return selected.slice(n, -n);
  }
  return marker + selected + marker;
}

// linkText is the replacement for a selection on Ctrl+K. cursor holds the
// offsets within text to select afterwards: the url placeholder after a
// selection, so it can be typed over, or the empty brackets without one.
export function linkText(selected: string): { text: string; cursor: { from: number; to: number } } {
  if (selected === '') return { text: '[](url)', cursor: { from: 1, to: 1 } };
  const from = selected.length + 3;
  return { text: `[${selected}](url)`, cursor: { from, to: from + 3 } };
}

// fontSizeFrom is the editor and preview font size in px for the stored
// fontSize value: the default when absent or not a number, else rounded
// and clamped to the supported range.
export function fontSizeFrom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
}

// themeFrom is the theme mode for the stored theme value: anything but a
// known mode means system, so a missing or corrupt key still follows the OS.
export function themeFrom(value: unknown): ThemeMode {
  if (value === 'light' || value === 'dark') return value;
  return 'system';
}

// isDarkTheme is the effective theme of a mode, given whether the system
// currently prefers dark.
export function isDarkTheme(mode: ThemeMode, systemDark: boolean): boolean {
  if (mode === 'system') return systemDark;
  return mode === 'dark';
}

// noteFile is a note as a markdown file: a YAML front matter whose values are
// JSON, which YAML reads too, so parseNoteFile needs no YAML parser. Keys come
// in a fixed order and optional ones only when set, so the bytes are stable.
// content is passed in, as an export writes the text with rewritten links.
export function noteFile(id: string, note: Note, content: string): string {
  const values: Record<NoteFileKey, unknown> = {
    id,
    title: note.title,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
    temporary: note.temporary,
    binDays: note.deletedAt === null ? undefined : note.binDays,
    restoredAt: note.restoredAt,
  };
  const lines = NOTE_FILE_KEYS.filter((k) => values[k] !== undefined).map((k) => `${k}: ${JSON.stringify(values[k])}`);
  return ['---', ...lines, '---', content].join('\n');
}

// parseNoteFile reads a noteFile, also with CRLF line ends. A file whose front
// matter holds no tabnotes id line is 'plain' markdown, front matter of
// another tool included; with one, any deviation is null, as is invalid UTF-8.
// The content after the front matter is kept byte for byte.
export function parseNoteFile(bytes: Uint8Array): { id: string; note: Note } | 'plain' | null {
  let text: string;
  try {
    // ignoreBOM keeps a BOM in the text, so it cannot vanish from content
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const open = /^---\r?\n/.exec(text);
  if (open === null) return 'plain';

  const lines: string[] = [];
  let body: number | null = null;
  for (let pos = open[0].length; pos < text.length && body === null;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl + 1;
    const line = text.slice(pos, nl === -1 ? end : nl).replace(/\r$/, '');
    if (line === '---') body = end;
    else lines.push(line);
    pos = end;
  }

  // with no closing line it is no front matter, but a thematic break
  if (body === null) return 'plain';
  // an id unquoted or in single quotes, as a YAML editor may rewrite it,
  // still marks a tabnotes file: imported as plain text it would duplicate
  // the note under a new id and lose its state, so it is refused instead
  if (!lines.some((line) => ID_RE.test(/^id: (["']?)(.*)\1$/.exec(line)?.[2] ?? ''))) return 'plain';

  const keys = new Set<string>(NOTE_FILE_KEYS);
  const v: Record<string, unknown> = {};
  for (const line of lines) {
    const m = /^(\w+): (.*)$/s.exec(line);
    if (m === null || !keys.has(m[1]) || Object.hasOwn(v, m[1])) return null;
    try {
      v[m[1]] = JSON.parse(m[2]);
    } catch {
      return null;
    }
  }
  const time = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
  const { id, title, updatedAt, deletedAt, temporary, binDays, restoredAt } = v;
  if (typeof id !== 'string' || typeof title !== 'string' || !time(updatedAt)) return null;
  if (deletedAt !== null && !time(deletedAt)) return null;
  if (temporary !== undefined && temporary !== true) return null;
  if (restoredAt !== undefined && !time(restoredAt)) return null;
  if (binDays !== undefined && (deletedAt === null || !Number.isSafeInteger(binDays) || (binDays as number) < 1)) return null;

  const content = text.slice(body);
  if (deletedAt === null && !content.trim()) return null;
  const base = {
    title, content, updatedAt,
    ...(temporary === true ? { temporary: true as const } : {}),
    ...(restoredAt !== undefined ? { restoredAt } : {}),
  };
  const note: Note = deletedAt === null
    ? { ...base, deletedAt }
    : { ...base, deletedAt, ...(binDays !== undefined ? { binDays: binDays as number } : {}) };
  return { id, note };
}

// fileNames is the zip path of each note, named as All notes names it and
// made safe for every OS. 200 bytes leaves room for " (n).md" under the 255
// byte limit of filesystems, and 100 UTF-16 units keeps the path under the
// 260 of Windows MAX_PATH, past which Explorer's Extract All refuses or skips
// a file, when it extracts into a Downloads folder. Duplicates compare
// lowercased, as Windows and macOS do, and notes are named newest first, then
// by id, so the same notes get the same names.
export function fileNames(notes: Record<string, Note>, defaultTitle: string): Record<string, string> {
  const utf8 = new TextEncoder();
  const safe = (name: string): string => {
    let cut = '';
    let size = 0;
    for (const ch of name.normalize('NFC').replace(/[/\\:*?"<>|\p{Cc}]/gu, '-')) {
      size += utf8.encode(ch).length;
      if (size > 200 || cut.length + ch.length > 100) break;
      cut += ch;
    }
    const trimmed = cut.replace(/^[. ]+|[. ]+$/g, '');
    // CON.txt is as reserved as CON, so the suffix goes before the first dot
    const stem = trimmed.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i, '$1_');
    return stem || 'note';
  };
  const order = Object.keys(notes).sort((a, b) => notes[b].updatedAt - notes[a].updatedAt || (a < b ? -1 : 1));
  const used = new Set<string>();
  const names: Record<string, string> = {};
  for (const id of order) {
    // import reads the front matter, so the folder is only for a reader
    const note = notes[id];
    const folder = note.deletedAt !== null ? 'bin' : note.temporary ? 'temporary' : 'permanent';
    const base = safe(rowText(note, defaultTitle).name);
    let name = base;
    for (let n = 2; used.has(`${folder}/${name}`.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(`${folder}/${name}`.toLowerCase());
    names[id] = `${folder}/${name}.md`;
  }
  return names;
}

// imageExt is the file extension an export gives an image of this mime type,
// or null for anything not an image.
export function imageExt(mime: string): string | null {
  const m = IMAGE_MIME_RE.exec(mime);
  if (m === null) return null;
  switch (m[1]) {
    case 'jpeg': return 'jpg';
    case 'svg+xml': return 'svg';
    case 'x-icon': return 'ico';
    default: return m[1];
  }
}

// imageFromPath is the image id and mime type of a zip entry written for
// imageExt, or null for any other path, nested and traversing ones included.
export function imageFromPath(path: string): { id: string; mime: string } | null {
  const m = IMAGE_PATH_RE.exec(path);
  if (m === null) return null;
  const sub = (() => {
    switch (m[2]) {
      case 'jpg': return 'jpeg';
      case 'svg': return 'svg+xml';
      case 'ico': return 'x-icon';
      default: return m[2];
    }
  })();
  return { id: m[1], mime: `image/${sub}` };
}

// zipPath classifies a zip entry by its name. Notes are admitted at a safe
// path, and images at any depth like notes, as zipping an unpacked export
// again can put everything under one folder.
export function zipPath(entryName: string): ZipPath {
  // Compress-Archive of Windows PowerShell 5.1 separates folders with \, and
  // bsdtar, the tar of Windows and macOS, writes ./ before every name when
  // given . as the folder to zip
  const slashed = entryName.replaceAll('\\', '/');
  const name = slashed.replace(/^(\.\/)+/, '');
  // a directory entry holds nothing, and macOS adds __MACOSX/ and ._ entries
  // of file metadata when it zips a folder
  if (slashed.endsWith('/') || /^__MACOSX\/|(^|\/)\._/.test(name)) return { kind: 'skip', name };
  // entry names never become storage keys, but traversing ones are still refused
  const safe = !name.startsWith('/')
    && name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
  if (!safe) return { kind: 'unsupported', name };
  const image = imageFromPath(name.split('/').slice(-2).join('/'));
  if (image !== null) return { kind: 'image', name, ...image };
  if (!/\.md$/i.test(name)) return { kind: 'unsupported', name };
  return { kind: 'note', name };
}

// exportLinks points each image reference whose id is in images (id to ext)
// at its file in the zip, so a markdown viewer shows it. The parentheses are
// part of the match: a reference-style definition stays a tabnotes reference.
export function exportLinks(content: string, images: Record<string, string>): string {
  return content.replace(EXPORT_REF_RE, (all, id: string) =>
    Object.hasOwn(images, id) ? `(../images/${id}.${images[id]})` : all);
}

// importLinks turns the links exportLinks wrote back into image references.
export function importLinks(content: string): string {
  return content.replace(IMPORT_REF_RE, (_, id: string) => `(${IMAGE_SCHEME}${id})`);
}

// dataUrlBytes decodes a stored image, or returns null for anything but a
// valid base64 data URL with a mime type.
export function dataUrlBytes(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)(?:;[^;,]*)*;base64,/.exec(dataUrl);
  if (m === null) return null;
  let binary: string;
  try {
    binary = atob(dataUrl.slice(m[0].length));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { mime: m[1], bytes };
}

// bytesDataUrl is the stored form of an image. The binary string is built in
// chunks, as one fromCharCode call over megabytes overflows the stack.
export function bytesDataUrl(mime: string, bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return `data:${mime};base64,${btoa(chunks.join(''))}`;
}

// zipEntries reads the central directory as fflate's unzipSync does, zip64
// included, but checks the declared count against MAX_ZIP_ENTRIES before the
// walk and every header against the end of the zip, so a small file cannot
// drive a long loop. It locates each entry's data once, for bounded
// streaming inflation, which unzipSync cannot do. Entries whose local header
// and data overlap are not a zip: no tool writes them, and central entries
// sharing one stream would inflate it once each while declaring next to
// nothing against MAX_IMPORT_BYTES.
export function zipEntries(zip: Uint8Array): ZipEntry[] | 'not a zip' | 'too many files' {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const fits = (at: number, n: number) => at >= 0 && at + n <= zip.length;
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => u32(at) + u32(at + 4) * 0x100000000;
  // the end record sits within its 22 bytes plus a comment of at most 65,535
  let end = zip.length - 22;
  while (end >= 0 && u32(end) !== 0x06054b50) {
    if (zip.length - end > 65557) return 'not a zip';
    end--;
  }
  if (end < 0) return 'not a zip';
  let count = u16(end + 10);
  let at = u32(end + 16);
  let zip64 = false;
  if (fits(end - 20, 20) && u32(end - 20) === 0x07064b50) {
    const record = u64(end - 12);
    if (fits(record, 56) && u32(record) === 0x06064b50) {
      zip64 = true;
      count = u64(record + 32);
      at = u64(record + 48);
    }
  }
  if (count > MAX_ZIP_ENTRIES) return 'too many files';
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  const spans: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (!fits(at, 46) || u32(at) !== 0x02014b50) return 'not a zip';
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    if (!fits(at + 46, nameLength + extraLength)) return 'not a zip';
    const raw = zip.subarray(at + 46, at + 46 + nameLength);
    // bit 11 marks a UTF-8 name, else it is CP437, read as latin1 like fflate
    const name = u16(at + 8) & 0x800 ? decoder.decode(raw) : String.fromCharCode(...raw);
    let size = u32(at + 20);
    let originalSize = u32(at + 24);
    let local = u32(at + 42);
    const wide = [originalSize, size, local].map((n) => n === 0xffffffff);
    if (zip64 && wide.some(Boolean)) {
      // the zip64 extra holds the wide fields in this order, and only those
      let field = -1;
      for (let x = at + 46 + nameLength; field === -1 && x + 4 <= at + 46 + nameLength + extraLength; x += 4 + u16(x + 2)) {
        if (u16(x) === 1) field = x + 4;
      }
      if (field === -1 || !fits(field, 8 * wide.filter(Boolean).length)) return 'not a zip';
      const next = () => {
        const n = u64(field);
        field += 8;
        return n;
      };
      if (wide[0]) originalSize = next();
      if (wide[1]) size = next();
      if (wide[2]) local = next();
    }
    const start = fits(local, 30) ? local + 30 + u16(local + 26) + u16(local + 28) : -1;
    const found = start !== -1 && fits(start, size);
    if (found) spans.push([local, start + size]);
    entries.push({
      name, compression: u16(at + 10), size, originalSize,
      data: found ? zip.subarray(start, start + size) : null,
    });
    at += 46 + nameLength + extraLength + u16(at + 32);
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.some(([from], i) => i > 0 && from < spans[i - 1][1])) return 'not a zip';
  return entries;
}

// zipFits tells whether fflate can write these entries: it writes no zip64,
// so past 65,535 entries or 4 GB of local headers and data the counts and
// offsets would wrap into a corrupt zip.
export function zipFits(entries: { name: string; size: number }[]): boolean {
  const utf8 = new TextEncoder();
  const bytes = entries.reduce((sum, e) => sum + 30 + utf8.encode(e.name).length + e.size, 0);
  return entries.length <= MAX_ZIP_ENTRIES && bytes <= 0xffffffff;
}

// CodeMirror keeps only \n, so a stored \r\n would be rewritten by the first edit
const lineFeeds = (text: string) => text.replace(/\r\n?/g, '\n');

// mdNote is a markdown file without a tabnotes front matter as a new
// permanent note titled by its file name, or null for a blank file.
export function mdNote(name: string, text: string, now: number): LiveNote | null {
  const content = lineFeeds(text);
  if (!content.trim()) return null;
  const title = (name.split('/').pop() ?? '').replace(/\.md$/i, '').trim();
  return { title: title || DEFAULT_TITLE, content, updatedAt: now, deletedAt: null };
}

// importedNote readies a parsed note file for storage. Times from the future
// are clamped, as a note stamped ahead would win every adoption in open tabs
// and never expire; binDays is capped for the same reason. A blank title gets
// the default, as every stored title is a non-empty name to click and read.
export function importedNote(note: Note, now: number): Note {
  const clamp = (t: number) => Math.min(t, now);
  const content = importLinks(lineFeeds(note.content));
  const title = note.title.trim() || DEFAULT_TITLE;
  const out: Note = note.deletedAt === null
    ? { ...note, title, content, updatedAt: clamp(note.updatedAt) }
    : {
      ...note, title, content, updatedAt: clamp(note.updatedAt), deletedAt: clamp(note.deletedAt),
      ...(note.binDays === undefined ? {} : { binDays: Math.min(note.binDays, BIN_DAYS) }),
    };
  return note.restoredAt === undefined ? out : { ...out, restoredAt: clamp(note.restoredAt) };
}

// planImport decides what an import writes. It never overwrites: a note whose
// content any local note has is skipped, so importing a backup twice adds
// nothing, and a taken id with other content becomes a copy. The first of
// several notes with one id wins.
export function planImport(incoming: ImportedNote[], local: LocalState, newId: () => string): ImportPlan {
  const plan: ImportPlan = { write: {}, identical: [], duplicates: 0 };
  const seen = new Set<string>();
  for (const { id, note } of incoming) {
    if (seen.has(id)) {
      plan.duplicates++;
      continue;
    }
    seen.add(id);
    if (local.contents.has(note.content)) {
      plan.identical.push(note);
      continue;
    }
    if (!local.taken.has(id)) {
      plan.write[id] = note;
      continue;
    }
    plan.write[newId()] = { ...note, title: `${note.title} (imported)` };
  }
  return plan;
}

// exportSummary is the status line after an export of notes, broken being the
// ids of images left out as unreadable.
export function exportSummary(notes: number, broken: string[]): string {
  const exported = `Exported ${countText(notes, 'note')}.`;
  if (broken.length === 0) return exported;
  return `${exported} Left out ${countText(broken.length, 'image')} that could not be read: ${broken.join(', ')}.`;
}

// importSummary is the status line after an import.
export function importSummary(result: ImportResult): string {
  const copies = result.copies === 0 ? '' : ` (${result.copies} as ${result.copies === 1 ? 'a copy' : 'copies'})`;
  const images = result.images === 0 ? '' : ` and ${countText(result.images, 'image')}`;
  const got = `${countText(result.imported, 'note')}${copies}${images}`;
  const stopped = 'stopped' in result;
  const parts = [!stopped
    ? `Imported ${got}.`
    : `Import stopped by a failed write (${String(result.stopped)}) after ${got}.`];
  if (result.identical > 0) parts.push(`${result.identical} already present.`);
  const reasons = Object.keys(result.rejected).sort();
  if (reasons.length > 0) parts.push(`Skipped: ${reasons.map((r) => `${r} (${result.rejected[r]})`).join(', ')}.`);
  if (stopped) parts.push(STORAGE_FULL_HINT);
  return parts.join(' ');
}
