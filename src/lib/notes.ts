// Pure note logic shared by the note, All notes and background pages and
// node tests. Must not touch the DOM or browser.*.

import type { MarkedExtension, Token, Tokens } from 'marked';

// LiveNote and BinnedNote split on deletedAt, so the bin countdown can only be
// asked of a note known to be binned.
interface LiveNote {
  title: string;
  content: string;
  updatedAt: number;
  deletedAt: null;
}

export type BinnedNote = Omit<LiveNote, 'deletedAt'> & { deletedAt: number };

export type Note = LiveNote | BinnedNote;

// NoteChange is a storage.onChanged entry for a note key
export interface NoteChange {
  newValue?: Note;
}

export interface Settings {
  defaultTitle: string;
}

export const DEFAULT_TITLE = 'Notes';

interface TitleVars {
  date: string;
  time: string;
  weekday: string;
  tab: string;
  host: string;
}

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
const IMAGE_GRACE_DAYS = 7;
const FONT_SIZE_DEFAULT = 14;
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 32;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
// STORAGE_FULL_HINT follows a failed write, of an image or a note
export const STORAGE_FULL_HINT = `Storage may be full, and deleted images free space only after ${IMAGE_GRACE_DAYS} days.`;
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

// noteUrl is the note-page URL of a note, the inverse of noteIdFromUrl
export function noteUrl(noteBase: string, id: string): string {
  return noteBase + '?id=' + id;
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

export function newNote(title: string, now: number): LiveNote {
  return { title, content: '', updatedAt: now, deletedAt: null };
}

// edit returns the edited note, or null when the note should be removed:
// blank content outside the bin. A binned note stays until restored or purged.
export function edit(note: Note, content: string, now: number): Note | null {
  if (!content.trim() && note.deletedAt === null) return null;
  return { ...note, content, updatedAt: now };
}

export function trash(note: Note, now: number): BinnedNote {
  return { ...note, deletedAt: now };
}

export function restore(note: Note): LiveNote {
  return { ...note, deletedAt: null };
}

export function daysLeft(note: BinnedNote, now: number): number {
  return Math.max(0, Math.ceil((note.deletedAt + BIN_DAYS * DAY_MS - now) / DAY_MS));
}

// daysLeftText is the bin countdown shown on the note page and All notes
export function daysLeftText(note: BinnedNote, now: number): string {
  const n = daysLeft(note, now);
  return `${n} day${n === 1 ? '' : 's'} left`;
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
      html: ({ text }) => escapeHTML(text),
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

const referencedImages = (notes: Record<string, Note>) =>
  new Set(Object.values(notes).flatMap((note) => [...imageRefs(note.content)]));

// sweepImages decides which stored images to drop. Binned notes count as
// references, and the grace runs from the first sweep that found an image
// unreferenced, so undo and moving a reference work for an image of any age.
export function sweepImages(
  keys: string[],
  notes: Record<string, Note>,
  orphans: ImageOrphans,
  now: number,
): ImageSweep {
  const referenced = referencedImages(notes);
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
  const referenced = referencedImages(notes);
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

// sameOrphans compares by entry: key order follows getKeys in a swept map and
// insertion in the stored one.
export function sameOrphans(a: ImageOrphans, b: ImageOrphans): boolean {
  const entries = Object.entries(a);
  return entries.length === Object.keys(b).length && entries.every(([id, at]) => b[id] === at);
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
