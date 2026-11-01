// Note page glue: owns the one note named by ?id= in its URL and saves it
// under its own storage key. Pure logic lives in lib/notes.ts.

import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import CodeMirror, { type Editor, type KeyMap } from 'codemirror/lib/codemirror.js';
import 'codemirror/addon/mode/overlay.js';
import 'codemirror/mode/meta.js';
import 'codemirror/mode/markdown/markdown.js';
import 'codemirror/mode/gfm/gfm.js';
import 'codemirror/mode/javascript/javascript.js';
import 'codemirror/mode/css/css.js';
import 'codemirror/mode/xml/xml.js';
import 'codemirror/mode/htmlmixed/htmlmixed.js';
import 'codemirror/mode/go/go.js';
import 'codemirror/mode/python/python.js';
import 'codemirror/mode/shell/shell.js';
import 'codemirror/mode/yaml/yaml.js';
import 'codemirror/mode/sql/sql.js';
import 'codemirror/addon/edit/continuelist.js';
import 'codemirror/addon/edit/closebrackets.js';
import 'codemirror/addon/edit/matchbrackets.js';
import 'codemirror/addon/dialog/dialog.js';
import 'codemirror/addon/search/searchcursor.js';
import 'codemirror/addon/search/search.js';
import {
  noteIdFromUrl, storageKey, newNote, edit, restore, daysLeftText, createDebouncer, canOpen, previewExtension,
  toggleWrap, linkText, fontSizeFrom, taskOffsets, toggleTask, previewBlocks, scrollMap, scrollAnchors, imageKey,
  imageIdFromHref, imageHTML, imageMarkdown, imageLabel, checkImageFiles, pasteIsText, themeFrom, isDarkTheme,
  STORAGE_FULL_HINT, DEFAULT_TITLE, TITLE_HINT, titleVars, expandTitle, type ImageValue,
  type Note, type NoteChange, type Pane, type Settings, type StopMessage, type ThemeMode,
} from '../lib/notes.ts';

// loaded by a script tag once a preview has a diagram, see loadMermaid
declare const mermaid: typeof import('mermaid').default;

(async function () {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const contentEl = $<HTMLTextAreaElement>('content');
  const previewEl = $('preview');
  const modeEl = $('mode');
  const panesEl = $('panes');
  const titleEl = $('title');
  const titleInput = $<HTMLInputElement>('title-input');
  const titleHint = $('title-hint');
  const SAVE_DELAY_MS = 500;
  const PREVIEW_DELAY_MS = 150;
  const COPIED_MS = 1500;
  // diagram labels can carry an <input>, which must not shift a box's index
  const TASK_BOX = 'input[type=checkbox]:not(.mermaid *)';

  const warn = (what: string) => (err: unknown) => console.warn(`tabnotes: ${what}:`, err);
  const warnOr = <T>(what: string, fallback: T) => (err: unknown): T => {
    warn(what)(err);
    return fallback;
  };

  const id = noteIdFromUrl(location.href, browser.runtime.getURL('note/note.html'));
  if (id === null) {
    $('invalid').hidden = false;
    return;
  }
  const key = storageKey(id);
  // raw HTML in a note is shown as text, see escapeHTML; highlight.js
  // escapes the code it highlights
  const highlight = (code: string, lang: string) => {
    if (!hljs.getLanguage(lang)) return null;
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  };
  marked.use(previewExtension(highlight));
  // a separate use, as false falls back only to an earlier use's renderer: any
  // URL that is not a reference keeps previewExtension's image
  marked.use({
    renderer: {
      image: ({ href, text }) => {
        const imageId = imageIdFromHref(href);
        return imageId === null ? false : imageHTML(imageId, text);
      },
    },
  });

  // the editor, once the loaded note is shown
  let cm: Editor | null = null;
  // the font size is applied only from storage, also in the tab that changed
  // it, so holding Ctrl+= does not flicker between local and echoed values.
  // It is display state, so a change is applied at any time, also mid-load.
  let fontSize = fontSizeFrom(undefined);
  let fontChanged = false;
  const applyFont = (value: unknown) => {
    fontSize = fontSizeFrom(value);
    panesEl.style.setProperty('--note-font-size', `${fontSize}px`);
    cm?.refresh();
  };

  // only mermaid needs the mode here, as its SVGs are static: the page colours
  // are theme.ts and CSS. onTheme is set once there are diagrams to redraw.
  let themeMode: ThemeMode = 'system';
  let themeChanged = false;
  let onTheme = () => {};

  // registered before the load so a change landing while it runs is not
  // missed: until the note is loaded only the latest change is kept
  let early: NoteChange | undefined;
  let onChange = (change: NoteChange) => {
    early = change;
  };
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.hasOwn(changes, 'fontSize')) {
      fontChanged = true;
      applyFont(changes.fontSize.newValue);
    }
    if (Object.hasOwn(changes, 'theme')) {
      themeChanged = true;
      themeMode = themeFrom(changes.theme.newValue);
      onTheme();
    }
    if (!Object.hasOwn(changes, key)) return;
    onChange(changes[key]);
  });

  const [stored, current] = await Promise.all([
    browser.storage.local.get([key, 'settings', 'fontSize', 'theme']).catch(warnOr('load note', null)),
    browser.tabs.getCurrent().catch(warnOr('get current tab', null)),
  ]);
  // without the stored note a save could overwrite it with an empty one
  if (stored === null) {
    $('error').hidden = false;
    return;
  }
  const source = current?.openerTabId === undefined
    ? null
    : await browser.tabs.get(current.openerTabId).catch(warnOr('get source tab', null));
  // opener for tabs this page opens and the address All notes stops this tab
  // by; links still open without one
  const tabId = current?.id;

  // a new note stays in memory until it gets content, so opening and closing
  // a note tab leaves nothing behind
  const initial: Note | undefined = early ? early.newValue : stored[key];
  const defaultTitle = (stored.settings as Settings | undefined)?.defaultTitle || DEFAULT_TITLE;
  let note: Note = initial || newNote(expandTitle(defaultTitle, titleVars(new Date(), source)) || DEFAULT_TITLE, Date.now());
  document.title = note.title;
  titleEl.textContent = note.title;
  titleHint.textContent = TITLE_HINT;
  contentEl.value = note.content;
  // a change that landed during the load is newer than the loaded value
  if (!fontChanged) applyFont(stored.fontSize);
  if (!themeChanged) themeMode = themeFrom(stored.theme);
  $('page').hidden = false;
  // replace swaps each selection for edit(its text) = {text, from, to} and
  // selects offsets from..to of what it inserted, so a wrapped word can be
  // unwrapped by pressing the same key again. Each range is edited on its
  // own (replaceSelection would write the joined text into every range);
  // ranges are sorted and disjoint, so each start moves by what the earlier
  // ones grew.
  const replace = (c: Editor, edit: (s: string) => { text: string; from: number; to: number }) => {
    const starts = c.listSelections().map((r) => Math.min(c.indexFromPos(r.anchor), c.indexFromPos(r.head)));
    const texts = c.getSelections();
    const edits = texts.map(edit);
    c.replaceSelections(edits.map((e) => e.text));
    let shift = 0;
    c.setSelections(edits.map((e, i) => {
      const start = starts[i] + shift;
      shift += e.text.length - texts[i].length;
      return { anchor: c.posFromIndex(start + e.from), head: c.posFromIndex(start + e.to) };
    }));
  };
  const wrap = (marker: string) => (c: Editor) => replace(c, (s) => {
    const text = toggleWrap(s, marker);
    if (s) return { text, from: 0, to: text.length };
    return { text, from: marker.length, to: marker.length };
  });
  const link = (c: Editor) => replace(c, (s) => {
    const { text, cursor } = linkText(s);
    return { text, ...cursor };
  });
  // search and replace keys (Ctrl-F, Ctrl-G, Shift-Ctrl-F, ...) come from
  // the default keymap once the search addon is loaded. On mac the shortcuts
  // are Cmd only: the default keymap there keeps the emacs Ctrl keys
  // (Ctrl-B back a char, Ctrl-K kill line).
  const mod = CodeMirror.keyMap.default === CodeMirror.keyMap.macDefault ? 'Cmd' : 'Ctrl';
  const extraKeys: KeyMap = {
    Enter: 'newlineAndIndentContinueMarkdownList',
    Tab: (c) => {
      if (c.somethingSelected()) {
        c.indentSelection('add');
        return;
      }
      c.replaceSelection(' '.repeat(c.getOption('indentUnit')!));
    },
    'Shift-Tab': 'indentLess',
    [`${mod}-B`]: wrap('**'),
    [`${mod}-I`]: wrap('_'),
    [`${mod}-K`]: link,
  };
  // meta.js has no py alias for Python, so ```py fences would stay plain
  CodeMirror.defineMIME('py', 'python');
  // created right after the page is shown, with no await in between: it needs
  // a visible page to measure and must exist before stop or onChange can run.
  // The content goes in through the textarea, so loading fires no change.
  cm = CodeMirror.fromTextArea(contentEl, {
    mode: { name: 'gfm', highlightFormatting: true },
    lineNumbers: true,
    lineWrapping: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    indentUnit: 2,
    screenReaderLabel: 'Note',
    extraKeys,
  });

  // the text at open, null when closed. Every close clears it before hiding the
  // input, so nothing depends on whether Firefox fires blur on a hidden element.
  let renaming: string | null = null;
  const closeRename = () => {
    renaming = null;
    titleInput.hidden = true;
    titleHint.hidden = true;
    titleEl.hidden = false;
  };

  // set once the note is deleted forever elsewhere or All notes stopped this
  // tab before trashing or removing it: from then on nothing is written, or a
  // pending save or flush would resurrect it. The banner says deleted in both
  // cases, since a stop is always followed by a trash or removal.
  let stopped = false;
  const stop = () => {
    stopped = true;
    cm!.setOption('readOnly', 'nocursor');
    closeRename();
    titleEl.removeAttribute('role');
    titleEl.removeAttribute('tabindex');
    titleEl.removeAttribute('title');
    $('bin').hidden = true;
    $('deleted').hidden = false;
  };
  const showBin = () => {
    $('bin').hidden = note.deletedAt === null;
    if (note.deletedAt === null) return;
    $('bin-text').textContent = `This note is in the bin (${daysLeftText(note, Date.now())})`;
  };
  showBin();
  const showTitle = () => {
    titleEl.textContent = note.title;
    document.title = note.title;
  };
  // a binned note left open for days would show a stale count
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !stopped) showBin();
  });

  // one synchronous storage call per save, so flush() completes from pagehide;
  // lastWrite settles once the latest write has landed
  let lastWrite = Promise.resolve();
  const saveError = $('save-error');
  saveError.textContent = `Could not save this note. ${STORAGE_FULL_HINT} Keep this tab open: closing it loses the unsaved text.`;
  const hideSaveError = () => {
    saveError.hidden = true;
  };
  // images can fill the quota, and unsaved text is lost with the tab; a note
  // that failed to clear comes back with its old content on reload
  const saveFailed = (what: string) => (err: unknown) => {
    warn(what)(err);
    saveError.hidden = false;
  };
  const saver = createDebouncer(() => {
    if (stopped) return;
    // never below a stamp commitRename set in this millisecond
    const next = edit(note, cm!.getValue(), Math.max(Date.now(), note.updatedAt));
    if (next === null) {
      lastWrite = browser.storage.local.remove(key).then(hideSaveError).catch(saveFailed('remove note'));
      return;
    }
    note = next;
    lastWrite = browser.storage.local.set({ [key]: note }).then(hideSaveError).catch(saveFailed('save note'));
  }, SAVE_DELAY_MS);

  // mermaid is about 3.6 MB, so it is loaded only once a preview has a
  // diagram. mermaidLoaded resolves to whether it loaded; a failed load is
  // logged once and its diagrams stay as text.
  let mermaidLoaded: Promise<boolean> | null = null;
  const loadMermaid = () => {
    mermaidLoaded ??= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '../vendor/mermaid.min.js';
      script.addEventListener('load', resolve);
      script.addEventListener('error', () => reject(new Error(`load ${script.src}`)));
      document.head.appendChild(script);
    }).then(() => true).catch(warnOr('load mermaid', false));
    return mermaidLoaded;
  };
  // rendered diagrams by source, as detached copies: an unchanged diagram is
  // swapped back in after each preview render instead of rendered again
  const diagrams = new Map<string, Node>();
  // previewHides counts the times cycle hid the preview: a diagram rendered
  // while it was hidden is laid out at zero size and must not be cached
  let previewHides = 0;
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const mermaidTheme = (): 'dark' | 'default' => (isDarkTheme(themeMode, darkQuery.matches) ? 'dark' : 'default');
  // the theme of the diagrams in the cache
  let diagramTheme = mermaidTheme();
  const drawDiagrams = async () => {
    const nodes = [...previewEl.querySelectorAll<HTMLElement>('pre.mermaid')];
    // a rendered node holds its SVG, not its source: the source is kept on
    // the node from its first pass and goes along with its cached copies
    for (const n of nodes) n.dataset.source ??= n.textContent;
    const sources = new Set(nodes.map((n) => n.dataset.source));
    for (const src of diagrams.keys()) {
      if (!sources.has(src)) diagrams.delete(src);
    }
    const todo: [string, HTMLElement][] = [];
    for (const n of nodes) {
      const src = n.dataset.source!;
      const cached = diagrams.get(src);
      if (cached) {
        n.replaceWith(cached.cloneNode(true));
        continue;
      }
      todo.push([src, n]);
    }
    // a hidden preview would lay diagrams out at zero size; cycle renders
    // them once it is shown
    if (todo.length === 0 || previewEl.hidden) return;
    if (!(await loadMermaid())) return;
    // ahead of every return below: this continuation runs before the window
    // load event, whose listener in the script would otherwise run all
    // .mermaid nodes with mermaid's defaults. Each call rebuilds from defaults.
    mermaid.initialize({
      startOnLoad: false,
      // keeps labels encoded and drops click callbacks
      securityLevel: 'strict',
      // without it an invalid diagram leaves an error SVG in body
      suppressErrorRendering: true,
      // not in secure, so a note can pick its own diagram theme
      theme: diagramTheme,
      // keys %%{init}%% may not set: mermaid's defaults plus the CSS-bearing
      // ones, whose values it only brace-checks, so no note adds remote url()
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'themeCSS', 'fontFamily', 'altFontFamily'],
    });
    // the preview may have been hidden while the script loaded
    if (previewEl.hidden) return;
    // nodes a newer preview render replaced meanwhile are not rendered
    const live = todo.filter(([, n]) => n.isConnected);
    if (live.length === 0) return;
    const hides = previewHides;
    // run renders every node even when one fails and then rejects with the
    // first error. It empties a node before parsing it, so a failed one gets
    // its source back as text.
    await mermaid.run({ nodes: live.map(([, n]) => n) }).catch(warn('render diagram'));
    for (const [src, n] of live) {
      if (!n.isConnected) continue;
      // hidden during the run: back to source, which run skips while
      // data-processed is set, for cycle to render once shown
      if (previewHides !== hides) {
        n.textContent = src;
        n.removeAttribute('data-processed');
        continue;
      }
      if (!n.querySelector('svg')) n.textContent = src;
      diagrams.set(src, n.cloneNode(true));
    }
  };
  // one pass at a time, each reading the preview and the cache only once the
  // previous one is done: a pass started during a run would see its nodes
  // unrendered and uncached and run them again
  let diagramPass = Promise.resolve();

  // split mode only. The pane last interacted with drives and the other one's
  // scroll events are ignored: a preview shrinking in a re-render would clamp
  // its scrollTop and move the editor during typing. wrote is the value a sync
  // wrote, not a flag: scroll events are asynchronous and a write that changes
  // nothing fires none, so only an event landing on that value is its echo.
  let driver: Pane = 'editor';
  const wrote: Record<Pane, number | null> = { editor: null, preview: null };
  const syncScroll = () => {
    if (previewEl.hidden || cm!.getWrapperElement().hidden) return;
    const { top, height, clientHeight } = cm!.getScrollInfo();
    const maxEditor = height - clientHeight;
    const maxPreview = previewEl.scrollHeight - previewEl.clientHeight;
    // a pane that cannot scroll has no position to pass on, and its anchors
    // would send the other pane to the top on every render
    if ((driver === 'editor' ? maxEditor : maxPreview) <= 0) return;
    // only top-level wrappers count, as diagram labels may carry data-* of their own
    const blocks = [...previewEl.children] as HTMLElement[];
    const pairs = blocks.map((b) => ({ from: cm!.heightAtLine(Number(b.dataset.line), 'local'), to: b.offsetTop }));
    if (driver === 'editor') {
      wrote.preview = scrollMap(scrollAnchors(pairs, maxEditor, maxPreview), top);
      previewEl.scrollTop = wrote.preview;
      return;
    }
    const back = pairs.map(({ from, to }) => ({ from: to, to: from }));
    wrote.editor = scrollMap(scrollAnchors(back, maxPreview, maxEditor), previewEl.scrollTop);
    cm!.scrollTo(null, wrote.editor);
  };
  const onScroll = (pane: Pane, top: number) => {
    const echo = wrote[pane];
    wrote[pane] = null;
    if (pane !== driver || (echo !== null && Math.abs(top - echo) <= 1)) return;
    syncScroll();
  };
  for (const [pane, el] of [['editor', cm.getWrapperElement()], ['preview', previewEl]] as const) {
    for (const type of ['wheel', 'pointerdown', 'keydown', 'focusin']) {
      // a wheel listener that may cancel would hold scrolling back to the main thread
      el.addEventListener(type, () => { driver = pane; }, { passive: type === 'wheel' });
    }
  }
  cm.on('scroll', () => onScroll('editor', cm!.getScrollInfo().top));
  previewEl.addEventListener('scroll', () => onScroll('preview', previewEl.scrollTop));

  // diagrams change the layout, so the panes line up again once they are done
  const renderDiagrams = () => {
    diagramPass = diagramPass.then(drawDiagrams).catch(warn('draw diagrams')).then(syncScroll).catch(warn('sync scroll'));
  };
  // a decoded image changes the layout too; load does not bubble, so it is captured
  previewEl.addEventListener('load', syncScroll, true);

  // image reads by id, resolving to the data URL, or undefined for a missing
  // image, which then shows its alt text. One read serves every node of an
  // image, in any render, also while it is in flight.
  const images = new Map<string, Promise<string | undefined>>();
  const readImage = (imageId: string) => {
    const k = imageKey(imageId);
    const read = browser.storage.local.get(k)
      .then((v) => (v[k] as ImageValue | undefined)?.dataUrl)
      .catch((err: unknown) => {
        warn('load image')(err);
        // gone from the cache, so the next render retries
        images.delete(imageId);
        return undefined;
      });
    images.set(imageId, read);
    return read;
  };
  const imageNodes = () => [...previewEl.querySelectorAll<HTMLImageElement>('img[data-image]')];
  const drawImages = () => {
    const ids = new Set(imageNodes().map((n) => n.dataset.image!));
    for (const imageId of images.keys()) {
      if (!ids.has(imageId)) images.delete(imageId);
    }
    // decoding up to 33 MB per keystroke is wasted on a hidden pane; cycle
    // draws them once it is shown
    if (previewEl.hidden) return;
    for (const imageId of ids) {
      // nodes are looked up once the read is done: a newer render replaced
      // the ones this pass saw. Passes sharing a read find each other's
      // nodes, and setting src again would decode the image again.
      (images.get(imageId) ?? readImage(imageId)).then((dataUrl) => {
        // hidden during the read: cycle draws them once shown
        if (dataUrl === undefined || previewEl.hidden) return;
        for (const n of imageNodes()) {
          if (n.dataset.image === imageId && !n.src) n.src = dataUrl;
        }
      });
    }
  };

  // the only innerHTML sink: raw HTML is escaped by previewExtension;
  // mermaid writes its sanitized SVG into the diagram nodes itself
  const renderPreview = () => {
    const source = cm!.getValue();
    const drawn = imageNodes().filter((n) => n.src);
    // lexed for every render, as parsing the same loose tokens twice doubles
    // their checkboxes
    previewEl.innerHTML = previewBlocks(source, marked.lexer(source))
      .map(({ line, token }) => `<div data-line="${line}">${marked.parser([token])}</div>`)
      .join('');
    // a new node has no height until it loads, and a preview shrunk by that
    // clamps scrollTop for good when it drives or the editor is hidden. Drawn
    // nodes go back in before any layout, and need no second decode.
    for (const n of imageNodes()) {
      const i = drawn.findIndex((d) => d.dataset.image === n.dataset.image);
      if (i === -1) continue;
      const [kept] = drawn.splice(i, 1);
      kept.alt = n.alt;
      n.replaceWith(kept);
    }
    drawImages();
    renderDiagrams();
  };
  const renderer = createDebouncer(renderPreview, PREVIEW_DELAY_MS);

  // adopted stored content arrives as setValue and is not an edit to save
  cm.on('changes', (_, changes) => {
    if (stopped || changes.every((c) => c.origin === 'setValue')) return;
    saver.schedule();
    renderer.schedule();
  });

  const showImageError = (problems: string[]) => {
    const el = $('image-error');
    el.textContent = problems.join(' ');
    el.hidden = problems.length === 0;
  };
  // the image is stored before its reference goes into the text, so a failed
  // write changes no text and the selection stays. Drops with no image and
  // pastes whose text is the content are left to CodeMirror, as cells copied
  // from an office app also carry an image; other files next to an image are
  // reported, since preventing the default leaves them unhandled. An image stored by a tab
  // stopped afterwards is left for the sweep.
  const insertImages = async (e: DragEvent | ClipboardEvent) => {
    if (stopped) return;
    const isDrop = 'dataTransfer' in e;
    const data = isDrop ? e.dataTransfer : e.clipboardData;
    const checked = checkImageFiles(Array.from(data?.files ?? []));
    if (checked === null || (!isDrop && pasteIsText(data?.getData('text/plain') ?? ''))) return;
    e.preventDefault();

    const { fitting, problems } = checked;
    showImageError(problems);
    if (fitting.length === 0) return;

    const from = isDrop ? cm!.coordsChar({ left: e.clientX, top: e.clientY }, 'window') : cm!.getCursor('from');
    // the user may type during the read
    const mark = cm!.markText(from, isDrop ? from : cm!.getCursor('to'), { clearWhenEmpty: false });
    const readFile = (file: File) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result as string));
      reader.addEventListener('error', () => reject(reader.error));
      reader.readAsDataURL(file);
    });
    const refs: string[] = [];
    for (const file of fitting) {
      if (stopped) break;
      const dataUrl = await readFile(file).catch(warnOr('read image', null));
      if (dataUrl === null) {
        problems.push(`Could not read ${imageLabel(file.name)}.`);
        continue;
      }
      if (stopped) break;
      const imageId = crypto.randomUUID();
      const value: ImageValue = { dataUrl };
      const written = await browser.storage.local.set({ [imageKey(imageId)]: value }).then(() => true).catch(warnOr('save image', false));
      if (!written) {
        problems.push(`Could not store ${imageLabel(file.name)}. ${STORAGE_FULL_HINT}`);
        continue;
      }
      refs.push(imageMarkdown(file.name, imageId));
    }
    if (!stopped && refs.length > 0) {
      // no range left after adoption replaced the text or an edit removed it
      const range = mark.find() ?? { from: cm!.getCursor(), to: cm!.getCursor() };
      cm!.replaceRange(refs.join('\n'), range.from, range.to, 'paste');
    }
    mark.clear();
    if (problems.length > 0) showImageError(problems);
    // preventing CodeMirror's drop handling also skips its focus call. A rename
    // opened during the read keeps focus: the blur would commit a half-typed title.
    if (isDrop && document.activeElement !== titleInput) cm!.focus();
  };
  cm.on('drop', (_, e) => {
    insertImages(e);
  });
  cm.on('paste', (_, e) => {
    insertImages(e);
  });

  // a file dropped outside the editor would navigate the tab to it. CodeMirror
  // handles drags on its scroller only, so its scrollbars and the search dialog
  // count as outside.
  const blockFileDrop = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('Files') && !cm!.getScrollerElement().contains(e.target as Node)) e.preventDefault();
  };
  document.addEventListener('dragover', blockFileDrop);
  document.addEventListener('drop', blockFileDrop);

  window.addEventListener('pagehide', () => saver.flush());

  // restore saves through the saver so the current content goes with it and
  // a blank restored note is removed like any other blank note
  $('restore').addEventListener('click', () => {
    if (stopped) return;
    note = restore(note);
    showBin();
    saver.schedule();
    saver.flush();
  });

  const openRename = () => {
    if (stopped) return;
    renaming = note.title;
    titleInput.value = note.title;
    titleEl.hidden = true;
    titleInput.hidden = false;
    titleHint.hidden = false;
    titleInput.focus();
    titleInput.select();
  };
  // text equal to what was opened, surrounding spaces aside, is left alone:
  // expanding it again would change a stored title holding braces, and writing it
  // would revert a rename adopted while the input was open. The save is flushed as a pending one could be
  // dropped as older than a restore, or lose the title to another tab's save.
  // The stamp is above the last write, here as edit does not stamp a blank note
  // and a clock can repeat: onChange adopts an equal updatedAt, as restore and
  // trash keep it, so the echo of that write would take the title back.
  const commitRename = () => {
    if (renaming === null) return;
    const opened = renaming;
    closeRename();
    if (titleInput.value.trim() === opened.trim()) return;
    const title = expandTitle(titleInput.value, titleVars(new Date(), source));
    if (title === '') return;
    note = { ...note, title, updatedAt: Math.max(Date.now(), note.updatedAt + 1) };
    showTitle();
    saver.schedule();
    saver.flush();
  };
  titleEl.addEventListener('click', openRename);
  titleEl.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat) return;
    // a space would otherwise reach the input and replace the selected title
    e.preventDefault();
    openRename();
  });
  titleInput.addEventListener('keydown', (e) => {
    // the Enter held to open the input must not close it
    if (e.repeat) return;
    switch (e.key) {
      case 'Enter':
        commitRename();
        break;
      case 'Escape':
        closeRename();
        break;
      default:
        return;
    }
    titleEl.focus();
  });
  // switching tab or window blurs the input but leaves it active, and a
  // half-typed title must stay open
  titleInput.addEventListener('blur', () => {
    if (document.activeElement !== titleInput) commitRename();
  });
  // the hint cannot take focus, so a press on it would blur the input and commit
  titleHint.addEventListener('mousedown', (e) => e.preventDefault());

  // All notes sends one stop per tab before it closes the tabs and trashes or
  // removes the note: the reply waits for the flushed write to land and
  // nothing is written after it, so this tab's pagehide cannot resurrect the
  // note. A tab that does not know its id answers for every tab of its note.
  browser.runtime.onMessage.addListener((msg: StopMessage | undefined) => {
    if (msg?.type !== 'stop' || msg.id !== id || (tabId !== undefined && msg.tabId !== tabId)) return undefined;
    saver.flush();
    stop();
    return lastWrite.then(() => true);
  });

  // storage is the source of truth for the bin state and the title: both are
  // always adopted, so a pending save keeps them; content only when nothing is
  // pending, so typing is never overwritten (this tab's own echoes are then
  // no-ops). An open rename input keeps its text. A value older than the
  // in-memory note is a late echo of an earlier write of this tab and is
  // ignored, or it would bring back older content, title or bin state.
  onChange = ({ newValue }) => {
    if (stopped) return;
    if (newValue === undefined) {
      // removed while not binned: another tab of this note was cleared, keep
      // editing and store it again on the next non-blank edit
      if (note.deletedAt === null) return;
      stop();
      return;
    }
    if (newValue.updatedAt < note.updatedAt) return;
    if (saver.pending()) {
      note = { ...note, deletedAt: newValue.deletedAt, title: newValue.title };
      showBin();
      showTitle();
      return;
    }
    note = newValue;
    showBin();
    showTitle();
    if (cm!.getValue() === note.content) return;
    cm!.operation(() => {
      const cursor = cm!.getCursor();
      const { left, top } = cm!.getScrollInfo();
      cm!.setValue(note.content);
      cm!.setCursor(cursor);
      cm!.scrollTo(left, top);
    });
    renderPreview();
  };

  // renders now, not through renderer: a run in flight would write old-theme
  // SVGs into the cleared cache during its delay, while this render disconnects
  // its nodes, which drawDiagrams then skips. A note with no diagrams keeps its
  // preview, so an OS switch does not re-render every open tab.
  const applyDiagramTheme = () => {
    const next = mermaidTheme();
    if (next === diagramTheme) return;
    diagramTheme = next;
    diagrams.clear();
    if (previewEl.querySelector('pre.mermaid') === null) return;
    const { hidden, scrollTop } = previewEl;
    renderPreview();
    if (hidden) return;
    // diagrams are source text during the redraw, which clamps the position,
    // and the sync after the pass restores it only when the editor drives
    diagramPass = diagramPass.then(() => {
      previewEl.scrollTop = scrollTop;
      syncScroll();
    }).catch(warn('restore preview scroll'));
  };
  onTheme = applyDiagramTheme;
  darkQuery.addEventListener('change', applyDiagramTheme);

  // split -> editor -> preview -> split; the button shows the current mode
  const modes = [
    { name: 'Split', editor: true, preview: true },
    { name: 'Editor', editor: true, preview: false },
    { name: 'Preview', editor: false, preview: true },
  ];
  let mode = 0;
  const cycle = () => {
    mode = (mode + 1) % modes.length;
    const m = modes[mode];
    const previewShown = m.preview && previewEl.hidden;
    cm!.getWrapperElement().hidden = !m.editor;
    previewEl.hidden = !m.preview;
    if (!m.preview) previewHides++;
    modeEl.textContent = m.name;
    // a hidden editor cannot measure, so it relayouts once shown again
    if (m.editor) cm!.refresh();
    // a preview that was hidden may lag behind the editor, and its diagrams
    // and images were not drawn while it was hidden
    if (previewShown && !renderer.pending()) {
      drawImages();
      renderDiagrams();
    }
    if (m.preview) renderer.flush();
    // before the focus below hands the drive to the editor: it was hidden, and
    // its position says nothing about what was being read
    syncScroll();
    if (m.editor) {
      cm!.focus();
      return;
    }
    previewEl.focus();
  };
  modeEl.addEventListener('click', cycle);
  document.addEventListener('keydown', (e) => {
    // code, not key: Ctrl+E on a Cyrillic layout has key 'у'. An event the
    // editor handled is skipped: on mac Ctrl-E is its emacs line end.
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== 'KeyE') return;
    e.preventDefault();
    // cycle focuses the editor, which would commit a half-typed title
    if (document.activeElement !== titleInput) cycle();
  });

  // Ctrl+= / Ctrl+- / Ctrl+0 (Shift allowed: + is Shift+= on US layouts).
  // key first, as it finds + and - wherever a layout puts them; code covers
  // only the numpad and Digit0, whose key is not 0 where digits need Shift
  // (AZERTY). Equal and Minus are not matched by code: other layouts put
  // other characters there (German ß, French )). preventDefault stops
  // Firefox page zoom. Stopped tabs too, since font size is not note data.
  const fontStep = (e: KeyboardEvent) => {
    switch (e.key) {
      case '+':
      case '=':
        return 1;
      case '-':
        return -1;
      case '0':
        return 0;
    }
    switch (e.code) {
      case 'NumpadAdd':
        return 1;
      case 'NumpadSubtract':
        return -1;
      case 'Digit0':
      case 'Numpad0':
        return 0;
    }
    return null;
  };
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const d = fontStep(e);
    if (d === null) return;
    e.preventDefault();
    // fontSizeFrom(undefined) is the default size
    const next = fontSizeFrom(d === 0 ? undefined : fontSize + d);
    browser.storage.local.set({ fontSize: next }).catch(warn('save font size'));
  });

  // links in the preview never navigate the note tab itself; only URLs that
  // tabs.create accepts are opened, as children of this tab when known.
  // auxclick covers middle-click, which would otherwise bypass canOpen.
  const openLink = (e: MouseEvent) => {
    const a = (e.target as Element).closest('a');
    if (!a) return;
    e.preventDefault();
    if (e.type === 'auxclick' && e.button !== 1) return;
    if (!canOpen(a.href)) return;
    const props = tabId === undefined ? { url: a.href } : { url: a.href, openerTabId: tabId };
    browser.tabs.create(props).catch(warn('open link'));
  };
  previewEl.addEventListener('click', openLink);
  previewEl.addEventListener('auxclick', openLink);

  // The default is always prevented: a box's state comes only from rendering,
  // and the edit goes through the editor, so saving and undo work as for
  // typing. An origin without + keeps the toggle its own undo step.
  const taskBoxes = () => [...previewEl.querySelectorAll<HTMLInputElement>(TASK_BOX)];
  const toggleBox = (e: MouseEvent) => {
    const box = (e.target as Element).closest<HTMLInputElement>(TASK_BOX);
    if (!box) return;
    e.preventDefault();
    if (stopped) return;
    // a stale preview's index does not match the current source
    if (renderer.pending()) {
      renderer.flush();
      return;
    }
    const boxes = taskBoxes();
    const index = boxes.indexOf(box);
    const source = cm!.getValue();
    const offsets = taskOffsets(source, marked.lexer);
    // both count marked's tasks, but markup that got into the preview would
    // shift every index, and a box may fail to tick, never tick the wrong line
    if (offsets !== null && offsets.length !== boxes.length) {
      warn('toggle task')(new Error(`${boxes.length} checkboxes for ${offsets.length} tasks`));
      return;
    }
    const offset = offsets?.[index] ?? null;
    if (offset === null) {
      warn('toggle task')(new Error(`no source offset for checkbox ${index}`));
      return;
    }
    // offset is the [, so the mark is the character after it
    const from = cm!.posFromIndex(offset + 1);
    const to = cm!.posFromIndex(offset + 2);
    cm!.replaceRange(toggleTask(source[offset + 1]), from, to, 'toggle');
    renderer.flush();
    // the render replaced the box; focusing waits for cached diagrams to be
    // back, or the height they add would be missing and the preview jump. The
    // wait can be long on a first diagram: focus off the body means the user
    // moved on, and taking it back would send their next Space to the box.
    diagramPass = diagramPass.then(() => {
      if (document.activeElement === document.body) taskBoxes()[index]?.focus({ preventScroll: true });
    }).catch(warn('focus task'));
  };
  previewEl.addEventListener('click', toggleBox);

  // a diagram label can carry a button with these classes and no code. The
  // label is a sibling of the pre, so the code's text does not include it.
  const copyCode = (e: MouseEvent) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('.code-block .copy:not(.mermaid *)');
    if (!button) return;
    navigator.clipboard.writeText(button.parentElement!.querySelector('code')!.textContent).then(() => {
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, COPIED_MS);
    }).catch(warn('copy code'));
  };
  previewEl.addEventListener('click', copyCode);

  const jumpToSource = (e: MouseEvent) => {
    const target = e.target as Element;
    if (target.closest('a, input, button')) return;
    // a stale preview's data-line does not match the current source
    if (renderer.pending()) {
      renderer.flush();
      return;
    }
    // only top-level wrappers count, as diagram labels may carry data-* of their own
    const block = [...previewEl.children].find((c) => c.contains(target)) as HTMLElement | undefined;
    if (!block) return;
    // read first: cycle can replace the block
    const line = Number(block.dataset.line);
    if (cm!.getWrapperElement().hidden) cycle();
    cm!.setCursor({ line, ch: 0 });
    cm!.focus();
  };
  previewEl.addEventListener('dblclick', jumpToSource);

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
  $('settings').addEventListener('click', () => {
    browser.runtime.openOptionsPage().catch(warn('open settings'));
  });

  renderPreview();
  cm.focus();
})();
