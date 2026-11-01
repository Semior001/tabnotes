'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bundle } = require('./bundle.js');
const { STORAGE_FULL_HINT, TITLE_HINT } = require('../src/lib/notes.ts');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
// the shim hands fromTextArea to the fake editor; modes keep the real core
const script = bundle('src/note/note.ts', {
  alias: { 'codemirror/lib/codemirror.js': path.join(__dirname, 'codemirror-shim.js') },
});

// focus is shared by every element of one page: only one element is focused
// at a time, and hidden elements (or children of a hidden parent) cannot take
// focus, like in a real document
function element(attrs = {}, focus = { active: null }) {
  const listeners = {};
  return {
    value: '',
    textContent: '',
    hidden: false,
    parent: null,
    ...attrs,
    get focused() {
      return focus.active === this;
    },
    listeners,
    captured: [],
    addEventListener(type, fn, options) {
      (listeners[type] = listeners[type] || []).push(fn);
      if (options === true) this.captured.push(type);
    },
    dispatch(type, props = {}) {
      const e = {
        type,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...props,
      };
      for (const fn of listeners[type] || []) fn(e);
      return e;
    },
    // moving focus dispatches no blur on the previous element: tests do that
    focus() {
      if (this.hidden || (this.parent && this.parent.hidden) || focus.active === this) return;
      focus.active = this;
      this.dispatch('focusin');
    },
    selected: false,
    select() {
      this.selected = true;
    },
    removeAttribute(name) {
      delete this[name];
    },
  };
}

// timers replaces setTimeout/clearTimeout and Date.now in the vm context so
// tests decide when callbacks run and what time it is, and no real timer
// keeps node --test alive
function timers(now) {
  const all = [];
  return {
    now,
    all,
    setTimeout: (fn, delay) => all.push({ fn, delay, done: false }),
    clearTimeout: (id) => {
      if (id) all[id - 1].done = true;
    },
    active: () => all.filter((t) => !t.done),
    // run fires every active timer, as if enough time had passed
    run() {
      for (const t of all.filter((x) => !x.done)) {
        t.done = true;
        t.fn();
      }
    },
  };
}

// codeMirror stands in for CodeMirror.fromTextArea: real CodeMirror needs a
// real DOM. Its wrapper shares the page's focus model, so a hidden editor
// cannot take focus. setValue resets cursor and scroll like the real one, and
// changes listeners get (cm, [{ origin }]). The selection is one anchor/head
// pair of document offsets. type(text) is user input. With readOnly 'nocursor'
// it blurs and refuses focus, like the real one, whose textarea is disabled.
// Layout: 20px a line and, unless layout says otherwise, 1000px of content in a
// 200px pane; scrollTo clamps and fires no scroll event, as a real write may not
// either, and userScroll is a scroll that does.
function codeMirror(textarea, options, page, focus, layout = {}) {
  const wrapper = element({ parent: page }, focus);
  // contains walks parent links, so a test node needs only { parent }
  const scroller = element({
    parent: wrapper,
    contains(n) {
      for (; n; n = n.parent) {
        if (n === this) return true;
      }
      return false;
    },
  }, focus);
  const listeners = {};
  const opts = { ...options };
  let value = textarea.value;
  // sels holds the selection ranges as document offsets, sorted and
  // disjoint like the real ones; the first is the primary
  let sels = [{ anchor: 0, head: 0 }];
  let scroll = { left: 0, top: 0 };
  const size = { height: 1000, clientHeight: 200, ...layout };
  let depth = 0;
  let before = value;
  const emit = (...origins) => {
    for (const fn of listeners.changes || []) fn(cm, origins.map((origin) => ({ origin })));
  };
  const bounds = (r) => [Math.min(r.anchor, r.head), Math.max(r.anchor, r.head)];
  const { extraKeys, ...rest } = options;
  const cm = {
    textarea,
    pageHidden: page.hidden,
    // cloned into this realm so deepStrictEqual compares prototypes; the
    // key handlers are functions and kept as they are
    options: structuredClone(rest),
    extraKeys,
    refreshes: 0,
    // setValue calls made outside an operation
    unbatched: 0,
    // indentSelection calls, by argument
    indents: [],
    getValue: () => value,
    setValue(v) {
      if (depth === 0) cm.unbatched++;
      value = v;
      for (const m of cm.marks) m.gone = true;
      sels = [{ anchor: 0, head: 0 }];
      scroll = { left: 0, top: 0 };
      emit('setValue');
    },
    on(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    setOption(k, v) {
      opts[k] = v;
      if (k === 'readOnly' && v === 'nocursor' && wrapper.focused) focus.active = null;
    },
    getOption: (k) => opts[k],
    focus() {
      if (opts.readOnly !== 'nocursor') wrapper.focus();
    },
    get focused() {
      return wrapper.focused;
    },
    refresh() {
      cm.refreshes++;
    },
    operation(fn) {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
      }
    },
    // both clamp to the document like the real ones
    indexFromPos({ line, ch }) {
      const lines = value.split('\n');
      const l = Math.max(0, Math.min(line, lines.length - 1));
      return lines.slice(0, l).reduce((n, x) => n + x.length + 1, 0) + Math.min(ch, lines[l].length);
    },
    posFromIndex(i) {
      const before = value.slice(0, Math.max(0, Math.min(i, value.length))).split('\n');
      return { line: before.length - 1, ch: before[before.length - 1].length };
    },
    getCursor(which = 'head') {
      const [from, to] = bounds(sels[0]);
      return cm.posFromIndex({ from, to, head: sels[0].head, anchor: sels[0].anchor }[which]);
    },
    setCursor(pos) {
      const i = cm.indexFromPos(pos);
      sels = [{ anchor: i, head: i }];
    },
    setSelection(anchor, head = anchor) {
      sels = [{ anchor: cm.indexFromPos(anchor), head: cm.indexFromPos(head) }];
    },
    listSelections: () => sels.map((r) => ({ anchor: cm.posFromIndex(r.anchor), head: cm.posFromIndex(r.head) })),
    setSelections(ranges) {
      sels = ranges.map((r) => ({ anchor: cm.indexFromPos(r.anchor), head: cm.indexFromPos(r.head ?? r.anchor) }));
    },
    somethingSelected: () => sels.some((r) => r.anchor !== r.head),
    getSelections: () => sels.map((r) => value.slice(...bounds(r))),
    // like the real one, the ranges joined by newlines
    getSelection: () => cm.getSelections().join('\n'),
    // the cursors end up after the inserted texts, like the default collapse
    replaceSelections(texts) {
      let shift = 0;
      sels = sels.map((r, i) => {
        const [from, to] = bounds(r).map((x) => x + shift);
        value = value.slice(0, from) + texts[i] + value.slice(to);
        shift += texts[i].length - (to - from);
        return { anchor: from + texts[i].length, head: from + texts[i].length };
      });
      emit('+input');
    },
    // like the real one, the same text into every range
    replaceSelection(text) {
      cm.replaceSelections(sels.map(() => text));
    },
    indentSelection(how) {
      cm.indents.push(how);
    },
    // replaced records the origin of each call, as it decides the undo step. A
    // selection the change touches ends up after the inserted text, one past
    // it moves along, like the real one
    replaced: [],
    replaceRange(text, from, to = from, origin) {
      const [a, b] = [cm.indexFromPos(from), cm.indexFromPos(to)];
      before = value;
      value = value.slice(0, a) + text + value.slice(b);
      const moved = (x) => {
        if (x < a) return x;
        return x <= b ? a + text.length : x + text.length - (b - a);
      };
      sels = sels.map((r) => ({ anchor: moved(r.anchor), head: moved(r.head) }));
      const delta = text.length - (b - a);
      for (const m of cm.marks) {
        const { from: f, to: t } = m.range;
        if (f >= a && t <= b) {
          m.gone = true;
          continue;
        }
        if (f >= b) m.range.from = f + delta;
        else if (f > a) m.range.from = a + text.length;
        if (t >= b) m.range.to = t + delta;
        else if (t > a) m.range.to = a;
      }
      cm.replaced.push(origin);
      emit(origin);
    },
    // one step back over replaceRange; the history itself is tested on a real Doc
    undo() {
      value = before;
      emit('undo');
    },
    getScrollInfo: () => ({ ...scroll, ...size }),
    // null keeps a coordinate, like the real one
    scrollTo(left, top) {
      const max = Math.max(0, size.height - size.clientHeight);
      scroll = { left: left ?? scroll.left, top: Math.min(max, top ?? scroll.top) };
    },
    userScroll(top) {
      scroll = { ...scroll, top };
      for (const fn of listeners.scroll || []) fn(cm);
    },
    heightAtLine: (line, mode) => {
      assert.equal(mode, 'local');
      return line * 20;
    },
    getWrapperElement: () => wrapper,
    getScrollerElement: () => scroller,
    // position by document offset: left is the offset; coords records the
    // arguments, as top means nothing here
    coords: [],
    coordsChar({ left, top }, mode) {
      assert.equal(mode, 'window');
      cm.coords.push({ left, top });
      return cm.posFromIndex(left);
    },
    // marks holds every mark made. A mark moves with edits, and its range is
    // gone after setValue or an edit covering it, which includes text entered
    // exactly at an empty mark; 'the editor marks insertImages relies on'
    // checks this on the real one
    marks: [],
    markText(from, to, options) {
      const range = { from: cm.indexFromPos(from), to: cm.indexFromPos(to) };
      const mark = {
        options: structuredClone(options),
        range,
        cleared: false,
        find: () => (mark.cleared || mark.gone ? undefined : { from: cm.posFromIndex(range.from), to: cm.posFromIndex(range.to) }),
        clear() {
          mark.cleared = true;
        },
      };
      cm.marks.push(mark);
      return mark;
    },
    // fire delivers a DOM event through the editor's on(type) listeners
    fire(type, props = {}) {
      const e = {
        type,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...props,
      };
      for (const fn of listeners[type] || []) fn(cm, e);
      return e;
    },
    // emit delivers one changes event with a change per origin
    emit,
    type(text) {
      value = text;
      emit('+input');
    },
    // select sets the selection by document offsets, like a mouse drag;
    // selected reads it back the same way
    select(anchor, head = anchor) {
      sels = [{ anchor, head }];
    },
    // selectRanges sets several ranges, as [anchor, head] pairs in order
    selectRanges(...pairs) {
      sels = pairs.map(([anchor, head]) => ({ anchor, head }));
    },
    selected: () => ({ ...sels[0] }),
    selections: () => sels.map((r) => ({ ...r })),
  };
  return cm;
}

// svgText stands for the text of the SVG mermaid renders from src
const svgText = (src) => `svg ${src}`;

// the page's selector for task checkboxes; the fake closest and
// querySelectorAll answer only this one and apply the exclusion themselves, so
// changing the string fails, but whether a real diagram label is excluded is a
// docs/DEVELOPMENT.md manual check
const CHECKBOX = 'input[type=checkbox]:not(.mermaid *)';
// same for copy buttons
const COPY = '.code-block .copy:not(.mermaid *)';

// preview stands in for the preview pane: setting innerHTML keeps the string
// and turns every <pre class="mermaid"> in it into a diagram node, detaching
// the previous ones, so querySelectorAll('pre.mermaid') finds them like in a
// real document. Every <input> becomes a box, see checkboxes and diagramBox.
// Every block wrapper becomes one of children, holding data-line as a string
// in dataset; a target from inside(tag) is contained in its block only.
// Every div.code-block becomes one of copies: its button, whose parent finds
// the code's decoded text the way the rendered markup holds it.
// Layout: blocks sit at 40px a source line in, unless attrs say otherwise,
// 1400px of content in a 200px pane. scrollTop clamps to that, and like a test's
// scrollTo a write fires nothing, so tests dispatch scroll themselves.
// A box that a render replaces loses focus, which falls to the body.
// A node holds its decoded source as textContent; mermaid's
// stub marks it rendered, which gives it an svg child and replaces its text
// with the SVG's, and processed, which stands for data-processed. dataset
// is copied by cloneNode like data-* attributes. Every <img data-image> in the
// HTML becomes an image node, with src '' until the page sets one.
function preview(attrs, focus) {
  const el = element({ scrollHeight: 1400, clientHeight: 200, ...attrs }, focus);
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set(v) {
      top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight));
    },
  });
  let html = '';
  let nodes = [];
  let boxes = [];
  const box = (markup, inDiagram) => {
    const b = element({
      parent: el,
      inDiagram,
      checked: /\bchecked\b/.test(markup),
      disabled: /\bdisabled\b/.test(markup),
      closest: (sel) => (sel === CHECKBOX && !inDiagram ? b : null),
    }, focus);
    const take = b.focus;
    b.focus = (opts) => {
      b.focusOptions = opts;
      take.call(b);
    };
    return b;
  };
  const block = (line) => {
    const b = {
      dataset: { line },
      offsetTop: Number(line) * 40,
      contains: (t) => t.block === b,
      // inside builds a target in this block, matching only its own tag
      inside: (tag) => ({ block: b, closest: (sel) => (sel.split(/\s*,\s*/).includes(tag) ? {} : null) }),
    };
    return b;
  };
  let imgs = [];
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const copy = (code, inDiagram) => {
    const parentElement = { querySelector: (sel) => (sel === 'code' ? { textContent: decode(code.replace(/<[^>]*>/g, '')) } : null) };
    const b = { textContent: 'Copy', parentElement, closest: (sel) => (sel === COPY && !inDiagram ? b : null) };
    return b;
  };
  const node = (props) => {
    const n = {
      isConnected: true,
      rendered: false,
      processed: false,
      dataset: {},
      ...props,
      cloneNode: () => node({ textContent: n.textContent, rendered: n.rendered, processed: n.processed, dataset: { ...n.dataset }, isConnected: false, clone: true }),
      removeAttribute(name) {
        assert.equal(name, 'data-processed');
        n.processed = false;
      },
      querySelector: (sel) => (sel === 'svg' && n.rendered ? {} : null),
      replaceWith(other) {
        nodes[nodes.indexOf(n)] = other;
        n.isConnected = false;
        other.isConnected = true;
      },
    };
    return n;
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set(v) {
      html = v;
      for (const n of nodes) n.isConnected = false;
      if (boxes.includes(focus.active)) focus.active = null;
      nodes = [...v.matchAll(/<pre class="mermaid">([\s\S]*?)<\/pre>/g)].map((m) => node({ textContent: decode(m[1]) }));
      imgs = [...v.matchAll(/<img data-image="([^"]*)" alt="([^"]*)" draggable="false">/g)].map((m) => {
        const n = {
          dataset: { image: m[1] },
          alt: decode(m[2]),
          src: '',
          replaceWith(other) {
            imgs[imgs.indexOf(n)] = other;
          },
        };
        return n;
      });
      boxes = [...v.matchAll(/<input\b[^>]*>/g)].map((m) => box(m[0], false));
      el.children = [...v.matchAll(/<div data-line="(\d+)">/g)].map((m) => block(m[1]));
      el.copies = [...v.matchAll(/<div class="code-block"><pre><code[^>]*>([\s\S]*?)<\/code><\/pre><button class="copy" type="button">Copy<\/button><\/div>/g)]
        .map((m) => copy(m[1], false));
    },
  });
  el.querySelector = (sel) => {
    assert.equal(sel, 'pre.mermaid');
    return nodes[0] ?? null;
  };
  el.querySelectorAll = (sel) => {
    if (sel === 'pre.mermaid') return nodes;
    if (sel === 'img[data-image]') return imgs;
    assert.equal(sel, CHECKBOX);
    return boxes.filter((b) => !b.inDiagram);
  };
  el.diagrams = () => nodes;
  el.images = () => imgs;
  el.checkboxes = () => boxes.filter((b) => !b.inDiagram);
  // diagramBox puts an <input> from a mermaid label ahead of the task boxes
  el.diagramBox = () => {
    const b = box('<input type="checkbox">', true);
    boxes.unshift(b);
    return b;
  };
  el.diagramCopy = () => copy('label', true);
  return el;
}

const base = 'moz-extension://uuid/note/note.html';
const ID = '0b6f4a2e-3c1d-4e5f-8a9b-0c1d2e3f4a5b';
const KEY = `note:${ID}`;

const recoveryURL = 'moz-extension://uuid/recovery/recovery.html';

// target builds a click target whose closest('a') yields an anchor with href,
// or no anchor when href is undefined
const target = (href) => ({ closest: (sel) => (sel === 'a' && href !== undefined ? { href } : null) });

// settle lets pending promise chains in the page run to completion
const settle = () => new Promise((r) => setImmediate(r));
// the script load event, initialize and run each take a turn
const settled = async () => {
  for (let i = 0; i < 5; i++) await settle();
};
const diagram = (src) => `\`\`\`mermaid\n${src}\n\`\`\``;
// holdRun makes the next mermaid.run render its nodes but resolve only once
// the returned release is called
const holdRun = (mermaid) => {
  let release;
  const run = mermaid.run;
  mermaid.run = (opts) => {
    mermaid.run = run;
    const done = run(opts);
    return new Promise((r) => (release = r)).then(() => done);
  };
  return () => release();
};

// runNote evaluates the note bundle against a fake DOM and
// browser API, and resolves once the page's async setup has finished.
// storage is the initial storage.local content; the hidden state mirrors
// note.html, which the 'note.html' test asserts. tab is what tabs.getCurrent
// resolves to, and sourceTab what tabs.get resolves to. With holdLoad the storage read stays pending until
// releaseLoad(); with holdWrites every set/remove stays pending until
// releaseWrites(). layout overrides the fake sizes of its editor and preview.
// imageReads steers reads of image: keys only, so the note still loads: with hold they stay pending until releaseImages(), with fail
// they reject; the test may flip both while the page runs. fileReads.hold keeps
// FileReader reads pending until releaseFiles(); a file with fail: true fails
// its read, and filesRead lists the names of the reads started. A file's data
// URL is data:<type>;base64,<name>. A write that lands updates storage.
// systemDark is what prefers-color-scheme starts at; setSystemDark changes it
// and fires the page's change listener.
async function runNote({
  href = `${base}?id=${ID}`,
  storage = {},
  reject = {},
  now = 1000,
  allTabs = [],
  tab = { id: 7, windowId: 1 },
  sourceTab = {},
  holdLoad = false,
  holdWrites = false,
  imageReads = {},
  fileReads = {},
  mermaidLoad = 'load',
  mermaidFails = false,
  mac = false,
  layout = {},
  compiled = script,
  systemDark = false,
} = {}) {
  const focus = { active: null };
  const page = element({ hidden: true }, focus);
  const els = {
    invalid: element({ hidden: true }, focus),
    error: element({ hidden: true }, focus),
    page,
    title: element({ parent: page, tabindex: '0', title: 'Rename' }, focus),
    'title-input': element({ hidden: true, parent: page }, focus),
    'title-hint': element({ hidden: true, parent: page }, focus),
    mode: element({ textContent: 'Split', parent: page }, focus),
    'all-notes': element({ parent: page }, focus),
    settings: element({ parent: page }, focus),
    bin: element({ hidden: true, parent: page }, focus),
    'bin-text': element({ parent: page }, focus),
    restore: element({ parent: page }, focus),
    deleted: element({ hidden: true, parent: page }, focus),
    'image-error': element({ hidden: true, parent: page }, focus),
    'save-error': element({ hidden: true, parent: page }, focus),
    // style.props holds the custom properties set on it
    panes: element({ parent: page, style: { props: {}, setProperty(k, v) { this.props[k] = v; } } }, focus),
    content: element({ disabled: false, parent: page }, focus),
    preview: preview({ parent: page, ...layout.preview }, focus),
  };
  const win = element();
  const media = element({ matches: systemDark });
  win.matchMedia = (query) => {
    assert.equal(query, '(prefers-color-scheme: dark)');
    return media;
  };
  const setSystemDark = (matches) => {
    media.matches = matches;
    media.dispatch('change');
  };
  // scripts holds the script elements the page appended to head; each one
  // loads (defining the mermaid stub) or fails as mermaidLoad says, once the
  // page's current turn ends. With 'hold' the stub is defined but the test
  // dispatches load itself.
  const scripts = [];
  const doc = element({
    title: 'Notes',
    hidden: false,
    body: element(),
    getElementById: (id) => els[id],
    // CodeMirror creates elements while it loads to detect features
    createElement: (tag) => element({ src: '', tag, style: {}, setAttribute() {}, appendChild() {} }),
    head: {
      appendChild(el) {
        scripts.push(el);
        setImmediate(() => {
          if (mermaidLoad !== 'error') ctx.mermaid = mermaid;
          if (mermaidLoad !== 'hold') el.dispatch(mermaidLoad);
        });
      },
    },
  });
  Object.defineProperty(doc, 'activeElement', { get: () => focus.active ?? doc.body });
  // mermaid records initialize and run calls; run skips processed nodes like
  // mermaid 11 and marks the others processed and rendered, replacing their
  // text with svgText's, or, when mermaidFails is set, empties them before
  // parsing and rejects after all of them
  const mermaid = {
    inits: [],
    runs: [],
    initialize(opts) {
      mermaid.inits.push(structuredClone(opts));
    },
    async run({ nodes }) {
      mermaid.runs.push(Array.from(nodes, (n) => n.textContent));
      for (const n of nodes) {
        if (n.processed) continue;
        n.processed = true;
        n.rendered = !mermaidFails;
        n.textContent = mermaidFails ? '' : svgText(n.textContent);
      }
      if (mermaidFails) throw new Error('parse error');
    },
  };
  const clock = timers(now);
  const warnings = [];
  const calls = [];
  const changeListeners = [];
  const messageListeners = [];
  let releaseLoad = () => {};
  const loaded = holdLoad ? new Promise((r) => (releaseLoad = r)) : Promise.resolve();
  const heldWrites = [];
  const heldImages = [];
  const heldFiles = [];
  const filesRead = [];
  let uuids = 0;
  class FileReader {
    listeners = {};
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    async readAsDataURL(file) {
      filesRead.push(file.name);
      if (fileReads.hold) await new Promise((r) => heldFiles.push(r));
      this.result = `data:${file.type};base64,${file.name}`;
      this.error = new Error(`read ${file.name}`);
      this.listeners[file.fail ? 'error' : 'load']();
    }
  }
  const write = async (...args) => {
    if (holdWrites) await new Promise((r) => heldWrites.push(r));
    return call(...args);
  };
  // call records a browser API call and rejects when the test asked it to;
  // args are cloned into this realm so deepStrictEqual compares prototypes
  const call = async (name, ...args) => {
    calls.push(structuredClone([name, ...args]));
    if (reject[name]) throw new Error(`${name} rejected`);
  };
  let editor = null;
  const ctx = vm.createContext({
    // CodeMirror picks its default keymap from the platform
    navigator: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
      platform: mac ? 'MacIntel' : 'Linux x86_64',
      vendor: '',
      clipboard: { writeText: (text) => call('clipboard.writeText', text) },
    },
    URL,
    FileReader,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}` },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // a class, as the real CodeMirror history calls new Date
    Date: class extends Date {
      constructor() {
        super(clock.now);
      }

      static now = () => clock.now;
    },
    console: { warn: (...a) => warnings.push(a) },
    location: { href },
    document: doc,
    browser: {
      runtime: {
        getURL: (p) => `moz-extension://uuid/${p}`,
        openOptionsPage: () => call('runtime.openOptionsPage'),
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
      },
      windows: {
        update: (...a) => call('windows.update', ...a),
      },
      tabs: {
        create: (props) => call('tabs.create', props),
        update: (...a) => call('tabs.update', ...a),
        query: async (q) => {
          await call('tabs.query', q);
          return structuredClone(allTabs);
        },
        getCurrent: async () => {
          await call('tabs.getCurrent');
          return tab === null ? undefined : tab;
        },
        get: async (id) => {
          await call('tabs.get', id);
          return structuredClone(sourceTab);
        },
      },
      storage: {
        local: {
          get: async (keys) => {
            await call('storage.local.get', keys);
            const list = [keys].flat();
            if (list.some((k) => k.startsWith('image:'))) {
              if (imageReads.hold) await new Promise((r) => heldImages.push(r));
              if (imageReads.fail) throw new Error('image read rejected');
            }
            await loaded;
            return structuredClone(Object.fromEntries(list.filter((k) => k in storage).map((k) => [k, storage[k]])));
          },
          set: async (v) => {
            await write('storage.local.set', v);
            Object.assign(storage, structuredClone(v));
          },
          remove: async (k) => {
            await write('storage.local.remove', k);
            for (const name of [k].flat()) delete storage[name];
          },
        },
        onChanged: { addListener: (fn) => changeListeners.push(fn) },
      },
    },
  });
  ctx.window = win;
  ctx.fromTextArea = (textarea, options) => (editor = codeMirror(textarea, options, page, focus, layout.editor));
  compiled.runInContext(ctx);
  await settle();
  const writes = () => calls.filter(([name]) => name === 'storage.local.set' || name === 'storage.local.remove');
  // typing needs an editor; on a page that never created one it does nothing
  const type = (value) => editor?.type(value);
  // change delivers a storage.onChanged event to the page; values are cloned
  // like real events so the page never shares objects with the test
  const change = (changes, area = 'local') => {
    for (const fn of changeListeners) fn(structuredClone(changes), area);
  };
  // message delivers a runtime message and returns the listener replies
  const message = (msg) => messageListeners.map((fn) => fn(structuredClone(msg)));
  const releaseWrites = () => heldWrites.splice(0).forEach((r) => r());
  const releaseImages = () => heldImages.splice(0).forEach((r) => r());
  const releaseFiles = () => heldFiles.splice(0).forEach((r) => r());
  // cm is the editor once the page created it, null before or without one
  const cm = () => editor;
  return { els, win, doc, media, setSystemDark, clock, warnings, calls, writes, type, change, message, releaseLoad, releaseWrites, releaseImages, releaseFiles, filesRead, cm, scripts, mermaid, CodeMirror: ctx.CodeMirror };
}

const stored = (content, extra = {}) => ({ title: 'Jira', content, updatedAt: 1, deletedAt: null, ...extra });

test('note.html loads its scripts and starts with the harness state', () => {
  const html = read('src', 'note', 'note.html');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['../theme.js', 'note.js']);
  const css = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(css, ['note.css']);
  const hidden = {
    invalid: true,
    error: true,
    page: true,
    title: false,
    'title-input': true,
    'title-hint': true,
    mode: false,
    'all-notes': false,
    settings: false,
    bin: true,
    'bin-text': false,
    restore: false,
    deleted: true,
    'image-error': true,
    'save-error': true,
    panes: false,
    content: false,
    preview: false,
  };
  for (const [id, want] of Object.entries(hidden)) {
    const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
    assert.ok(tag, id);
    assert.equal(/\shidden[\s>]/.test(tag[0]), want, id);
  }
  assert.match(html, /id="title"[^>]*tabindex="0" title="Rename"/);
  assert.match(html, /id="title-input"[^>]*aria-label="Note title"/);
  assert.match(html, /id="title-hint"[^>]*><\/p>/);
  assert.match(html, /id="invalid"[^>]*>Invalid note link</);
  assert.match(html, /id="error"[^>]*>Could not load note</);
  assert.match(html, /id="preview"[^>]*tabindex="0"/);
  assert.match(html, /id="mode"[^>]*>Split</);
  assert.match(html, /id="all-notes"[^>]*>All notes</);
  assert.match(html, /id="settings"[^>]*>Settings</);
  assert.match(html, /id="restore"[^>]*>Restore</);
  assert.match(html, /id="deleted"[^>]*>This note was deleted</);
  assert.match(html, /id="image-error" class="banner error"/);
  assert.match(html, /id="save-error" class="banner error"[^>]*><\/p>/);
});

// the harness bundle aliases CodeMirror; this one has no shim, so the modes and
// addons run on the real core as they ship. Real addon behaviour needs a real
// DOM and stays a manual check.
test('the production bundle loads and handles an invalid id', async () => {
  const { els, calls } = await runNote({ href: base, compiled: bundle('src/note/note.ts') });
  assert.equal(els.invalid.hidden, false);
  assert.deepEqual(calls, []);
});

test('note page', async (t) => {
  await t.test('invalid or missing id shows the message and touches nothing', async (t) => {
    const cases = [
      { name: 'missing id', href: base },
      { name: 'empty query', href: `${base}?` },
      { name: 'bad id', href: `${base}?id=nope` },
      { name: 'other page', href: `moz-extension://uuid/recovery/recovery.html?id=${ID}` },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { els, calls, win, type } = await runNote({ href: c.href });
        assert.equal(els.invalid.hidden, false);
        assert.equal(els.page.hidden, true);
        type('x');
        win.dispatch('pagehide');
        assert.deepEqual(calls, []);
      });
    }
  });

  await t.test('loads note and settings in parallel with the current tab', async () => {
    const { calls } = await runNote();
    assert.deepEqual(calls, [['storage.local.get', [KEY, 'settings', 'fontSize', 'theme']], ['tabs.getCurrent']]);
  });

  await t.test('existing note is shown with its title and focused', async () => {
    const { els, doc, cm } = await runNote({ storage: { [KEY]: stored('hello'), settings: { defaultTitle: 'X' } } });
    assert.equal(els.page.hidden, false);
    assert.equal(cm().getValue(), 'hello');
    assert.equal(doc.title, 'Jira');
    assert.equal(els.title.textContent, 'Jira');
    assert.equal(cm().focused, true);
  });

  await t.test('editor replaces the textarea once the page is shown, content already in it', async () => {
    const { els, cm, clock, writes } = await runNote({ storage: { [KEY]: stored('hello') } });
    assert.equal(cm().textarea, els.content);
    assert.equal(cm().pageHidden, false);
    assert.equal(els.content.value, 'hello');
    assert.deepEqual(cm().options, {
      mode: { name: 'gfm', highlightFormatting: true },
      lineNumbers: true,
      lineWrapping: true,
      autoCloseBrackets: true,
      matchBrackets: true,
      indentUnit: 2,
      screenReaderLabel: 'Note',
    });
    // loading is no edit: nothing scheduled, nothing saved
    assert.deepEqual(clock.active(), []);
    clock.run();
    assert.deepEqual(writes(), []);
  });

  await t.test('editor keys', async (t) => {
    const load = (content) => runNote({ storage: { [KEY]: stored(content) } });

    await t.test('are bound on Ctrl, or Cmd on mac, search keys left to the default keymap', async (t) => {
      const cases = [
        { name: 'linux', mac: false, mod: 'Ctrl', replace: 'Shift-Ctrl-F' },
        { name: 'mac', mac: true, mod: 'Cmd', replace: 'Cmd-Alt-F' },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { cm, CodeMirror } = await runNote({ storage: { [KEY]: stored('a') }, mac: c.mac });
          const keys = cm().extraKeys;
          assert.deepEqual(Object.keys(keys).sort(), [`${c.mod}-B`, `${c.mod}-I`, `${c.mod}-K`, 'Enter', 'Shift-Tab', 'Tab']);
          assert.equal(keys.Enter, 'newlineAndIndentContinueMarkdownList');
          assert.equal(keys['Shift-Tab'], 'indentLess');
          // named commands exist in the loaded CodeMirror and its addons
          for (const [k, v] of Object.entries(keys)) {
            if (typeof v === 'string') assert.equal(typeof CodeMirror.commands[v], 'function', k);
          }
          assert.equal(CodeMirror.keyMap.default[`${c.mod}-F`], 'find');
          assert.equal(CodeMirror.keyMap.default[c.replace], 'replace');
          assert.equal(typeof CodeMirror.commands.find, 'function');
          assert.equal(typeof CodeMirror.commands.replace, 'function');
          assert.ok(CodeMirror.modes.gfm);
        });
      }
    });

    // the imports in note.ts are the list now: a dropped mode or addon loads
    // fine and only leaves the editor without it
    await t.test('the bundle holds every mode and option addon', async () => {
      const { CodeMirror } = await load('a');
      assert.deepEqual(Object.keys(CodeMirror.modes).sort(), [
        'css', 'gfm', 'go', 'htmlmixed', 'javascript', 'markdown', 'null', 'python', 'shell', 'sql', 'xml', 'yaml',
      ]);
      assert.ok(CodeMirror.overlayMode);
      assert.equal(typeof CodeMirror.findModeByName, 'function');
      assert.ok(CodeMirror.optionHandlers.autoCloseBrackets);
      assert.ok(CodeMirror.optionHandlers.matchBrackets);
    });

    await t.test('py fences resolve to the python mode', async () => {
      const { CodeMirror } = await load('a');
      // meta.js knows Python only by name, not by its py extension
      assert.equal(CodeMirror.findModeByName('py'), undefined);
      assert.equal(CodeMirror.getMode({}, 'py').name, 'python');
      for (const name of ['js', 'sh', 'yml', 'html', 'go']) {
        assert.ok(CodeMirror.findModeByName(name), name);
      }
    });

    await t.test('Ctrl-B wraps the selection, keeps it selected and saves', async () => {
      const { cm, clock, writes } = await load('one two\nthree');
      cm().select(4, 13);
      cm().extraKeys['Ctrl-B'](cm());
      assert.equal(cm().getValue(), 'one **two\nthree**');
      assert.deepEqual(cm().selected(), { anchor: 4, head: 17 });
      clock.run();
      assert.deepEqual(writes(), [['storage.local.set', { [KEY]: stored('one **two\nthree**', { updatedAt: 1000 }) }]]);
      // pressing it again unwraps
      cm().extraKeys['Ctrl-B'](cm());
      assert.equal(cm().getValue(), 'one two\nthree');
      assert.deepEqual(cm().selected(), { anchor: 4, head: 13 });
    });

    await t.test('Ctrl-I without a selection puts the cursor between the markers', async () => {
      const { cm } = await load('ab');
      cm().select(1);
      cm().extraKeys['Ctrl-I'](cm());
      assert.equal(cm().getValue(), 'a__b');
      assert.deepEqual(cm().selected(), { anchor: 2, head: 2 });
    });

    await t.test('Ctrl-K links the selection with url selected, or puts the cursor in the brackets', async () => {
      const { cm } = await load('see docs');
      cm().select(8, 4);
      cm().extraKeys['Ctrl-K'](cm());
      assert.equal(cm().getValue(), 'see [docs](url)');
      assert.deepEqual(cm().selected(), { anchor: 11, head: 14 });
      cm().select(0);
      cm().extraKeys['Ctrl-K'](cm());
      assert.equal(cm().getValue(), '[](url)see [docs](url)');
      assert.deepEqual(cm().selected(), { anchor: 1, head: 1 });
    });

    await t.test('Ctrl-B, Ctrl-I and Ctrl-K edit each of several selections on its own', async () => {
      const { cm, clock, writes } = await load('foo bar baz');
      cm().selectRanges([0, 3], [8, 11]);
      cm().extraKeys['Ctrl-B'](cm());
      assert.equal(cm().getValue(), '**foo** bar **baz**');
      assert.deepEqual(cm().selections(), [{ anchor: 0, head: 7 }, { anchor: 12, head: 19 }]);
      clock.run();
      assert.deepEqual(writes(), [['storage.local.set', { [KEY]: stored('**foo** bar **baz**', { updatedAt: 1000 }) }]]);
      // pressing it again unwraps both
      cm().extraKeys['Ctrl-B'](cm());
      assert.equal(cm().getValue(), 'foo bar baz');
      assert.deepEqual(cm().selections(), [{ anchor: 0, head: 3 }, { anchor: 8, head: 11 }]);
      // an empty range gets the bare markers, a selected one is wrapped
      cm().selectRanges([1, 1], [4, 7]);
      cm().extraKeys['Ctrl-I'](cm());
      assert.equal(cm().getValue(), 'f__oo _bar_ baz');
      assert.deepEqual(cm().selections(), [{ anchor: 2, head: 2 }, { anchor: 6, head: 11 }]);
      cm().selectRanges([0, 1], [12, 15]);
      cm().extraKeys['Ctrl-K'](cm());
      assert.equal(cm().getValue(), '[f](url)__oo _bar_ [baz](url)');
      assert.deepEqual(cm().selections(), [{ anchor: 4, head: 7 }, { anchor: 25, head: 28 }]);
    });

    await t.test('Tab indents a selection or inserts indentUnit spaces', async () => {
      const { cm } = await load('ab');
      cm().select(0, 1);
      cm().extraKeys.Tab(cm());
      assert.deepEqual(cm().indents, ['add']);
      assert.equal(cm().getValue(), 'ab');
      cm().select(1);
      cm().extraKeys.Tab(cm());
      assert.equal(cm().getValue(), 'a  b');
      assert.deepEqual(cm().selected(), { anchor: 3, head: 3 });
    });
  });

  await t.test('invalid or unloadable page creates no editor', async (t) => {
    const cases = [
      { name: 'invalid', href: base },
      { name: 'load failure', reject: { 'storage.local.get': true } },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { cm } = await runNote(c);
        assert.equal(cm(), null);
      });
    }
  });

  await t.test('editor is created only after a held load completes', async () => {
    const { cm, releaseLoad } = await runNote({ storage: { [KEY]: stored('a') }, holdLoad: true });
    assert.equal(cm(), null);
    releaseLoad();
    await settle();
    assert.equal(cm().getValue(), 'a');
    assert.equal(cm().pageHidden, false);
  });

  await t.test('remote content is adopted in one operation, keeping cursor and scroll, without a save', async () => {
    const { writes, clock, change, cm } = await runNote({ storage: { [KEY]: stored('line one\nline two') } });
    cm().setCursor({ line: 1, ch: 4 });
    cm().scrollTo(3, 40);
    change({ [KEY]: { newValue: stored('line one\nline 2 and more', { updatedAt: 2 }) } });
    assert.equal(cm().getValue(), 'line one\nline 2 and more');
    assert.equal(cm().unbatched, 0);
    assert.deepEqual(cm().getCursor(), { line: 1, ch: 4 });
    assert.deepEqual(cm().getScrollInfo(), { left: 3, top: 40, height: 1000, clientHeight: 200 });
    assert.deepEqual(clock.active(), []);
    clock.run();
    assert.deepEqual(writes(), []);
  });

  await t.test('a changes batch with an edit besides setValue saves', async () => {
    const { cm, clock, writes } = await runNote({ storage: { [KEY]: stored('a') } });
    cm().emit('setValue');
    assert.deepEqual(clock.active(), []);
    cm().emit('setValue', '+input');
    assert.equal(clock.active().length, 2);
    clock.run();
    assert.deepEqual(writes(), [['storage.local.set', { [KEY]: stored('a', { updatedAt: 1000 }) }]]);
  });

  await t.test('new note takes the title from settings', async () => {
    const { doc, els, cm } = await runNote({ storage: { settings: { defaultTitle: 'Ticket' } } });
    assert.equal(doc.title, 'Ticket');
    assert.equal(els.title.textContent, 'Ticket');
    assert.equal(cm().getValue(), '');
  });

  await t.test('new note defaults to "Notes" without settings or with an empty title', async (t) => {
    for (const storage of [{}, { settings: {} }, { settings: { defaultTitle: '' } }]) {
      await t.test(JSON.stringify(storage), async () => {
        const { doc } = await runNote({ storage });
        assert.equal(doc.title, 'Notes');
      });
    }
  });

  await t.test('new note expands a template default title', async () => {
    const { doc, els, calls } = await runNote({
      now: new Date(2026, 10, 1, 14, 5).getTime(),
      storage: { settings: { defaultTitle: '{date} {time} {weekday} - {tab | trunc 5} @ {host}' } },
      tab: { id: 7, windowId: 1, openerTabId: 3 },
      sourceTab: { title: 'Long title', url: 'https://github.com/x' },
    });
    const title = '2026-11-01 14:05 Sunday - Long… @ github.com';
    assert.equal(doc.title, title);
    assert.equal(els.title.textContent, title);
    assert.deepEqual(calls.at(-1), ['tabs.get', 3]);
  });

  await t.test('existing note keeps its title unexpanded', async () => {
    const { doc, els } = await runNote({
      storage: { [KEY]: stored('hello', { title: '{date} {tab}' }), settings: { defaultTitle: '{date}' } },
      tab: { id: 7, windowId: 1, openerTabId: 3 },
      sourceTab: { title: 'Source', url: 'https://github.com/x' },
    });
    assert.equal(doc.title, '{date} {tab}');
    assert.equal(els.title.textContent, '{date} {tab}');
  });

  await t.test('no opener leaves the source variables empty and reads no tab', async () => {
    const { doc, calls } = await runNote({ storage: { settings: { defaultTitle: 'From {tab}{host}' } } });
    assert.equal(doc.title, 'From');
    assert.equal(calls.some(([name]) => name === 'tabs.get'), false);
  });

  await t.test('rejected tabs.get is logged and the note still loads', async () => {
    const { els, doc, warnings, writes, clock, type } = await runNote({
      storage: { settings: { defaultTitle: 'Note {tab}' } },
      tab: { id: 7, windowId: 1, openerTabId: 3 },
      reject: { 'tabs.get': true },
    });
    assert.equal(els.page.hidden, false);
    assert.equal(doc.title, 'Note');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'tabnotes: get source tab:');
    type('x');
    clock.run();
    assert.equal(writes().length, 1);
  });

  await t.test('an expansion that comes out empty falls back to "Notes"', async () => {
    const { doc, els } = await runNote({ storage: { settings: { defaultTitle: ' {tab} {host} ' } } });
    assert.equal(doc.title, 'Notes');
    assert.equal(els.title.textContent, 'Notes');
  });

  await t.test('new note is not stored until it gets content', async () => {
    const { win, writes, clock, type } = await runNote();
    win.dispatch('pagehide');
    assert.deepEqual(writes(), []);
    type('   ');
    clock.run();
    assert.deepEqual(writes(), [['storage.local.remove', KEY]]);
    type('hi');
    clock.run();
    assert.deepEqual(writes().at(-1), [
      'storage.local.set',
      { [KEY]: { title: 'Notes', content: 'hi', updatedAt: 1000, deletedAt: null } },
    ]);
  });

  await t.test('rejected load shows the error and never saves', async () => {
    const { els, win, warnings, writes, type } = await runNote({
      storage: { [KEY]: stored('keep') },
      reject: { 'storage.local.get': true },
    });
    assert.equal(els.error.hidden, false);
    assert.equal(els.page.hidden, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'tabnotes: load note:');
    type('x');
    win.dispatch('pagehide');
    assert.deepEqual(writes(), []);
  });

  await t.test('rejected getCurrent is logged and the note still loads', async () => {
    const { els, warnings, writes, clock, type } = await runNote({ reject: { 'tabs.getCurrent': true } });
    assert.equal(els.page.hidden, false);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'tabnotes: get current tab:');
    type('x');
    clock.run();
    assert.equal(writes().length, 1);
  });

  await t.test('input is debounced into one write of only this note', async () => {
    const { writes, clock, type } = await runNote({ storage: { [KEY]: stored('a') } });
    type('ab');
    type('abc');
    assert.deepEqual(writes(), []);
    assert.deepEqual(clock.active().map((x) => x.delay), [500, 150]);
    clock.run();
    assert.deepEqual(writes(), [
      ['storage.local.set', { [KEY]: { title: 'Jira', content: 'abc', updatedAt: 1000, deletedAt: null } }],
    ]);
  });

  await t.test('pagehide flushes a pending edit synchronously', async () => {
    const { win, writes, type } = await runNote({ storage: { [KEY]: stored('a') } });
    type('ab');
    win.dispatch('pagehide');
    assert.equal(writes().length, 1);
    assert.equal(writes()[0][1][KEY].content, 'ab');
  });

  await t.test('pagehide with nothing pending writes nothing', async () => {
    const { win, writes } = await runNote({ storage: { [KEY]: stored('a') } });
    win.dispatch('pagehide');
    assert.deepEqual(writes(), []);
  });

  await t.test('clearing a note removes its key', async () => {
    const { win, writes, type } = await runNote({ storage: { [KEY]: stored('a') } });
    type(' \n');
    win.dispatch('pagehide');
    assert.deepEqual(writes(), [['storage.local.remove', KEY]]);
  });

  await t.test('clearing a binned note keeps it stored', async () => {
    const { win, writes, type } = await runNote({ storage: { [KEY]: stored('a', { deletedAt: 5 }) } });
    type('');
    win.dispatch('pagehide');
    assert.deepEqual(writes(), [
      ['storage.local.set', { [KEY]: { title: 'Jira', content: '', updatedAt: 1000, deletedAt: 5 } }],
    ]);
  });

  await t.test('rejected set and remove are logged and do not throw', async (t) => {
    const cases = [
      { name: 'set', value: 'x', reject: { 'storage.local.set': true }, prefix: 'tabnotes: save note:' },
      { name: 'remove', value: '', reject: { 'storage.local.remove': true }, prefix: 'tabnotes: remove note:' },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { win, warnings, type } = await runNote({ storage: { [KEY]: stored('a') }, reject: c.reject });
        type(c.value);
        win.dispatch('pagehide');
        await settle();
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][0], c.prefix);
      });
    }
  });
  await t.test('preview renders the stored note on load', async () => {
    const { els } = await runNote({ storage: { [KEY]: stored('# hi') } });
    assert.match(els.preview.innerHTML, /<h1[^>]*>hi<\/h1>/);
  });

  await t.test('preview re-renders only after the debounce', async () => {
    const { els, clock, type } = await runNote({ storage: { [KEY]: stored('a') } });
    type('*x*');
    type('*xy*');
    assert.doesNotMatch(els.preview.innerHTML, /<em>/);
    assert.deepEqual(clock.active().filter((x) => x.delay === 150).length, 1);
    clock.run();
    assert.match(els.preview.innerHTML, /<em>xy<\/em>/);
  });

  await t.test('mode button cycles split, editor, preview with focus', async () => {
    const { els, cm } = await runNote({ storage: { [KEY]: stored('a') } });
    // the editor relayouts each time it is shown
    const state = () => [els.mode.textContent, cm().getWrapperElement().hidden, els.preview.hidden, cm().refreshes];
    assert.deepEqual(state(), ['Split', false, false, 0]);
    els.mode.dispatch('click');
    assert.deepEqual(state(), ['Editor', false, true, 1]);
    assert.equal(cm().focused, true);
    els.mode.dispatch('click');
    assert.deepEqual(state(), ['Preview', true, false, 1]);
    assert.equal(els.preview.focused, true);
    els.mode.dispatch('click');
    assert.deepEqual(state(), ['Split', false, false, 2]);
    assert.equal(cm().focused, true);
  });

  await t.test('switching to a visible preview renders pending input at once', async () => {
    const { els, clock, type } = await runNote({ storage: { [KEY]: stored('a') } });
    els.mode.dispatch('click');
    type('*x*');
    els.mode.dispatch('click');
    assert.match(els.preview.innerHTML, /<em>x<\/em>/);
    assert.equal(clock.active().filter((x) => x.delay === 150).length, 0);
  });

  await t.test('Ctrl+E and Cmd+E cycle and prevent default', async () => {
    const { els, doc } = await runNote();
    const ctrl = doc.dispatch('keydown', { key: 'e', code: 'KeyE', ctrlKey: true });
    assert.equal(ctrl.defaultPrevented, true);
    assert.equal(els.mode.textContent, 'Editor');
    const cmd = doc.dispatch('keydown', { key: 'E', code: 'KeyE', metaKey: true });
    assert.equal(cmd.defaultPrevented, true);
    assert.equal(els.mode.textContent, 'Preview');
    // the physical E key on a Cyrillic layout
    const ru = doc.dispatch('keydown', { key: 'у', code: 'KeyE', ctrlKey: true });
    assert.equal(ru.defaultPrevented, true);
    assert.equal(els.mode.textContent, 'Split');
  });

  await t.test('Ctrl+E the editor already handled does not cycle', async () => {
    // on mac CodeMirror binds Ctrl-E to the emacs line end
    const { els, doc } = await runNote({ mac: true });
    doc.dispatch('keydown', { key: 'e', code: 'KeyE', ctrlKey: true, defaultPrevented: true });
    assert.equal(els.mode.textContent, 'Split');
  });

  await t.test('other keys do not cycle', async () => {
    const { els, doc } = await runNote();
    const keys = [
      { key: 'e', code: 'KeyE' },
      { key: 'x', code: 'KeyX', ctrlKey: true },
      { key: 'e', code: 'KeyE', ctrlKey: true, altKey: true },
      { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true },
    ];
    for (const props of keys) {
      const e = doc.dispatch('keydown', props);
      assert.equal(e.defaultPrevented, false, JSON.stringify(props));
    }
    assert.equal(els.mode.textContent, 'Split');
  });

  await t.test('invalid or unloadable page registers no cycle', async (t) => {
    const cases = [
      { name: 'invalid', href: base },
      { name: 'load failure', reject: { 'storage.local.get': true } },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { els, doc } = await runNote(c);
        const e = doc.dispatch('keydown', { key: 'e', code: 'KeyE', ctrlKey: true });
        assert.equal(e.defaultPrevented, false);
        assert.equal(els.mode.textContent, 'Split');
      });
    }
  });

  await t.test('preview link clicks open child tabs only for http(s)', async (t) => {
    const cases = [
      { name: 'https', href: 'https://x.com/a', opened: true },
      { name: 'http', href: 'http://x.com/', opened: true },
      { name: 'file is blocked', href: 'file:///etc/hosts', opened: false },
      { name: 'extension page is blocked', href: 'moz-extension://uuid/note/rel', opened: false },
      { name: 'javascript is blocked', href: 'javascript:alert(1)', opened: false },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { els, calls, warnings } = await runNote();
        calls.length = 0;
        const e = els.preview.dispatch('click', { target: target(c.href) });
        await settle();
        assert.equal(e.defaultPrevented, true);
        assert.deepEqual(calls, c.opened ? [['tabs.create', { url: c.href, openerTabId: 7 }]] : []);
        assert.deepEqual(warnings, []);
      });
    }
  });

  await t.test('preview links open without an opener when getCurrent failed', async () => {
    const { els, calls } = await runNote({ reject: { 'tabs.getCurrent': true } });
    calls.length = 0;
    els.preview.dispatch('click', { target: target('https://x.com/') });
    await settle();
    assert.deepEqual(calls, [['tabs.create', { url: 'https://x.com/' }]]);
  });

  await t.test('preview link auxclicks', async (t) => {
    const cases = [
      { name: 'middle-click on https opens', href: 'https://x.com/a', button: 1, opened: true },
      { name: 'middle-click on file is blocked', href: 'file:///etc/hosts', button: 1, opened: false },
      { name: 'right-click does not open', href: 'https://x.com/a', button: 2, opened: false },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { els, calls } = await runNote();
        calls.length = 0;
        const e = els.preview.dispatch('auxclick', { target: target(c.href), button: c.button });
        await settle();
        assert.equal(e.defaultPrevented, true);
        assert.deepEqual(calls, c.opened ? [['tabs.create', { url: c.href, openerTabId: 7 }]] : []);
      });
    }
  });

  await t.test('click outside a link is ignored', async () => {
    const { els, calls } = await runNote();
    calls.length = 0;
    const e = els.preview.dispatch('click', { target: target(undefined) });
    assert.equal(e.defaultPrevented, false);
    assert.deepEqual(calls, []);
  });

  await t.test('rejected link open is logged', async () => {
    const { els, warnings } = await runNote({ reject: { 'tabs.create': true } });
    els.preview.dispatch('click', { target: target('https://x.com/') });
    await settle();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'tabnotes: open link:');
  });

  await t.test('All notes focuses an existing recovery tab in its window', async () => {
    const allTabs = [
      { id: 1, windowId: 10, url: 'https://a.com/' },
      { id: 2, windowId: 20, url: `${recoveryURL}#x` },
    ];
    const { els, calls } = await runNote({ allTabs });
    calls.length = 0;
    els['all-notes'].dispatch('click');
    await settle();
    assert.deepEqual(calls, [
      ['tabs.query', {}],
      ['tabs.update', 2, { active: true }],
      ['windows.update', 20, { focused: true }],
    ]);
  });

  await t.test('All notes creates the recovery tab when none is open', async () => {
    const allTabs = [{ id: 1, windowId: 10, url: 'https://a.com/' }, { id: 3, windowId: 10 }];
    const { els, calls } = await runNote({ allTabs });
    calls.length = 0;
    els['all-notes'].dispatch('click');
    await settle();
    assert.deepEqual(calls, [
      ['tabs.query', {}],
      ['tabs.create', { url: recoveryURL }],
    ]);
  });

  await t.test('All notes logs rejected calls', async (t) => {
    const cases = [
      { name: 'query', reject: { 'tabs.query': true }, warns: ['tabnotes: query tabs:'] },
      { name: 'create', reject: { 'tabs.create': true }, warns: ['tabnotes: open recovery page:'] },
      {
        name: 'focus',
        reject: { 'tabs.update': true, 'windows.update': true },
        allTabs: [{ id: 2, windowId: 20, url: recoveryURL }],
        warns: ['tabnotes: focus recovery tab:', 'tabnotes: focus recovery window:'],
      },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { els, warnings } = await runNote(c);
        els['all-notes'].dispatch('click');
        await settle();
        assert.deepEqual(warnings.map((w) => w[0]).sort(), c.warns.sort());
      });
    }
  });

  await t.test('Settings opens the options page', async () => {
    const { els, calls } = await runNote();
    calls.length = 0;
    els.settings.dispatch('click');
    await settle();
    assert.deepEqual(calls, [['runtime.openOptionsPage']]);
  });

  await t.test('rejected openOptionsPage is logged', async () => {
    const { els, warnings } = await runNote({ reject: { 'runtime.openOptionsPage': true } });
    els.settings.dispatch('click');
    await settle();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'tabnotes: open settings:');
  });
  const DAY = 86400000;

  await t.test('binned note shows the banner with days left', async (t) => {
    const cases = [
      { name: 'fresh', deletedAt: 1000, text: 'This note is in the bin (30 days left)' },
      { name: 'last day', deletedAt: 1000 - 29.5 * DAY, text: 'This note is in the bin (1 day left)' },
      { name: 'expired', deletedAt: 1000 - 31 * DAY, text: 'This note is in the bin (0 days left)' },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { els } = await runNote({ storage: { [KEY]: stored('a', { deletedAt: c.deletedAt }) } });
        assert.equal(els.bin.hidden, false);
        assert.equal(els['bin-text'].textContent, c.text);
      });
    }
  });

  await t.test('note outside the bin has no banner', async () => {
    const { els } = await runNote({ storage: { [KEY]: stored('a') } });
    assert.equal(els.bin.hidden, true);
  });

  await t.test('Restore saves the current content with deletedAt null at once', async () => {
    const { els, writes, clock, type } = await runNote({ storage: { [KEY]: stored('a', { deletedAt: 5 }) } });
    type('ab');
    els.restore.dispatch('click');
    assert.equal(els.bin.hidden, true);
    assert.deepEqual(writes(), [
      ['storage.local.set', { [KEY]: { title: 'Jira', content: 'ab', updatedAt: 1000, deletedAt: null } }],
    ]);
    clock.run();
    assert.equal(writes().length, 1);
  });

  await t.test('trash from elsewhere is adopted while a save is pending', async () => {
    const { els, writes, clock, type, change, cm } = await runNote({ storage: { [KEY]: stored('a') } });
    type('ab');
    change({ [KEY]: { oldValue: stored('a'), newValue: stored('a', { deletedAt: 900 }) } });
    assert.equal(els.bin.hidden, false);
    assert.equal(cm().getValue(), 'ab');
    clock.run();
    assert.deepEqual(writes(), [
      ['storage.local.set', { [KEY]: { title: 'Jira', content: 'ab', updatedAt: 1000, deletedAt: 900 } }],
    ]);
  });

  await t.test('restore from elsewhere is adopted and later saves keep it', async () => {
    const { els, writes, clock, type, change } = await runNote({
      storage: { [KEY]: stored('a', { deletedAt: 5 }) },
    });
    change({ [KEY]: { newValue: stored('a') } });
    assert.equal(els.bin.hidden, true);
    type('ab');
    clock.run();
    assert.equal(writes()[0][1][KEY].deletedAt, null);
  });

  await t.test('content from elsewhere is skipped while a save is pending', async () => {
    const { els, writes, clock, type, change, cm } = await runNote({ storage: { [KEY]: stored('a') } });
    type('mine');
    change({ [KEY]: { newValue: stored('theirs', { updatedAt: 2 }) } });
    assert.equal(cm().getValue(), 'mine');
    clock.run();
    assert.equal(writes()[0][1][KEY].content, 'mine');
  });

  await t.test('content from elsewhere is applied when nothing is pending', async () => {
    const { els, writes, change, cm } = await runNote({ storage: { [KEY]: stored('a') } });
    change({ [KEY]: { newValue: stored('*theirs*', { updatedAt: 2 }) } });
    assert.equal(cm().getValue(), '*theirs*');
    assert.match(els.preview.innerHTML, /<em>theirs<\/em>/);
    assert.deepEqual(writes(), []);
  });

  await t.test('own echoed write is a no-op', async () => {
    const { els, writes, clock, type, change, cm } = await runNote({ storage: { [KEY]: stored('a') } });
    type('ab');
    clock.run();
    const saved = writes()[0][1][KEY];
    change({ [KEY]: { oldValue: stored('a'), newValue: saved } });
    assert.equal(cm().getValue(), 'ab');
    assert.equal(els.bin.hidden, true);
    assert.equal(writes().length, 1);
    assert.deepEqual(clock.active(), []);
  });

  await t.test('changes to other keys or areas are ignored', async () => {
    const { els, change, cm } = await runNote({ storage: { [KEY]: stored('a') } });
    change({ 'note:other': { newValue: stored('x', { deletedAt: 9 }) }, settings: { newValue: {} } });
    change({ [KEY]: { newValue: stored('x', { deletedAt: 9 }) } }, 'sync');
    assert.equal(cm().getValue(), 'a');
    assert.equal(els.bin.hidden, true);
  });

  await t.test('removal of a binned note disables the page and writes nothing again', async () => {
    const { els, win, writes, clock, type, change, cm } = await runNote({
      storage: { [KEY]: stored('a', { deletedAt: 5 }) },
    });
    type('ab');
    change({ [KEY]: { oldValue: stored('a', { deletedAt: 5 }) } });
    assert.equal(cm().getOption('readOnly'), 'nocursor');
    assert.equal(els.deleted.hidden, false);
    assert.equal(els.bin.hidden, true);
    clock.run();
    type('abc');
    els.restore.dispatch('click');
    change({ [KEY]: { newValue: stored('back') } });
    clock.run();
    win.dispatch('pagehide');
    assert.deepEqual(writes(), []);
    assert.equal(cm().getValue(), 'abc');
  });

  await t.test('removal after a trash adopted from elsewhere disables the page', async () => {
    const { els, win, writes, type, change } = await runNote({ storage: { [KEY]: stored('a') } });
    type('ab');
    change({ [KEY]: { newValue: stored('a', { deletedAt: 900 }) } });
    change({ [KEY]: { oldValue: stored('a', { deletedAt: 900 }) } });
    win.dispatch('pagehide');
    assert.deepEqual(writes(), []);
    assert.equal(els.deleted.hidden, false);
  });

  await t.test('removal of a note outside the bin keeps editing', async () => {
    const { els, writes, clock, type, change, cm } = await runNote({ storage: { [KEY]: stored('a') } });
    change({ [KEY]: { oldValue: stored('a') } });
    assert.equal(cm().getOption('readOnly'), undefined);
    assert.equal(els.deleted.hidden, true);
    type('again');
    clock.run();
    assert.deepEqual(writes(), [
      ['storage.local.set', { [KEY]: { title: 'Jira', content: 'again', updatedAt: 1000, deletedAt: null } }],
    ]);
  });

  await t.test('saves are stamped with the save time, not the load time', async () => {
    const { writes, clock, type } = await runNote({ now: 1000 });
    clock.now = 5000;
    type('hi');
    clock.run();
    assert.equal(writes()[0][1][KEY].updatedAt, 5000);
  });

  await t.test('preview links open without an opener when there is no current tab', async () => {
    const { els, calls, warnings } = await runNote({ tab: null });
    calls.length = 0;
    els.preview.dispatch('click', { target: target('https://x.com/') });
    await settle();
    assert.deepEqual(calls, [['tabs.create', { url: 'https://x.com/' }]]);
    assert.deepEqual(warnings, []);
  });

  await t.test('preview shows raw HTML as text', async () => {
    const { els } = await runNote({ storage: { [KEY]: stored('<img src="x.png"> <b>b</b>\n\n<iframe></iframe>') } });
    assert.doesNotMatch(els.preview.innerHTML, /<img|<b>|<iframe/);
    assert.match(els.preview.innerHTML, /&lt;img src=&quot;x.png&quot;&gt;/);
    assert.match(els.preview.innerHTML, /&lt;iframe&gt;/);
  });

  await t.test('an image that is no reference falls back to the escaping override', async (t) => {
    const cases = [
      {
        name: 'image alt closing the attribute',
        md: '![x" onload="y](http://a/b.png)',
        want: '<img src="http://a/b.png" alt="x&quot; onload=&quot;y">',
      },
      {
        name: 'image alt with an element',
        md: '![x"><b>hi</b>](http://a/b.png)',
        want: '<img src="http://a/b.png" alt="x&quot;&gt;&lt;b&gt;hi&lt;/b&gt;">',
      },
      {
        name: 'data: image alt',
        md: '![x"><b>](data:image/png;base64,AAAA)',
        want: '<img src="data:image/png;base64,AAAA" alt="x&quot;&gt;&lt;b&gt;">',
      },
      {
        name: 'image with a title',
        md: '![a](http://a/b.png "t\\"<b>")',
        want: '<img src="http://a/b.png" alt="a" title="t&quot;&lt;b&gt;">',
      },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { els } = await runNote({ storage: { [KEY]: stored(c.md) } });
        assert.ok(els.preview.innerHTML.includes(c.want), els.preview.innerHTML);
      });
    }
  });

  await t.test('preview highlights fenced code and keeps unknown languages plain', async () => {
    const md = '```js\nconst a = "<b>";\n```\n\n```nope\n<i>x</i>\n```\n\n```mermaid\na-->b\n```';
    const { els } = await runNote({ storage: { [KEY]: stored(md) } });
    assert.match(els.preview.innerHTML, /<pre><code class="hljs"><span class="hljs-keyword">const<\/span>/);
    assert.match(els.preview.innerHTML, /&lt;b&gt;/);
    assert.match(els.preview.innerHTML, /<pre><code>&lt;i&gt;x&lt;\/i&gt;<\/code><\/pre>/);
    assert.match(els.preview.innerHTML, /<pre class="mermaid">a--&gt;b<\/pre>/);
    assert.doesNotMatch(els.preview.innerHTML, /<b>|<i>/);
  });

  await t.test('copy button', async (t) => {
    const load = (content, opts) => runNote({ storage: { [KEY]: stored(content) }, ...opts });
    const written = (calls) => calls.filter(([name]) => name === 'clipboard.writeText').map(([, text]) => text);
    const click = (els, button) => els.preview.dispatch('click', { target: button });

    await t.test('every code block gets one, a diagram does not', async () => {
      const md = '```js\nlet a\n```\n\n```\nb\n```\n\n```nope\nc\n```\n\n    indented\n\n```mermaid\na-->b\n```';
      const { els } = await load(md);
      assert.equal(els.preview.copies.length, 4);
      assert.doesNotMatch(els.preview.innerHTML, /code-block"><pre class="mermaid"/);
    });

    await t.test('a nested code block gets one too', async (t) => {
      const cases = [
        { name: 'in a list', content: '- a\n\n  ```\n  b\n  ```' },
        { name: 'in a blockquote', content: '> ```\n> b\n> ```' },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { els, calls } = await load(c.content);
          assert.equal(els.preview.copies.length, 1);
          click(els, els.preview.copies[0]);
          await settle();
          assert.deepEqual(written(calls), ['b']);
        });
      }
    });

    await t.test('a click writes the code without the button label and shows Copied', async () => {
      const { els, calls, warnings } = await load('```js\nlet a = "<b>";\n```');
      const [button] = els.preview.copies;
      click(els, button);
      await settle();
      assert.deepEqual(written(calls), ['let a = "<b>";']);
      assert.equal(button.textContent, 'Copied');
      assert.deepEqual(warnings, []);
    });

    await t.test('the label returns to Copy', async () => {
      const { els, clock } = await load('```\nb\n```');
      const [button] = els.preview.copies;
      click(els, button);
      await settle();
      clock.run();
      assert.equal(button.textContent, 'Copy');
    });

    await t.test('each button copies its own block', async () => {
      const { els, calls } = await load('```\nfirst\n```\n\n    second');
      click(els, els.preview.copies[1]);
      await settle();
      assert.deepEqual(written(calls), ['second']);
    });

    await t.test('a rejected write warns and keeps the label', async () => {
      const { els, warnings } = await load('```\nb\n```', { reject: { 'clipboard.writeText': true } });
      const [button] = els.preview.copies;
      click(els, button);
      await settle();
      assert.equal(button.textContent, 'Copy');
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], 'tabnotes: copy code:');
    });

    await t.test('works on a stopped tab and writes nothing to storage', async () => {
      const { els, calls, message, writes, clock } = await load('```\nb\n```');
      await message({ type: 'stop', id: ID, tabId: 7 })[0];
      click(els, els.preview.copies[0]);
      await settle();
      clock.run();
      assert.deepEqual(written(calls), ['b']);
      assert.deepEqual(writes(), []);
    });

    await t.test('a button the selector excludes as a diagram label does nothing', async () => {
      const { els, calls, warnings } = await load('```\nb\n```');
      const button = els.preview.diagramCopy();
      click(els, button);
      await settle();
      assert.deepEqual(written(calls), []);
      assert.equal(button.textContent, 'Copy');
      assert.deepEqual(warnings, []);
    });

    await t.test('a click elsewhere in the preview copies nothing', async () => {
      const { els, calls } = await load('```\nb\n```');
      els.preview.dispatch('click', { target: target(undefined) });
      await settle();
      assert.deepEqual(written(calls), []);
    });

    await t.test('the diagram cache still finds its nodes next to code blocks', async () => {
      const { els, mermaid, type, clock } = await load('```js\nlet a\n```\n\n```mermaid\na-->b\n```');
      for (let i = 0; i < 5; i++) await settle();
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      type('```\nnew\n```\n\n```mermaid\na-->b\n```');
      clock.run();
      for (let i = 0; i < 5; i++) await settle();
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      assert.equal(els.preview.diagrams()[0].clone, true);
    });
  });

  await t.test('mermaid', async (t) => {
    await t.test('a preview without diagrams loads no script', async () => {
      const { scripts, type, clock } = await runNote({ storage: { [KEY]: stored('# hi\n\n```js\nx\n```') } });
      type('plain');
      clock.run();
      await settled();
      assert.deepEqual(scripts, []);
    });

    await t.test('the first diagram loads the script once and renders it', async () => {
      const { els, scripts, mermaid, type, clock, warnings } = await runNote({ storage: { [KEY]: stored(diagram('a-->b')) } });
      await settled();
      assert.equal(scripts.length, 1);
      assert.equal(scripts[0].src, '../vendor/mermaid.min.js');
      assert.equal(mermaid.inits.length, 1);
      const { secure, ...init } = mermaid.inits[0];
      assert.deepEqual(init, { startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'default' });
      // mermaid's defaults stay locked, plus the keys whose values reach CSS
      const mermaidSource = read('node_modules', 'mermaid', 'dist', 'mermaid.min.js');
      const defaults = JSON.parse(mermaidSource.match(/secure:(\[[^\]]*\])/)[1]);
      assert.ok(defaults.includes('securityLevel'));
      for (const k of [...defaults, 'themeCSS', 'fontFamily', 'altFontFamily']) assert.ok(secure.includes(k), k);
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      assert.equal(els.preview.diagrams()[0].rendered, true);
      type(`${diagram('a-->b')}\n\n${diagram('c-->d')}`);
      clock.run();
      await settled();
      assert.equal(scripts.length, 1);
      assert.deepEqual(mermaid.inits.at(-1), mermaid.inits[0]);
      assert.deepEqual(mermaid.runs, [['a-->b'], ['c-->d']]);
      assert.deepEqual(warnings, []);
    });

    await t.test('an unchanged diagram is swapped in from the cache', async () => {
      const { els, mermaid, type, clock } = await runNote({ storage: { [KEY]: stored(diagram('a-->b')) } });
      await settled();
      type(`text\n\n${diagram('a-->b')}`);
      clock.run();
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      const [n] = els.preview.diagrams();
      assert.equal(n.clone, true);
      assert.equal(n.isConnected, true);
      assert.equal(n.rendered, true);
      assert.equal(n.textContent, svgText('a-->b'));
    });

    await t.test('a diagram removed from the note is dropped from the cache', async () => {
      const { mermaid, type, clock } = await runNote({ storage: { [KEY]: stored(diagram('a-->b')) } });
      await settled();
      type('none');
      clock.run();
      await settled();
      type(diagram('a-->b'));
      clock.run();
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b'], ['a-->b']]);
    });

    await t.test('nodes replaced before the script loads are not rendered', async () => {
      const { els, mermaid, scripts, type, clock, warnings } = await runNote({ storage: { [KEY]: stored(diagram('a-->b')) }, mermaidLoad: 'hold' });
      type(`x\n\n${diagram('a-->b')}`);
      clock.run();
      await settle();
      scripts[0].dispatch('load');
      await settled();
      assert.equal(scripts.length, 1);
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      assert.equal(els.preview.diagrams()[0].rendered, true);
      assert.deepEqual(warnings, []);
    });

    await t.test('nodes replaced while rendering are not cached', async () => {
      const { mermaid, type, clock } = await runNote({ storage: { [KEY]: stored('') } });
      let release;
      const run = mermaid.run;
      mermaid.run = (opts) => {
        mermaid.run = run;
        mermaid.runs.push(Array.from(opts.nodes, (n) => n.textContent));
        return new Promise((r) => (release = r));
      };
      type(diagram('a-->b'));
      clock.run();
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      type('none');
      clock.run();
      release();
      await settled();
      type(diagram('a-->b'));
      clock.run();
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b'], ['a-->b']]);
    });

    await t.test('a failed load logs a warning once and keeps the source', async () => {
      const { els, scripts, warnings, type, clock } = await runNote({ storage: { [KEY]: stored(diagram('a-->b')) }, mermaidLoad: 'error' });
      await settled();
      type(diagram('c-->d'));
      clock.run();
      await settled();
      assert.equal(scripts.length, 1);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], 'tabnotes: load mermaid:');
      // Firefox reads script.src back as an absolute URL
      assert.match(String(warnings[0][1]), /load \S*vendor\/mermaid\.min\.js/);
      assert.equal(els.preview.diagrams()[0].rendered, false);
      assert.equal(els.preview.diagrams()[0].textContent, 'c-->d');
    });

    await t.test('a failed render logs a warning and shows the source', async () => {
      const { els, warnings } = await runNote({ storage: { [KEY]: stored(diagram('a--')) }, mermaidFails: true });
      await settled();
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], 'tabnotes: render diagram:');
      const [n] = els.preview.diagrams();
      assert.equal(n.rendered, false);
      assert.equal(n.textContent, 'a--');
    });

    await t.test('an unexpected throw in a diagram pass is logged and later passes still run', async () => {
      const { mermaid, warnings, type, clock } = await runNote({ storage: { [KEY]: stored('') } });
      const run = mermaid.run;
      mermaid.run = () => {
        mermaid.run = run;
        throw new Error('boom');
      };
      type(diagram('a-->b'));
      clock.run();
      await settled();
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], 'tabnotes: draw diagrams:');
      type(diagram('c-->d'));
      clock.run();
      await settled();
      assert.deepEqual(mermaid.runs, [['c-->d']]);
      assert.equal(warnings.length, 1);
    });

    await t.test('a failed diagram is cached with its source and not run again', async () => {
      const { els, mermaid, warnings, type, clock } = await runNote({ storage: { [KEY]: stored(diagram('a--')) }, mermaidFails: true });
      await settled();
      type(`text\n\n${diagram('a--')}`);
      clock.run();
      await settled();
      assert.deepEqual(mermaid.runs, [['a--']]);
      assert.equal(warnings.length, 1);
      const [n] = els.preview.diagrams();
      assert.equal(n.clone, true);
      assert.equal(n.textContent, 'a--');
    });

    await t.test('two identical diagrams render together and both come from the cache', async () => {
      const md = `${diagram('a-->b')}\n\n${diagram('a-->b')}`;
      const { els, mermaid, type, clock } = await runNote({ storage: { [KEY]: stored(md) } });
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b', 'a-->b']]);
      type(`x\n\n${md}`);
      clock.run();
      await settled();
      assert.equal(mermaid.runs.length, 1);
      assert.deepEqual(els.preview.diagrams().map((n) => [n.clone, n.rendered]), [[true, true], [true, true]]);
    });

    await t.test('an unchanged diagram rendered again while an older run is in flight ends up cached', async () => {
      const { els, mermaid, type, clock } = await runNote({ storage: { [KEY]: stored('') } });
      let release;
      const run = mermaid.run;
      mermaid.run = (opts) => {
        mermaid.run = run;
        mermaid.runs.push(Array.from(opts.nodes, (n) => n.textContent));
        return new Promise((r) => (release = r));
      };
      type(diagram('a-->b'));
      clock.run();
      await settled();
      type(`x\n\n${diagram('a-->b')}`);
      clock.run();
      await settled();
      release();
      await settled();
      // the first run's nodes were replaced, so only the second run is cached
      assert.deepEqual(mermaid.runs, [['a-->b'], ['a-->b']]);
      type(`y\n\n${diagram('a-->b')}`);
      clock.run();
      await settled();
      assert.equal(mermaid.runs.length, 2);
      assert.equal(els.preview.diagrams()[0].rendered, true);
    });

    await t.test('a hidden preview renders no diagram until it is shown', async (t) => {
      // Split -> Editor hides the preview, Editor -> Preview shows it
      const cases = [
        { name: 'render already done', flush: true },
        { name: 'render pending', flush: false },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { els, mermaid, scripts, type, clock } = await runNote({ storage: { [KEY]: stored('') } });
          els.mode.dispatch('click');
          type(diagram('a-->b'));
          if (c.flush) clock.run();
          await settled();
          assert.deepEqual(scripts, []);
          assert.deepEqual(mermaid.runs, []);
          els.mode.dispatch('click');
          await settled();
          assert.deepEqual(mermaid.runs, [['a-->b']]);
          assert.equal(els.preview.diagrams()[0].rendered, true);
        });
      }
    });

    await t.test('a diagram rendered while the preview gets hidden is not cached', async (t) => {
      // clicks during the run: Split -> Editor hides the preview, Editor ->
      // Preview shows it again before the run ends
      const cases = [
        { name: 'still hidden when the run ends', during: 1, after: 1 },
        { name: 'shown again before the run ends', during: 2, after: 0 },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { els, mermaid, type, clock } = await runNote({ storage: { [KEY]: stored('') } });
          const release = holdRun(mermaid);
          type(diagram('a-->b'));
          clock.run();
          await settled();
          assert.deepEqual(mermaid.runs, [['a-->b']]);
          for (let i = 0; i < c.during; i++) els.mode.dispatch('click');
          release();
          await settled();
          for (let i = 0; i < c.after; i++) els.mode.dispatch('click');
          await settled();
          assert.deepEqual(mermaid.runs, [['a-->b'], ['a-->b']]);
          const [n] = els.preview.diagrams();
          assert.equal(n.rendered, true);
          assert.equal(n.textContent, svgText('a-->b'));
          type(`x\n\n${diagram('a-->b')}`);
          clock.run();
          await settled();
          assert.equal(mermaid.runs.length, 2);
          assert.equal(els.preview.diagrams()[0].clone, true);
        });
      }
    });

    await t.test('a preview hidden while the script loads renders once shown', async () => {
      const { els, mermaid, scripts } = await runNote({ storage: { [KEY]: stored(diagram('a-->b')) }, mermaidLoad: 'hold' });
      await settled();
      els.mode.dispatch('click');
      scripts[0].dispatch('load');
      await settled();
      assert.deepEqual(mermaid.runs, []);
      els.mode.dispatch('click');
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      assert.equal(els.preview.diagrams()[0].rendered, true);
    });

    await t.test('a preview render waits for the diagram run in flight', async () => {
      const { els, mermaid, type, clock } = await runNote({ storage: { [KEY]: stored('') } });
      const release = holdRun(mermaid);
      type(diagram('a-->b'));
      clock.run();
      await settled();
      type(`${diagram('a-->b')}\n\n${diagram('c-->d')}`);
      clock.run();
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      release();
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b'], ['a-->b', 'c-->d']]);
      assert.deepEqual(els.preview.diagrams().map((n) => n.rendered), [true, true]);
    });

    await t.test('showing an already visible preview renders nothing again', async () => {
      const { els, mermaid } = await runNote({ storage: { [KEY]: stored(diagram('a-->b')) } });
      await settled();
      // Split -> Editor -> Preview -> Split
      for (let i = 0; i < 3; i++) els.mode.dispatch('click');
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b']]);
    });

    await t.test('a rendered diagram stays cached by its source when the preview is shown again', async () => {
      const { els, mermaid, type, clock } = await runNote({ storage: { [KEY]: stored(diagram('a-->b')) } });
      await settled();
      // Split -> Editor -> Preview: the pass on show sees the rendered node
      els.mode.dispatch('click');
      els.mode.dispatch('click');
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      type(`x\n\n${diagram('a-->b')}`);
      clock.run();
      await settled();
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      const [n] = els.preview.diagrams();
      assert.equal(n.clone, true);
      assert.equal(n.textContent, svgText('a-->b'));
    });
  });

  await t.test('days left are recomputed when the tab becomes visible', async () => {
    const { els, doc, clock } = await runNote({ storage: { [KEY]: stored('a', { deletedAt: 1000 }) } });
    assert.equal(els['bin-text'].textContent, 'This note is in the bin (30 days left)');
    clock.now = 1000 + 10 * DAY;
    doc.hidden = true;
    doc.dispatch('visibilitychange');
    assert.equal(els['bin-text'].textContent, 'This note is in the bin (30 days left)');
    doc.hidden = false;
    doc.dispatch('visibilitychange');
    assert.equal(els['bin-text'].textContent, 'This note is in the bin (20 days left)');
  });

  await t.test('Restore of a blank binned note removes it', async () => {
    const { els, writes } = await runNote({ storage: { [KEY]: stored('', { deletedAt: 5 }) } });
    els.restore.dispatch('click');
    assert.equal(els.bin.hidden, true);
    assert.deepEqual(writes(), [['storage.local.remove', KEY]]);
  });

  await t.test('trash from elsewhere with nothing pending shows the banner', async () => {
    const { els, writes, change, cm } = await runNote({ storage: { [KEY]: stored('a') } });
    const before = els.preview.innerHTML;
    change({ [KEY]: { newValue: stored('a', { deletedAt: 900 }) } });
    assert.equal(els.bin.hidden, false);
    assert.equal(cm().getValue(), 'a');
    assert.equal(els.preview.innerHTML, before);
    assert.deepEqual(writes(), []);
  });

  await t.test('restore from elsewhere is adopted while a save is pending', async () => {
    const { els, writes, clock, type, change, cm } = await runNote({ storage: { [KEY]: stored('a', { deletedAt: 5 }) } });
    type('ab');
    change({ [KEY]: { newValue: stored('a') } });
    assert.equal(els.bin.hidden, true);
    assert.equal(cm().getValue(), 'ab');
    clock.run();
    assert.deepEqual(writes(), [
      ['storage.local.set', { [KEY]: { title: 'Jira', content: 'ab', updatedAt: 1000, deletedAt: null } }],
    ]);
  });

  await t.test('removal of a binned note with nothing pending disables the page', async () => {
    const { els, win, writes, type, change, cm } = await runNote({ storage: { [KEY]: stored('a', { deletedAt: 5 }) } });
    change({ [KEY]: { oldValue: stored('a', { deletedAt: 5 }) } });
    assert.equal(cm().getOption('readOnly'), 'nocursor');
    assert.equal(els.deleted.hidden, false);
    type('x');
    win.dispatch('pagehide');
    assert.deepEqual(writes(), []);
  });

  await t.test('a late echo of an older own write is ignored', async (t) => {
    // timer save of 'ab' while binned, then Restore with 'abc' before the
    // first write's change event arrives
    const setup = async () => {
      const r = await runNote({ storage: { [KEY]: stored('a', { deletedAt: 5 }) } });
      r.type('ab');
      r.clock.run();
      const first = r.writes()[0][1][KEY];
      r.clock.now = 2000;
      r.type('abc');
      r.els.restore.dispatch('click');
      return { ...r, first };
    };
    await t.test('nothing pending', async () => {
      const { els, writes, change, first, cm } = await setup();
      change({ [KEY]: { newValue: first } });
      assert.equal(cm().getValue(), 'abc');
      assert.equal(els.bin.hidden, true);
      assert.equal(writes().length, 2);
    });
    await t.test('save pending', async () => {
      const { els, writes, clock, type, change, first } = await setup();
      type('abcd');
      change({ [KEY]: { newValue: first } });
      assert.equal(els.bin.hidden, true);
      clock.run();
      assert.deepEqual(writes().at(-1), [
        'storage.local.set',
        { [KEY]: { title: 'Jira', content: 'abcd', updatedAt: 2000, deletedAt: null } },
      ]);
    });
  });

  await t.test('a change landing while the note loads is adopted', async (t) => {
    const cases = [
      { name: 'trash', newValue: stored('a', { deletedAt: 900 }), content: 'a', bin: false },
      { name: 'newer content', newValue: stored('b', { updatedAt: 2 }), content: 'b', bin: true },
      { name: 'removal', newValue: undefined, content: '', bin: true },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { els, change, releaseLoad, cm } = await runNote({ storage: { [KEY]: stored('a') }, holdLoad: true });
        change({ [KEY]: { oldValue: stored('a'), newValue: c.newValue } });
        releaseLoad();
        await settle();
        assert.equal(els.page.hidden, false);
        assert.equal(cm().getValue(), c.content);
        assert.equal(els.bin.hidden, c.bin);
      });
    }
  });

  await t.test('stop from All notes flushes, replies once the write landed and writes nothing after', async () => {
    const { els, win, writes, clock, type, message, releaseWrites, cm } = await runNote({
      storage: { [KEY]: stored('a') },
      holdWrites: true,
    });
    type('ab');
    const replies = message({ type: 'stop', id: ID, tabId: 7 });
    let replied = false;
    replies[0].then(() => (replied = true));
    await settle();
    assert.equal(replied, false);
    assert.equal(cm().getOption('readOnly'), 'nocursor');
    assert.equal(els.deleted.hidden, false);
    releaseWrites();
    await settle();
    assert.equal(replied, true);
    assert.equal(await replies[0], true);
    type('abc');
    clock.run();
    win.dispatch('pagehide');
    releaseWrites();
    await settle();
    assert.deepEqual(writes(), [
      ['storage.local.set', { [KEY]: { title: 'Jira', content: 'ab', updatedAt: 1000, deletedAt: null } }],
    ]);
  });

  await t.test('stop with nothing pending replies at once and writes nothing', async () => {
    const { writes, message } = await runNote({ storage: { [KEY]: stored('a') } });
    assert.equal(await message({ type: 'stop', id: ID, tabId: 7 })[0], true);
    assert.deepEqual(writes(), []);
  });

  await t.test('stop for another note or tab is not answered', async (t) => {
    const other = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const cases = [
      { name: 'other note', msg: { type: 'stop', id: other, tabId: 7 } },
      { name: 'other tab of this note', msg: { type: 'stop', id: ID, tabId: 8 } },
      { name: 'other message', msg: { type: 'x', id: ID, tabId: 7 } },
      { name: 'no message', msg: undefined },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { els, writes, clock, type, message, cm } = await runNote({ storage: { [KEY]: stored('a') } });
        type('ab');
        assert.deepEqual(message(c.msg), [undefined]);
        assert.equal(cm().getOption('readOnly'), undefined);
        clock.run();
        assert.equal(writes().length, 1);
      });
    }
  });

  await t.test('a tab without a known id answers stops for any tab of its note', async () => {
    const { els, message, cm } = await runNote({ storage: { [KEY]: stored('a') }, tab: null });
    assert.equal(await message({ type: 'stop', id: ID, tabId: 8 })[0], true);
    assert.equal(cm().getOption('readOnly'), 'nocursor');
  });

  await t.test('invalid or unloadable page registers no stop listener', async () => {
    for (const opts of [{ href: base }, { reject: { 'storage.local.get': true } }]) {
      const { message } = await runNote(opts);
      assert.deepEqual(message({ type: 'stop', id: ID, tabId: 7 }), []);
    }
  });

  await t.test('rename', async (t) => {
    // a function, as a write that lands changes the storage object it was given
    const opts = () => ({ storage: { [KEY]: stored('a') } });
    // open returns the input with text typed into it; every commit below goes
    // through this, so what opens is checked in one place only
    const open = (page, text) => {
      const input = page.els['title-input'];
      page.els.title.dispatch('click');
      if (text !== undefined) input.value = text;
      return input;
    };
    const press = (input, key, props = {}) => input.dispatch('keydown', { key, ...props });
    const closed = (els) => {
      assert.equal(els['title-input'].hidden, true);
      assert.equal(els['title-hint'].hidden, true);
      assert.equal(els.title.hidden, false);
    };

    await t.test('opens', async (t) => {
      const cases = [
        { name: 'on click', act: (title) => title.dispatch('click') },
        { name: 'on Enter', act: (title) => title.dispatch('keydown', { key: 'Enter' }) },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { els } = await runNote(opts());
          c.act(els.title);
          const input = els['title-input'];
          assert.equal(input.hidden, false);
          assert.equal(input.value, 'Jira');
          assert.equal(input.focused, true);
          assert.equal(input.selected, true);
          assert.equal(els.title.hidden, true);
          assert.equal(els['title-hint'].hidden, false);
          assert.equal(els['title-hint'].textContent, TITLE_HINT);
        });
      }
    });

    await t.test('other keys and a held Enter do not open', async () => {
      const { els } = await runNote(opts());
      els.title.dispatch('keydown', { key: 'a' });
      els.title.dispatch('keydown', { key: 'Enter', repeat: true });
      closed(els);
    });

    await t.test('Enter commits and returns focus to the title', async () => {
      const page = await runNote(opts());
      const { els, doc, writes } = page;
      press(open(page, 'New'), 'Enter');
      closed(els);
      assert.equal(els.title.focused, true);
      assert.equal(els.title.textContent, 'New');
      assert.equal(doc.title, 'New');
      assert.deepEqual(writes(), [
        ['storage.local.set', { [KEY]: { title: 'New', content: 'a', updatedAt: 1000, deletedAt: null } }],
      ]);
    });

    await t.test('Esc cancels and returns focus to the title', async () => {
      const page = await runNote(opts());
      const { els, doc, writes } = page;
      press(open(page, 'New'), 'Escape');
      closed(els);
      assert.equal(els.title.focused, true);
      assert.equal(els.title.textContent, 'Jira');
      assert.equal(doc.title, 'Jira');
      assert.deepEqual(writes(), []);
    });

    await t.test('blur commits', async () => {
      const page = await runNote(opts());
      const input = open(page, 'New');
      page.cm().focus();
      input.dispatch('blur');
      closed(page.els);
      assert.equal(page.els.title.textContent, 'New');
      assert.equal(page.writes().length, 1);
    });

    await t.test('variables expand with the source read at load', async () => {
      const page = await runNote({
        ...opts(),
        tab: { id: 7, windowId: 1, openerTabId: 3 },
        sourceTab: { title: 'Source', url: 'https://github.com/x' },
      });
      press(open(page, '{host}: {tab | upper}'), 'Enter');
      assert.equal(page.els.title.textContent, 'github.com: SOURCE');
      assert.equal(page.calls.filter(([name]) => name === 'tabs.get').length, 1);
    });

    await t.test('an empty result keeps the old title', async () => {
      const page = await runNote(opts());
      press(open(page, ' {tab} '), 'Enter');
      closed(page.els);
      assert.equal(page.els.title.textContent, 'Jira');
      assert.deepEqual(page.writes(), []);
    });

    await t.test('one close per opening', async (t) => {
      await t.test('Enter then blur writes once', async () => {
        const page = await runNote(opts());
        const input = open(page, 'New');
        press(input, 'Enter');
        input.dispatch('blur');
        assert.equal(page.writes().length, 1);
      });

      await t.test('Esc then blur writes nothing', async () => {
        const page = await runNote(opts());
        const input = open(page, 'New');
        press(input, 'Escape');
        input.dispatch('blur');
        assert.equal(page.els.title.textContent, 'Jira');
        assert.deepEqual(page.writes(), []);
      });

      await t.test('stop then blur writes nothing', async () => {
        const page = await runNote(opts());
        const input = open(page, 'New');
        await page.message({ type: 'stop', id: ID, tabId: 7 })[0];
        page.els.preview.focus();
        input.dispatch('blur');
        assert.equal(page.els.title.textContent, 'Jira');
        assert.deepEqual(page.writes(), []);
      });

      await t.test('blur with the input still active keeps it open', async () => {
        const page = await runNote(opts());
        const input = open(page, 'New');
        input.dispatch('blur');
        assert.equal(input.hidden, false);
        assert.equal(input.value, 'New');
        assert.deepEqual(page.writes(), []);
        press(input, 'Enter');
        assert.equal(page.els.title.textContent, 'New');
      });

      await t.test('text equal to the opened value writes nothing', async (t) => {
        const cases = [
          { name: 'plain title', title: 'Jira' },
          { name: 'title holding braces is not expanded again', title: 'about {date}' },
        ];
        for (const c of cases) {
          await t.test(c.name, async () => {
            const page = await runNote({ storage: { [KEY]: stored('a', { title: c.title }) } });
            press(open(page), 'Enter');
            closed(page.els);
            assert.equal(page.els.title.textContent, c.title);
            assert.deepEqual(page.writes(), []);
          });
        }
      });
    });

    await t.test('saving', async (t) => {
      await t.test('writes at once, with unsaved editor content, leaving nothing pending', async () => {
        const page = await runNote(opts());
        page.type('ab');
        press(open(page, 'New'), 'Enter');
        assert.deepEqual(page.writes(), [
          ['storage.local.set', { [KEY]: { title: 'New', content: 'ab', updatedAt: 1000, deletedAt: null } }],
        ]);
        page.clock.run();
        assert.equal(page.writes().length, 1);
      });

      await t.test('a blank note stays unstored and later typing stores the title', async () => {
        const page = await runNote();
        press(open(page, 'New'), 'Enter');
        assert.equal(page.els.title.textContent, 'New');
        assert.equal(page.writes().some(([name]) => name === 'storage.local.set'), false);
        page.type('hi');
        page.clock.run();
        assert.deepEqual(page.writes().at(-1), [
          'storage.local.set',
          { [KEY]: { title: 'New', content: 'hi', updatedAt: 1001, deletedAt: null } },
        ]);
      });

      await t.test('a binned note stays binned', async () => {
        const page = await runNote({ storage: { [KEY]: stored('a', { deletedAt: 5 }) } });
        press(open(page, 'New'), 'Enter');
        assert.deepEqual(page.writes(), [
          ['storage.local.set', { [KEY]: { title: 'New', content: 'a', updatedAt: 1000, deletedAt: 5 } }],
        ]);
        assert.equal(page.els.bin.hidden, false);
      });

      await t.test('a failed save shows the banner', async () => {
        const page = await runNote({ ...opts(), reject: { 'storage.local.set': true } });
        press(open(page, 'New'), 'Enter');
        await settle();
        assert.equal(page.els['save-error'].hidden, false);
        assert.deepEqual(page.warnings.map((w) => w[0]), ['tabnotes: save note:']);
      });
    });

    await t.test('Ctrl+E in the input neither cycles nor commits', async () => {
      const page = await runNote(opts());
      const input = open(page, 'New');
      input.focus();
      const e = page.doc.dispatch('keydown', { ctrlKey: true, code: 'KeyE', key: 'e' });
      assert.equal(e.defaultPrevented, true);
      assert.equal(page.els.mode.textContent, 'Split');
      assert.equal(input.focused, true);
      assert.equal(input.hidden, false);
      assert.deepEqual(page.writes(), []);
    });

    await t.test('a stopped tab', async (t) => {
      await t.test('does not open', async () => {
        const page = await runNote(opts());
        await page.message({ type: 'stop', id: ID, tabId: 7 })[0];
        page.els.title.dispatch('click');
        page.els.title.dispatch('keydown', { key: 'Enter' });
        closed(page.els);
      });

      await t.test('closes an open input and leaves no way to rename', async () => {
        const page = await runNote(opts());
        open(page, 'New');
        await page.message({ type: 'stop', id: ID, tabId: 7 })[0];
        closed(page.els);
        assert.equal(page.els.title.textContent, 'Jira');
        assert.equal('tabindex' in page.els.title, false);
        assert.equal('title' in page.els.title, false);
      });
    });

    await t.test('from another tab', async (t) => {
      const renamed = (extra = {}) => stored('a', { title: 'Other', updatedAt: 2, ...extra });

      await t.test('updates the header and the tab title', async () => {
        const { els, doc, writes, change } = await runNote(opts());
        change({ [KEY]: { oldValue: stored('a'), newValue: renamed() } });
        assert.equal(els.title.textContent, 'Other');
        assert.equal(doc.title, 'Other');
        assert.deepEqual(writes(), []);
      });

      await t.test('survives a pending save', async () => {
        const { els, doc, writes, clock, type, change, cm } = await runNote(opts());
        type('ab');
        change({ [KEY]: { oldValue: stored('a'), newValue: renamed() } });
        assert.equal(els.title.textContent, 'Other');
        assert.equal(doc.title, 'Other');
        assert.equal(cm().getValue(), 'ab');
        clock.run();
        assert.deepEqual(writes(), [
          ['storage.local.set', { [KEY]: { title: 'Other', content: 'ab', updatedAt: 1000, deletedAt: null } }],
        ]);
      });

      await t.test('leaves an open input alone', async () => {
        const page = await runNote(opts());
        const input = open(page, 'Draft');
        page.change({ [KEY]: { oldValue: stored('a'), newValue: renamed() } });
        assert.equal(input.value, 'Draft');
        assert.equal(input.hidden, false);
        assert.equal(page.els.title.textContent, 'Other');
      });

      await t.test('closing an input left unchanged keeps the adopted title', async (t) => {
        for (const key of ['Enter', 'Escape']) {
          await t.test(key, async () => {
            const page = await runNote(opts());
            const input = open(page);
            page.change({ [KEY]: { oldValue: stored('a'), newValue: renamed() } });
            press(input, key);
            closed(page.els);
            assert.equal(page.els.title.textContent, 'Other');
            assert.equal(page.doc.title, 'Other');
            assert.deepEqual(page.writes(), []);
          });
        }
      });

      await t.test('a late echo of an older write does not take the title back', async () => {
        const page = await runNote(opts());
        page.type('ab');
        page.clock.run();
        const first = page.writes()[0][1][KEY];
        page.clock.now = 2000;
        press(open(page, 'New'), 'Enter');
        page.change({ [KEY]: { newValue: first } });
        assert.equal(page.els.title.textContent, 'New');
        assert.equal(page.doc.title, 'New');
        page.type('abc');
        page.clock.run();
        assert.equal(page.writes().at(-1)[1][KEY].title, 'New');
      });
    });

    // updatedAt is equal in both, so only a stamp above it tells the echo of the
    // earlier write from a change a tab should adopt
    await t.test('an echo of the write before the commit does not take the title back', async (t) => {
      await t.test('with the commit in the same millisecond', async () => {
        const page = await runNote(opts());
        page.type('ab');
        page.clock.run();
        const first = page.writes()[0][1][KEY];
        press(open(page, 'New'), 'Enter');
        const second = page.writes()[1][1][KEY];
        page.change({ [KEY]: { newValue: first } });
        assert.equal(page.els.title.textContent, 'New');
        assert.equal(page.doc.title, 'New');
        assert.ok(second.updatedAt > first.updatedAt);
        page.change({ [KEY]: { newValue: second } });
        page.type('abc');
        page.clock.run();
        const last = page.writes().at(-1)[1][KEY];
        assert.equal(last.title, 'New');
        assert.ok(last.updatedAt >= second.updatedAt);
      });

      await t.test('on a note left blank, where the save stamps nothing', async () => {
        const page = await runNote(opts());
        page.type('ab');
        page.clock.run();
        const first = page.writes()[0][1][KEY];
        page.type('');
        press(open(page, 'New'), 'Enter');
        assert.deepEqual(page.writes().at(-1), ['storage.local.remove', KEY]);
        page.change({ [KEY]: { newValue: first } });
        assert.equal(page.els.title.textContent, 'New');
        assert.equal(page.doc.title, 'New');
        assert.equal(page.cm().getValue(), '');
        page.type('c');
        page.clock.run();
        assert.equal(page.writes().at(-1)[1][KEY].title, 'New');
      });
    });
  });

  await t.test('a failed note save', async (t) => {
    await t.test('shows the banner, and the next save that lands hides it', async () => {
      const reject = { 'storage.local.set': true };
      const page = await runNote({ storage: { [KEY]: stored('a') }, reject });
      page.type('b');
      page.clock.run();
      await settle();
      assert.equal(page.els['save-error'].hidden, false);
      assert.ok(page.els['save-error'].textContent.includes(STORAGE_FULL_HINT));
      assert.deepEqual(page.warnings.map((w) => w[0]), ['tabnotes: save note:']);
      reject['storage.local.set'] = false;
      page.type('c');
      page.clock.run();
      await settle();
      assert.equal(page.els['save-error'].hidden, true);
    });

    await t.test('a blank note removed afterwards hides it too', async () => {
      const reject = { 'storage.local.set': true };
      const page = await runNote({ storage: { [KEY]: stored('a') }, reject });
      page.type('b');
      page.clock.run();
      await settle();
      assert.equal(page.els['save-error'].hidden, false);
      page.type('');
      page.clock.run();
      await settle();
      assert.equal(page.els['save-error'].hidden, true);
    });

    await t.test('a failed removal of a cleared note shows it, and a landed one hides it', async () => {
      const reject = { 'storage.local.remove': true };
      const page = await runNote({ storage: { [KEY]: stored('a') }, reject });
      page.type('');
      page.clock.run();
      await settle();
      assert.equal(page.els['save-error'].hidden, false);
      assert.deepEqual(page.warnings.map((w) => w[0]), ['tabnotes: remove note:']);
      reject['storage.local.remove'] = false;
      page.type(' ');
      page.clock.run();
      await settle();
      assert.equal(page.els['save-error'].hidden, true);
    });

    await t.test('a stop still gets its reply', async () => {
      const page = await runNote({ storage: { [KEY]: stored('a') }, reject: { 'storage.local.set': true } });
      page.type('b');
      assert.equal(await page.message({ type: 'stop', id: ID, tabId: 7 })[0], true);
    });
  });

  await t.test('image and orphan changes leave the note alone', async () => {
    const page = await runNote({ storage: { [KEY]: stored('a') } });
    const before = page.writes().length;
    page.change({
      'image:11111111-2222-4333-8444-555555555555': { newValue: { dataUrl: 'data:image/png;base64,AAAA' } },
      imageOrphans: { newValue: {} },
    });
    await settle();
    assert.equal(page.cm().unbatched, 0);
    assert.equal(page.cm().getValue(), 'a');
    assert.equal(page.writes().length, before);
    assert.equal(page.clock.active().length, 0);
  });

  await t.test('image references in the preview', async (t) => {
    const A = '11111111-2222-4333-8444-555555555555';
    const B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
    const ref = (id, alt = 'pic') => `![${alt}](tabnotes-image:${id})`;
    const image = (id) => ({ [`image:${id}`]: { dataUrl: `data:image/png;base64,${id}` } });
    const reads = (calls) => calls.filter(([name, keys]) => name === 'storage.local.get' && String(keys).startsWith('image:'));
    // edit types into the note and lets the preview render
    const edit = async ({ type, clock }, text) => {
      type(text);
      clock.run();
      await settle();
    };

    await t.test('a reference renders without a src and gets its data URL', async () => {
      const { els } = await runNote({ storage: { [KEY]: stored(ref(A)), ...image(A) } });
      assert.match(els.preview.innerHTML, new RegExp(`<img data-image="${A}" alt="pic" draggable="false">`));
      assert.doesNotMatch(els.preview.innerHTML, /src=/);
      assert.deepEqual(els.preview.images().map((n) => n.src), [`data:image/png;base64,${A}`]);
    });

    await t.test('alt text is escaped once', async () => {
      const { els } = await runNote({ storage: { [KEY]: stored(ref(A, 'a<b>&"c')) } });
      assert.equal(els.preview.images()[0].alt, 'a<b>&"c');
    });

    await t.test('other image URLs render directly and read nothing', async (t) => {
      const cases = [
        { name: 'remote', url: 'https://example.com/a.png' },
        { name: 'data', url: 'data:image/png;base64,AAAA' },
        { name: 'bad id', url: 'tabnotes-image:nope' },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { els, calls } = await runNote({ storage: { [KEY]: stored(`![x](${c.url})`) } });
          assert.ok(els.preview.innerHTML.includes(`<img src="${c.url}" alt="x">`), els.preview.innerHTML);
          assert.deepEqual(els.preview.images(), []);
          assert.deepEqual(reads(calls), []);
        });
      }
    });

    await t.test('a cached image needs no second read and each render gets its src', async () => {
      const page = await runNote({ storage: { [KEY]: stored(ref(A)), ...image(A) } });
      await edit(page, `${ref(A)}\n\nmore`);
      assert.deepEqual(reads(page.calls), [['storage.local.get', `image:${A}`]]);
      assert.deepEqual(page.els.preview.images().map((n) => n.src), [`data:image/png;base64,${A}`]);
    });

    await t.test('a render puts drawn nodes back and only new references get new ones', async () => {
      const page = await runNote({ storage: { [KEY]: stored(ref(A)), ...image(A) } });
      const [drawn] = page.els.preview.images();
      const src = drawn.src;
      let sets = 0;
      Object.defineProperty(drawn, 'src', { get: () => src, set: () => sets++ });
      page.type(`${ref(A, 'renamed')} ${ref(A)}`);
      page.clock.run();
      await settle();
      assert.equal(page.els.preview.images()[0], drawn);
      assert.equal(drawn.alt, 'renamed');
      assert.equal(sets, 0);
      assert.equal(page.els.preview.images()[1].src, src);
    });

    await t.test('a node with no src yet is not put back', async () => {
      const page = await runNote({ storage: { [KEY]: stored(ref(A)), ...image(A) }, imageReads: { hold: true } });
      const [waiting] = page.els.preview.images();
      page.type(`${ref(A)} `);
      page.clock.run();
      await settle();
      assert.notEqual(page.els.preview.images()[0], waiting);
    });

    await t.test('one read serves several references to one image', async () => {
      const { els, calls } = await runNote({ storage: { [KEY]: stored(`${ref(A)} ${ref(A)}`), ...image(A) } });
      assert.equal(reads(calls).length, 1);
      assert.deepEqual(els.preview.images().map((n) => n.src), Array(2).fill(`data:image/png;base64,${A}`));
    });

    await t.test('a removed reference leaves the cache', async () => {
      const page = await runNote({ storage: { [KEY]: stored(`${ref(A)} ${ref(B)}`), ...image(A), ...image(B) } });
      assert.equal(reads(page.calls).length, 2);
      await edit(page, ref(B));
      assert.equal(reads(page.calls).length, 2);
      await edit(page, `${ref(B)} ${ref(A)}`);
      assert.deepEqual(reads(page.calls).slice(2), [['storage.local.get', `image:${A}`]]);
      assert.deepEqual(page.els.preview.images().map((n) => n.src), [B, A].map((x) => `data:image/png;base64,${x}`));
    });

    await t.test('two renders during one held read make one get and the newest node gets its src', async () => {
      const page = await runNote({
        storage: { [KEY]: stored(ref(A)), ...image(A) },
        imageReads: { hold: true },
      });
      const first = page.els.preview.images()[0];
      await edit(page, `${ref(A)}\n\nmore`);
      const newest = page.els.preview.images()[0];
      assert.notEqual(first, newest);
      assert.equal(reads(page.calls).length, 1);
      assert.equal(newest.src, '');
      page.releaseImages();
      await settle();
      assert.equal(newest.src, `data:image/png;base64,${A}`);
      assert.equal(first.src, '');
    });

    await t.test('passes sharing a read set a src once', async () => {
      const page = await runNote({
        storage: { [KEY]: stored(ref(A)), ...image(A) },
        imageReads: { hold: true },
      });
      await edit(page, `${ref(A)}\n\nmore`);
      const node = page.els.preview.images()[0];
      let sets = 0;
      let src = '';
      Object.defineProperty(node, 'src', {
        get: () => src,
        set(v) {
          sets++;
          src = v;
        },
      });
      page.releaseImages();
      await settle();
      assert.equal(sets, 1);
    });

    await t.test('a missing image shows no src and logs nothing', async () => {
      const { els, warnings } = await runNote({ storage: { [KEY]: stored(ref(A)) } });
      assert.equal(els.preview.images()[0].src, '');
      assert.equal(els.preview.images()[0].alt, 'pic');
      assert.deepEqual(warnings, []);
    });

    await t.test('a rejected read is logged, leaves no src and the next render retries', async () => {
      const imageReads = { fail: true };
      const page = await runNote({ storage: { [KEY]: stored(ref(A)), ...image(A) }, imageReads });
      assert.equal(page.els.preview.images()[0].src, '');
      assert.equal(page.warnings.length, 1);
      assert.equal(page.warnings[0][0], 'tabnotes: load image:');
      imageReads.fail = false;
      await edit(page, `${ref(A)}\n\nmore`);
      assert.equal(reads(page.calls).length, 2);
      assert.equal(page.els.preview.images()[0].src, `data:image/png;base64,${A}`);
      assert.equal(page.warnings.length, 1);
    });

    await t.test('the hidden preview', async (t) => {
      await t.test('reads and sets nothing while hidden, and draws once shown', async () => {
        const page = await runNote({ storage: { [KEY]: stored('a'), ...image(A) } });
        page.els.mode.dispatch('click');
        assert.equal(page.els.preview.hidden, true);
        await edit(page, ref(A));
        assert.equal(page.els.preview.images()[0].src, '');
        assert.deepEqual(reads(page.calls), []);
        page.els.mode.dispatch('click');
        await settle();
        assert.equal(page.els.preview.hidden, false);
        assert.equal(page.els.preview.images()[0].src, `data:image/png;base64,${A}`);
        assert.equal(reads(page.calls).length, 1);
      });

      await t.test('a read finishing while hidden sets nothing, and showing draws from it', async () => {
        const page = await runNote({
          storage: { [KEY]: stored(ref(A)), ...image(A) },
          imageReads: { hold: true },
        });
        page.els.mode.dispatch('click');
        await edit(page, `${ref(A)}\n\nmore`);
        assert.equal(page.els.preview.hidden, true);
        page.releaseImages();
        await settle();
        assert.equal(page.els.preview.images()[0].src, '');
        page.els.mode.dispatch('click');
        await settle();
        assert.equal(page.els.preview.images()[0].src, `data:image/png;base64,${A}`);
        assert.equal(reads(page.calls).length, 1);
      });

      await t.test('a removed reference leaves the cache while hidden', async () => {
        const page = await runNote({ storage: { [KEY]: stored(`${ref(A)} ${ref(B)}`), ...image(A), ...image(B) } });
        assert.equal(reads(page.calls).length, 2);
        page.els.mode.dispatch('click');
        await edit(page, ref(B));
        await edit(page, `${ref(B)} ${ref(A)}`);
        page.els.mode.dispatch('click');
        await settle();
        assert.deepEqual(reads(page.calls).slice(2), [['storage.local.get', `image:${A}`]]);
      });

      await t.test('adopted content is drawn once shown', async () => {
        const page = await runNote({ storage: { [KEY]: stored('a'), ...image(A) } });
        page.els.mode.dispatch('click');
        page.change({ [KEY]: { newValue: stored(ref(A), { updatedAt: 2 }) } });
        await settle();
        assert.deepEqual(reads(page.calls), []);
        page.els.mode.dispatch('click');
        await settle();
        assert.equal(page.els.preview.images()[0].src, `data:image/png;base64,${A}`);
      });

      await t.test('a render pending when shown draws through that render, once', async () => {
        const page = await runNote({ storage: { [KEY]: stored('a'), ...image(A) } });
        page.els.mode.dispatch('click');
        page.type(ref(A));
        page.els.mode.dispatch('click');
        await settle();
        assert.equal(page.els.preview.images()[0].src, `data:image/png;base64,${A}`);
        assert.equal(reads(page.calls).length, 1);
      });

      await t.test('showing the preview again does not set a src twice', async () => {
        const page = await runNote({ storage: { [KEY]: stored(ref(A)), ...image(A) } });
        const node = page.els.preview.images()[0];
        const src = node.src;
        let sets = 0;
        Object.defineProperty(node, 'src', { get: () => src, set: () => sets++ });
        page.els.mode.dispatch('click');
        page.els.mode.dispatch('click');
        await settle();
        assert.equal(sets, 0);
      });
    });

    await t.test('a render pending when the tab is stopped still reads its images', async () => {
      const page = await runNote({ storage: { [KEY]: stored('a'), ...image(A) } });
      page.type(ref(A));
      await page.message({ type: 'stop', id: ID, tabId: 7 })[0];
      const written = page.writes().length;
      page.clock.run();
      await settle();
      assert.equal(page.els.preview.images()[0].src, `data:image/png;base64,${A}`);
      assert.equal(page.writes().length, written);
    });
  });

  await t.test('inserting images', async (t) => {
    const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const ref = (name, n) => `![${name}](tabnotes-image:${id(n)})`;
    const png = (name, props = {}) => ({ name, type: 'image/png', size: 10, ...props });
    const imageWrites = (calls) => calls.filter(([name, v]) => name === 'storage.local.set' && Object.keys(v)[0].startsWith('image:'));
    const load = (opts = {}) => runNote({ storage: { [KEY]: stored('hello') }, ...opts });
    const dropEvent = (files, at = 2, text = '') => ({
      clientX: at,
      clientY: 9,
      dataTransfer: { files, types: ['Files'], getData: (t) => (t === 'text/plain' ? text : '') },
    });
    const pasteEvent = (files, text = '') => ({ clipboardData: { files, getData: (t) => (t === 'text/plain' ? text : '') } });

    await t.test('a drop inserts at the drop position and focuses the editor', async () => {
      const { cm, els, clock, writes } = await load();
      cm().select(5);
      els.preview.focus();
      const e = cm().fire('drop', dropEvent([png('a.png')]));
      assert.equal(e.defaultPrevented, true);
      await settle();
      assert.equal(cm().getValue(), `he${ref('a.png', 1)}llo`);
      assert.equal(cm().focused, true);
      assert.deepEqual(cm().coords, [{ left: 2, top: 9 }]);
      assert.deepEqual(cm().replaced, ['paste']);
      assert.deepEqual(cm().marks.map((m) => [m.options, m.cleared]), [[{ clearWhenEmpty: false }, true]]);
      // the image first, then the note through the usual debounced save
      clock.run();
      assert.deepEqual(writes(), [
        ['storage.local.set', { [`image:${id(1)}`]: { dataUrl: 'data:image/png;base64,a.png' } }],
        ['storage.local.set', { [KEY]: stored(`he${ref('a.png', 1)}llo`, { updatedAt: 1000 }) }],
      ]);
    });

    await t.test('a paste whose text only says where the image came from keeps the image', async (t) => {
      for (const text of ['https://example.com/a.png', '/home/me/a.png', 'data:image/png;base64,AAAA']) {
        await t.test(text, async () => {
          const { cm, clock } = await load();
          const e = cm().fire('paste', pasteEvent([png('a.png')], text));
          assert.equal(e.defaultPrevented, true);
          await settle();
          clock.run();
          assert.match(cm().getValue(), /tabnotes-image:/);
          assert.doesNotMatch(cm().getValue(), new RegExp(text.replace(/[.?*+/]/g, '\\$&')));
        });
      }
    });

    await t.test('a paste replaces the selection and leaves the focus alone', async () => {
      const { cm, els, clock, writes } = await load();
      cm().select(1, 4);
      els.preview.focus();
      const e = cm().fire('paste', pasteEvent([png('a.png')]));
      assert.equal(e.defaultPrevented, true);
      await settle();
      assert.equal(cm().getValue(), `h${ref('a.png', 1)}o`);
      assert.equal(cm().focused, false);
      assert.deepEqual(cm().selected(), { anchor: 1 + ref('a.png', 1).length, head: 1 + ref('a.png', 1).length });
      assert.deepEqual(cm().replaced, ['paste']);
      clock.run();
      assert.equal(writes().length, 2);
    });

    await t.test('the image is written before the text changes', async () => {
      const page = await load({ holdWrites: true });
      page.cm().fire('drop', dropEvent([png('a.png')]));
      await settle();
      assert.equal(page.cm().getValue(), 'hello');
      page.releaseWrites();
      await settle();
      assert.deepEqual(Object.keys(imageWrites(page.calls)[0][1]), [`image:${id(1)}`]);
      assert.equal(page.cm().getValue(), `he${ref('a.png', 1)}llo`);
    });

    await t.test('several files insert one reference each', async () => {
      const { cm, calls } = await load();
      cm().fire('drop', dropEvent([png('a.png'), png('b.png', { type: 'image/jpeg' })]));
      await settle();
      assert.equal(cm().getValue(), `he${ref('a.png', 1)}\n${ref('b.png', 2)}llo`);
      assert.equal(imageWrites(calls).length, 2);
    });

    await t.test('a stored image renders through the preview after the edit', async () => {
      const { cm, els, clock } = await load();
      cm().fire('paste', pasteEvent([png('a.png')]));
      await settle();
      clock.run();
      await settle();
      assert.deepEqual(els.preview.images().map((n) => n.dataset.image), [id(1)]);
      assert.equal(els.preview.images()[0].src, 'data:image/png;base64,a.png');
    });

    await t.test('a drop carrying text next to the image still inserts it', async () => {
      const { cm } = await load();
      const e = cm().fire('drop', dropEvent([png('a.png')], 2, 'https://example.com/a.png'));
      assert.equal(e.defaultPrevented, true);
      await settle();
      assert.equal(cm().getValue(), `he${ref('a.png', 1)}llo`);
    });

    await t.test('a binned note takes the image and stays in the bin', async () => {
      const { cm, clock, writes } = await load({ storage: { [KEY]: stored('hello', { deletedAt: 500 }) } });
      cm().fire('drop', dropEvent([png('a.png')]));
      await settle();
      clock.run();
      assert.deepEqual(writes().at(-1), ['storage.local.set', { [KEY]: stored(`he${ref('a.png', 1)}llo`, { updatedAt: 1000, deletedAt: 500 }) }]);
    });

    await t.test('a clipboard image with no name gets one in the text and the messages', async (t) => {
      await t.test('inserted', async () => {
        const { cm } = await load();
        cm().fire('paste', pasteEvent([png('')]));
        await settle();
        assert.equal(cm().getValue(), `${ref('image', 1)}hello`);
      });
      await t.test('refused', async () => {
        const { cm, els } = await load();
        cm().fire('paste', pasteEvent([png('', { size: 26 * 1024 * 1024 })]));
        await settle();
        assert.equal(els['image-error'].textContent, 'image is over the 25 MB limit.');
      });
      await t.test('unreadable', async () => {
        const { cm, els } = await load();
        cm().fire('paste', pasteEvent([png('', { fail: true })]));
        await settle();
        assert.equal(els['image-error'].textContent, 'Could not read image.');
      });
      await t.test('unstorable', async () => {
        const { cm, els } = await load({ reject: { 'storage.local.set': true } });
        cm().fire('paste', pasteEvent([png('')]));
        await settle();
        assert.match(els['image-error'].textContent, /^Could not store image\./);
      });
    });

    await t.test('default handling stays', async (t) => {
      const cases = [
        { name: 'text-only paste', type: 'paste', e: pasteEvent([], 'text') },
        { name: 'empty paste', type: 'paste', e: pasteEvent([]) },
        { name: 'paste with no clipboard data', type: 'paste', e: { clipboardData: null } },
        { name: 'paste with both text and an image', type: 'paste', e: pasteEvent([png('a.png')], 'cell') },
        { name: 'paste with a URL inside text and an image', type: 'paste', e: pasteEvent([png('a.png')], 'see https://example.com') },
        { name: 'text drop', type: 'drop', e: { dataTransfer: { files: [], types: ['text/plain'], getData: () => 'x' } } },
        { name: 'drop with no data', type: 'drop', e: { dataTransfer: null } },
        { name: 'non-image drop', type: 'drop', e: dropEvent([png('a.txt', { type: 'text/plain' })]) },
        { name: 'non-image paste', type: 'paste', e: pasteEvent([png('a.pdf', { type: 'application/pdf' })]) },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { cm, calls, els } = await load();
          els['image-error'].hidden = false;
          els['image-error'].textContent = 'old';
          const e = cm().fire(c.type, c.e);
          await settle();
          assert.equal(e.defaultPrevented, false);
          assert.equal(cm().getValue(), 'hello');
          assert.deepEqual(cm().marks, []);
          assert.deepEqual(imageWrites(calls), []);
          assert.equal(els['image-error'].textContent, 'old');
        });
      }
    });

    await t.test('non-image files next to an image are skipped and reported', async () => {
      const { cm, calls, els } = await load();
      const e = cm().fire('drop', dropEvent([png('a.txt', { type: 'text/plain' }), png('b.png')]));
      assert.equal(e.defaultPrevented, true);
      await settle();
      assert.equal(cm().getValue(), `he${ref('b.png', 1)}llo`);
      assert.equal(imageWrites(calls).length, 1);
      assert.equal(els['image-error'].hidden, false);
      assert.equal(els['image-error'].textContent, 'a.txt was skipped: it is not an image.');
    });

    await t.test('the size limit', async (t) => {
      const LIMIT = 25 * 1024 * 1024;

      await t.test('an oversized file is refused and changes nothing', async () => {
        const { cm, calls, els } = await load();
        cm().select(1, 4);
        const e = cm().fire('paste', pasteEvent([png('big.png', { size: LIMIT + 1 })]));
        assert.equal(e.defaultPrevented, true);
        await settle();
        assert.equal(cm().getValue(), 'hello');
        assert.deepEqual(cm().selected(), { anchor: 1, head: 4 });
        assert.deepEqual(cm().marks, []);
        assert.deepEqual(imageWrites(calls), []);
        assert.equal(els['image-error'].hidden, false);
        assert.equal(els['image-error'].textContent, 'big.png is over the 25 MB limit.');
      });

      await t.test('an all-oversized drop leaves the focus alone', async () => {
        const { cm, els } = await load();
        els.preview.focus();
        cm().fire('drop', dropEvent([png('big.png', { size: LIMIT + 1 })]));
        await settle();
        assert.equal(cm().focused, false);
      });

      await t.test('a file of exactly the limit is stored', async () => {
        const { cm, els } = await load();
        cm().fire('drop', dropEvent([png('a.png', { size: LIMIT })]));
        await settle();
        assert.equal(cm().getValue(), `he${ref('a.png', 1)}llo`);
        assert.equal(els['image-error'].hidden, true);
      });

      await t.test('other files of the same drop still go in, the message stays', async () => {
        const { cm, els } = await load();
        cm().fire('drop', dropEvent([png('big.png', { size: LIMIT + 1 }), png('a.png')]));
        await settle();
        assert.equal(cm().getValue(), `he${ref('a.png', 1)}llo`);
        assert.equal(els['image-error'].hidden, false);
        assert.equal(els['image-error'].textContent, 'big.png is over the 25 MB limit.');
      });
    });

    await t.test('a failed write inserts nothing, keeps the selection and tells about the 7 days', async () => {
      const { cm, els, warnings } = await load({ reject: { 'storage.local.set': true } });
      cm().select(1, 4);
      cm().fire('paste', pasteEvent([png('a.png')]));
      await settle();
      assert.equal(cm().getValue(), 'hello');
      assert.deepEqual(cm().selected(), { anchor: 1, head: 4 });
      assert.equal(cm().marks[0].cleared, true);
      assert.equal(els['image-error'].hidden, false);
      assert.equal(els['image-error'].textContent, `Could not store a.png. ${STORAGE_FULL_HINT}`);
      assert.equal(warnings[0][0], 'tabnotes: save image:');
    });

    await t.test('a failed read inserts nothing and is logged', async () => {
      const { cm, els, calls, warnings } = await load();
      cm().fire('drop', dropEvent([png('a.png', { fail: true })]));
      await settle();
      assert.equal(cm().getValue(), 'hello');
      assert.deepEqual(imageWrites(calls), []);
      assert.equal(els['image-error'].textContent, 'Could not read a.png.');
      assert.equal(warnings[0][0], 'tabnotes: read image:');
    });

    await t.test('partial failure inserts the successes and keeps the message', async (t) => {
      await t.test('a read', async () => {
        const { cm, els } = await load();
        cm().fire('drop', dropEvent([png('a.png', { fail: true }), png('b.png')]));
        await settle();
        assert.equal(cm().getValue(), `he${ref('b.png', 1)}llo`);
        assert.equal(els['image-error'].textContent, 'Could not read a.png.');
      });
      await t.test('a write', async () => {
        let sets = 0;
        const reject = {
          get 'storage.local.set'() {
            return ++sets === 2;
          },
        };
        const { cm, els } = await load({ reject });
        cm().fire('drop', dropEvent([png('a.png'), png('b.png')]));
        await settle();
        assert.equal(cm().getValue(), `he${ref('a.png', 1)}llo`);
        assert.match(els['image-error'].textContent, /^Could not store b\.png\./);
      });
    });

    await t.test('the next attempt clears the message', async () => {
      const { cm, els } = await load();
      cm().fire('drop', dropEvent([png('a.png', { fail: true })]));
      await settle();
      assert.equal(els['image-error'].hidden, false);
      cm().fire('drop', dropEvent([png('b.png')]));
      assert.equal(els['image-error'].hidden, true);
      assert.equal(els['image-error'].textContent, '');
      await settle();
      assert.equal(els['image-error'].hidden, true);
    });

    await t.test('a failure message survives a concurrent attempt that succeeds', async () => {
      const fileReads = { hold: true };
      const page = await load({ fileReads });
      page.cm().fire('drop', dropEvent([png('a.png', { fail: true })], 1));
      await settle();
      page.cm().fire('drop', dropEvent([png('b.png')], 4));
      await settle();
      page.releaseFiles();
      await settle();
      assert.equal(page.els['image-error'].hidden, false);
      assert.equal(page.els['image-error'].textContent, 'Could not read a.png.');
      assert.equal(page.cm().getValue(), `hell${ref('b.png', 1)}o`);
    });

    await t.test('two attempts in flight insert at their own marks', async () => {
      const fileReads = { hold: true };
      const page = await load({ fileReads });
      page.cm().fire('drop', dropEvent([png('a.png')], 1));
      await settle();
      page.cm().fire('drop', dropEvent([png('b.png')], 4));
      await settle();
      page.releaseFiles();
      await settle();
      assert.equal(page.cm().getValue(), `h${ref('a.png', 1)}ell${ref('b.png', 2)}o`);
    });

    await t.test('edits during the read', async (t) => {
      const pos = (line, ch) => ({ line, ch });
      const held = () => load({ fileReads: { hold: true } });
      const finish = async (page) => {
        page.releaseFiles();
        await settle();
      };

      await t.test('text typed before a drop position moves it', async () => {
        const page = await held();
        page.cm().fire('drop', dropEvent([png('a.png')]));
        await settle();
        page.cm().replaceRange('XX', pos(0, 0), pos(0, 0), '+input');
        await finish(page);
        assert.equal(page.cm().getValue(), `XXhe${ref('a.png', 1)}llo`);
      });

      await t.test('text typed before a pasted selection moves the range it replaces', async () => {
        const page = await held();
        page.cm().select(1, 4);
        page.cm().fire('paste', pasteEvent([png('a.png')]));
        await settle();
        page.cm().replaceRange('XX', pos(0, 0), pos(0, 0), '+input');
        await finish(page);
        assert.equal(page.cm().getValue(), `XXh${ref('a.png', 1)}o`);
      });

      await t.test('moving the cursor leaves the position alone', async () => {
        const page = await held();
        page.cm().fire('drop', dropEvent([png('a.png')]));
        await settle();
        page.cm().select(5);
        await finish(page);
        assert.equal(page.cm().getValue(), `he${ref('a.png', 1)}llo`);
      });

      await t.test('an edit that removed the range falls back to the cursor', async () => {
        const page = await held();
        page.cm().select(1, 4);
        page.cm().fire('paste', pasteEvent([png('a.png')]));
        await settle();
        page.cm().replaceRange('', pos(0, 0), pos(0, 5), '+input');
        page.cm().replaceRange('new', pos(0, 0), pos(0, 0), '+input');
        await finish(page);
        assert.equal(page.cm().getValue(), `new${ref('a.png', 1)}`);
      });
    });

    await t.test('the editor marks insertImages relies on', async (t) => {
      // the real Doc: the fake's marks stand in for these facts everywhere else
      const { CodeMirror } = await load();
      const { Pos, Doc } = CodeMirror;
      const empty = (edit) => {
        const doc = new Doc('hello\nworld');
        const mark = doc.markText(Pos(0, 2), Pos(0, 2), { clearWhenEmpty: false });
        edit(doc);
        return mark.find()?.from.ch;
      };

      await t.test('an empty mark survives edits elsewhere and moves with them', () => {
        assert.equal(empty(() => {}), 2);
        assert.equal(empty((d) => d.replaceRange('XX', Pos(0, 0))), 4);
        assert.equal(empty((d) => d.replaceRange('XX', Pos(0, 4))), 2);
      });
      await t.test('an empty mark is gone after an edit at or across it', () => {
        assert.equal(empty((d) => d.replaceRange('XX', Pos(0, 2))), undefined);
        assert.equal(empty((d) => d.replaceRange('', Pos(0, 1), Pos(0, 3))), undefined);
      });
      await t.test('a mark is gone after setValue', () => {
        assert.equal(empty((d) => d.setValue('new')), undefined);
      });
      await t.test('a range mark moves with an edit before it', () => {
        const doc = new Doc('hello');
        const mark = doc.markText(Pos(0, 1), Pos(0, 4), { clearWhenEmpty: false });
        doc.replaceRange('XX', Pos(0, 0));
        assert.deepEqual([mark.find().from.ch, mark.find().to.ch], [3, 6]);
      });
    });

    await t.test('adoption during the read inserts at the cursor', async () => {
      const fileReads = { hold: true };
      const page = await load({ fileReads });
      page.cm().select(3);
      page.cm().fire('drop', dropEvent([png('a.png')], 1));
      await settle();
      page.change({ [KEY]: { newValue: stored('new text', { updatedAt: 2 }) } });
      assert.equal(page.cm().getValue(), 'new text');
      page.releaseFiles();
      await settle();
      assert.equal(page.cm().getValue(), `new${ref('a.png', 1)} text`);
      assert.equal(page.cm().marks[0].cleared, true);
    });

    await t.test('a tab stopped during the read writes and inserts nothing more', async () => {
      const fileReads = { hold: true };
      const page = await load({ fileReads });
      page.cm().fire('drop', dropEvent([png('a.png'), png('b.png')]));
      await settle();
      page.message({ type: 'stop', id: ID, tabId: 7 });
      page.releaseFiles();
      await settle();
      assert.deepEqual(imageWrites(page.calls), []);
      assert.equal(page.cm().getValue(), 'hello');
      assert.equal(page.cm().marks[0].cleared, true);
    });

    await t.test('a tab stopped between two files keeps the first image for the sweep', async () => {
      const fileReads = { hold: true };
      const page = await load({ fileReads });
      page.cm().fire('drop', dropEvent([png('a.png'), png('b.png')]));
      await settle();
      page.releaseFiles();
      await settle();
      page.message({ type: 'stop', id: ID, tabId: 7 });
      page.releaseFiles();
      await settle();
      assert.equal(imageWrites(page.calls).length, 1);
      assert.equal(page.cm().getValue(), 'hello');
    });

    await t.test('a tab stopped during a write reads no further file', async () => {
      const page = await load({ holdWrites: true });
      page.cm().fire('drop', dropEvent([png('a.png'), png('b.png')]));
      await settle();
      page.message({ type: 'stop', id: ID, tabId: 7 });
      page.releaseWrites();
      await settle();
      assert.deepEqual(page.filesRead, ['a.png']);
      assert.equal(page.cm().getValue(), 'hello');
    });

    await t.test('a tab stopped during the write inserts nothing', async () => {
      const page = await load({ holdWrites: true });
      page.cm().fire('drop', dropEvent([png('a.png')]));
      await settle();
      page.message({ type: 'stop', id: ID, tabId: 7 });
      page.releaseWrites();
      await settle();
      assert.equal(page.cm().getValue(), 'hello');
    });

    await t.test('a stopped tab leaves the event alone', async () => {
      const { cm, calls, message } = await load();
      message({ type: 'stop', id: ID, tabId: 7 });
      const e = cm().fire('drop', dropEvent([png('a.png')]));
      await settle();
      assert.equal(e.defaultPrevented, false);
      assert.deepEqual(imageWrites(calls), []);
      assert.deepEqual(cm().marks, []);
    });
  });

  await t.test('file drags outside the editor', async (t) => {
    const types = (...list) => ({ dataTransfer: { types: list, files: [] } });
    // both events go to the same guard, so each case checks both
    const drag = (doc, props) => ['dragover', 'drop'].map((type) => doc.dispatch(type, props).defaultPrevented);

    await t.test('are prevented', async (t) => {
      const cases = [
        { name: 'on the preview', target: ({ els }) => els.preview },
        { name: 'on the page', target: ({ els }) => els.page },
        // scrollbars are children of the wrapper, next to the scroller
        { name: 'on a scrollbar', target: ({ cm }) => ({ parent: cm().getWrapperElement() }) },
        { name: 'on a text node', target: ({ els }) => ({ nodeType: 3, parent: els.title }) },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const page = await runNote({ storage: { [KEY]: stored('a') } });
          assert.deepEqual(drag(page.doc, { ...types('Files'), target: c.target(page) }), [true, true]);
        });
      }
    });

    await t.test('are prevented in Preview mode', async () => {
      const { doc, els } = await runNote({ storage: { [KEY]: stored('a') } });
      els.mode.dispatch('click');
      els.mode.dispatch('click');
      assert.equal(els.mode.textContent, 'Preview');
      assert.deepEqual(drag(doc, { ...types('Files'), target: els.preview }), [true, true]);
    });

    await t.test('are prevented on a stopped tab', async () => {
      const { doc, els, message } = await runNote({ storage: { [KEY]: stored('a') } });
      message({ type: 'stop', id: ID, tabId: 7 });
      assert.deepEqual(drag(doc, { ...types('Files'), target: els.preview }), [true, true]);
    });

    await t.test('are left alone', async (t) => {
      const cases = [
        { name: 'a file drag on the scroller', props: types('Files'), target: ({ cm }) => cm().getScrollerElement() },
        { name: 'a file drag on a line inside it', props: types('Files'), target: ({ cm }) => ({ parent: cm().getScrollerElement() }) },
        { name: 'a file drag on a text node inside it', props: types('Files'), target: ({ cm }) => ({ nodeType: 3, parent: cm().getScrollerElement() }) },
        { name: 'a text drag outside it', props: types('text/plain'), target: ({ els }) => els.preview },
        { name: 'a drag with no data', props: { dataTransfer: null }, target: ({ els }) => els.preview },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const page = await runNote({ storage: { [KEY]: stored('a') } });
          assert.deepEqual(drag(page.doc, { ...c.props, target: c.target(page) }), [false, false]);
        });
      }
    });

    await t.test('are not guarded on a page that could not load its note', async () => {
      const { doc, els } = await runNote({ storage: { [KEY]: stored('a') }, reject: { 'storage.local.get': true } });
      assert.equal(els.error.hidden, false);
      assert.deepEqual(doc.listeners.drop, undefined);
    });

    await t.test('are not guarded on a page with an invalid id', async () => {
      const { doc, els } = await runNote({ href: base });
      assert.equal(els.invalid.hidden, false);
      assert.deepEqual(doc.listeners.drop, undefined);
    });
  });

  await t.test('font size', async (t) => {
    const font = (els) => els.panes.style.props['--note-font-size'];
    const fontWrites = (writes) => writes().filter(([, v]) => typeof v === 'object' && 'fontSize' in v);

    await t.test('stored or default size is applied on load', async (t) => {
      const cases = [
        { name: 'stored', fontSize: 18, want: '18px' },
        { name: 'absent', fontSize: undefined, want: '14px' },
        { name: 'invalid', fontSize: 'big', want: '14px' },
        { name: 'out of range', fontSize: 99, want: '32px' },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const storage = { [KEY]: stored('a') };
          if (c.fontSize !== undefined) storage.fontSize = c.fontSize;
          const { els } = await runNote({ storage });
          assert.equal(font(els), c.want);
        });
      }
    });

    await t.test('shortcuts write fontSize and apply it only from the change event', async (t) => {
      const cases = [
        { name: 'Ctrl+=', props: { key: '=', code: 'Equal', ctrlKey: true }, want: 17 },
        { name: 'Ctrl+Shift++', props: { key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }, want: 17 },
        { name: 'Ctrl+NumpadAdd', props: { key: '+', code: 'NumpadAdd', ctrlKey: true }, want: 17 },
        { name: 'German +', props: { key: '+', code: 'BracketRight', ctrlKey: true }, want: 17 },
        { name: 'Cmd+-', props: { key: '-', code: 'Minus', metaKey: true }, want: 15 },
        { name: 'Ctrl+NumpadSubtract', props: { key: '-', code: 'NumpadSubtract', ctrlKey: true }, want: 15 },
        { name: 'Ctrl+0', props: { key: '0', code: 'Digit0', ctrlKey: true }, want: 14 },
        { name: 'Ctrl+Numpad0', props: { key: '0', code: 'Numpad0', ctrlKey: true }, want: 14 },
        { name: 'AZERTY Ctrl+0', props: { key: 'à', code: 'Digit0', ctrlKey: true }, want: 14 },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { els, doc, writes, change, cm } = await runNote({ storage: { [KEY]: stored('a'), fontSize: 16 } });
          const e = doc.dispatch('keydown', c.props);
          assert.equal(e.defaultPrevented, true);
          await settle();
          assert.deepEqual(writes(), [['storage.local.set', { fontSize: c.want }]]);
          assert.equal(font(els), '16px');
          const refreshes = cm().refreshes;
          change({ fontSize: { oldValue: 16, newValue: c.want } });
          assert.equal(font(els), `${c.want}px`);
          assert.equal(cm().refreshes, refreshes + 1);
        });
      }
    });

    await t.test('steps from the last applied size, not the loaded one', async () => {
      const { doc, writes, change } = await runNote({ storage: { [KEY]: stored('a'), fontSize: 16 } });
      change({ fontSize: { oldValue: 16, newValue: 20 } });
      doc.dispatch('keydown', { key: '=', code: 'Equal', ctrlKey: true });
      await settle();
      assert.deepEqual(fontWrites(writes), [['storage.local.set', { fontSize: 21 }]]);
    });

    await t.test('steps clamp at both ends', async (t) => {
      const cases = [
        { name: 'top', fontSize: 32, props: { key: '=', code: 'Equal', ctrlKey: true }, want: 32 },
        { name: 'bottom', fontSize: 10, props: { key: '-', code: 'Minus', ctrlKey: true }, want: 10 },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { doc, writes } = await runNote({ storage: { [KEY]: stored('a'), fontSize: c.fontSize } });
          doc.dispatch('keydown', c.props);
          await settle();
          assert.deepEqual(fontWrites(writes), [['storage.local.set', { fontSize: c.want }]]);
        });
      }
    });

    await t.test('other keys write nothing', async () => {
      const { doc, writes } = await runNote({ storage: { [KEY]: stored('a') } });
      const keys = [
        { key: '=', code: 'Equal' },
        { key: '=', code: 'Equal', ctrlKey: true, altKey: true },
        { key: '1', code: 'Digit1', ctrlKey: true },
        // characters other layouts put on the Equal and Minus keys
        { key: ')', code: 'Minus', ctrlKey: true },
        { key: 'ß', code: 'Minus', ctrlKey: true },
        { key: '´', code: 'Equal', ctrlKey: true },
      ];
      for (const props of keys) {
        const e = doc.dispatch('keydown', props);
        assert.equal(e.defaultPrevented, false, JSON.stringify(props));
      }
      await settle();
      assert.deepEqual(writes(), []);
    });

    await t.test('a failed write is logged', async () => {
      const { doc, warnings } = await runNote({ storage: { [KEY]: stored('a') }, reject: { 'storage.local.set': true } });
      doc.dispatch('keydown', { key: '=', code: 'Equal', ctrlKey: true });
      await settle();
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], 'tabnotes: save font size:');
    });

    await t.test('shortcuts work in a stopped tab', async () => {
      const { doc, writes, message } = await runNote({ storage: { [KEY]: stored('a') } });
      await message({ type: 'stop', id: ID, tabId: 7 })[0];
      doc.dispatch('keydown', { key: '=', code: 'Equal', ctrlKey: true });
      await settle();
      assert.deepEqual(writes(), [['storage.local.set', { fontSize: 15 }]]);
    });

    await t.test("another tab's change is adopted, a removal resets to the default", async () => {
      const { els, change } = await runNote({ storage: { [KEY]: stored('a'), fontSize: 20 } });
      change({ fontSize: { oldValue: 20, newValue: 12 } });
      assert.equal(font(els), '12px');
      change({ fontSize: { oldValue: 12 } });
      assert.equal(font(els), '14px');
      change({ fontSize: { oldValue: 14, newValue: 22 } }, 'sync');
      assert.equal(font(els), '14px');
    });

    await t.test('a change during a held load is applied and wins over the loaded value', async () => {
      const { els, change, releaseLoad, cm } = await runNote({
        storage: { [KEY]: stored('a'), fontSize: 20 },
        holdLoad: true,
      });
      change({ fontSize: { oldValue: 20, newValue: 24 } });
      assert.equal(font(els), '24px');
      assert.equal(cm(), null);
      releaseLoad();
      await settle();
      assert.equal(font(els), '24px');
      assert.equal(cm().getValue(), 'a');
    });

    await t.test('a removal during a held load resets to the default and wins', async () => {
      const { els, change, releaseLoad } = await runNote({ storage: { [KEY]: stored('a'), fontSize: 20 }, holdLoad: true });
      change({ fontSize: { oldValue: 20 } });
      releaseLoad();
      await settle();
      assert.equal(font(els), '14px');
    });

    await t.test('a font change together with a note change adopts both', async () => {
      const { els, change, cm } = await runNote({ storage: { [KEY]: stored('a') } });
      change({ fontSize: { newValue: 18 }, [KEY]: { oldValue: stored('a'), newValue: stored('b', { updatedAt: 2 }) } });
      assert.equal(font(els), '18px');
      assert.equal(cm().getValue(), 'b');
    });

    await t.test('a font change never writes the note key', async () => {
      const { doc, writes, change, clock, win } = await runNote({ storage: { [KEY]: stored('a') } });
      doc.dispatch('keydown', { key: '=', code: 'Equal', ctrlKey: true });
      change({ fontSize: { oldValue: 14, newValue: 15 } });
      clock.run();
      win.dispatch('pagehide');
      await settle();
      assert.deepEqual(writes(), [['storage.local.set', { fontSize: 15 }]]);
    });

    await t.test('invalid or unloadable page registers no shortcuts', async () => {
      for (const opts of [{ href: base }, { reject: { 'storage.local.get': true } }]) {
        const { doc, writes } = await runNote(opts);
        const e = doc.dispatch('keydown', { key: '=', code: 'Equal', ctrlKey: true });
        assert.equal(e.defaultPrevented, false);
        await settle();
        assert.deepEqual(writes(), []);
      }
    });
  });

  await t.test('preview blocks', async (t) => {
    const load = (content) => runNote({ storage: { [KEY]: stored(content) } });

    await t.test('each block is wrapped with its source line', async () => {
      const { els } = await load('# a\n\n[r]: http://x\n\nb\n\n> c');
      const wrappers = [...els.preview.innerHTML.matchAll(/<div data-line="(\d+)">\s*<(\w+)/g)].map((m) => [m[1], m[2]]);
      assert.deepEqual(wrappers, [['0', 'h1'], ['4', 'p'], ['6', 'blockquote']]);
    });

    await t.test('a block whose raw is not in the source still gets a wrapper', async () => {
      const { els } = await load('intro\n\n\n> > a\n> b\nc\n\nend');
      assert.deepEqual([...els.preview.innerHTML.matchAll(/data-line="(\d+)"/g)].map((m) => m[1]), ['0', '3', '7']);
    });

    await t.test('the note renderers and resolved references reach the wrappers', async () => {
      const { els } = await load('[r][r]\n\n[r]: https://x.com/\n\n- [x] a\n\n<b>raw</b>\n\n```js\nconst a;\n```\n\n```nope\nb\n```\n\n```mermaid\na-->b\n```');
      const html = els.preview.innerHTML;
      assert.match(html, /<a href="https:\/\/x\.com\/">r<\/a>/);
      assert.match(html, /<input checked="" type="checkbox">/);
      assert.doesNotMatch(html, /disabled/);
      assert.match(html, /&lt;b&gt;raw&lt;\/b&gt;/);
      assert.match(html, /<code class="hljs">/);
      assert.match(html, /<pre class="mermaid">a--&gt;b<\/pre>/);
    });

    await t.test('loose task items render one box each', async () => {
      const { els } = await load('- [ ] a\n\n- [ ] b');
      assert.equal(els.preview.checkboxes().length, 2);
    });

    await t.test('a checkbox below a link definition still toggles', async () => {
      const { els, cm } = await load('[r]: http://x\n\n- [ ] a');
      els.preview.dispatch('click', { target: els.preview.checkboxes()[0] });
      assert.equal(cm().getValue(), '[r]: http://x\n\n- [x] a');
    });
  });

  await t.test('task checkboxes', async (t) => {
    const load = (content, extra) => runNote({ storage: { [KEY]: stored(content, extra) } });
    const click = (els, box) => els.preview.dispatch('click', { target: box });

    await t.test('render enabled, keeping their state', async () => {
      const { els } = await load('- [ ] a\n- [x] b');
      assert.deepEqual(els.preview.checkboxes().map((b) => [b.checked, b.disabled]), [[false, false], [true, false]]);
    });

    await t.test('a click edits the source, saves and re-renders at once', async () => {
      const { els, cm, clock, writes } = await load('- [ ] a\n- [ ] b');
      const e = click(els, els.preview.checkboxes()[1]);
      assert.equal(e.defaultPrevented, true);
      assert.equal(cm().getValue(), '- [ ] a\n- [x] b');
      assert.deepEqual(cm().replaced, ['toggle']);
      assert.deepEqual(els.preview.checkboxes().map((b) => b.checked), [false, true]);
      assert.equal(clock.active().length, 1);
      clock.run();
      await settle();
      assert.deepEqual(writes().map(([, v]) => v[KEY].content), ['- [ ] a\n- [x] b']);
    });

    await t.test('note text forges no box ahead of the tasks', async (t) => {
      const cases = [
        { name: 'image alt', forge: '![<a b="><input type=checkbox>">](x)' },
        { name: 'text after an inline pre', forge: 'a <pre> <input type=checkbox\n\nb <input type=checkbox' },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { els, cm } = await load(`${c.forge}\n\n- [ ] first\n- [ ] second`);
          assert.equal(els.preview.checkboxes().length, 2);
          click(els, els.preview.checkboxes()[0]);
          assert.equal(cm().getValue(), `${c.forge}\n\n- [x] first\n- [ ] second`);
        });
      }
    });

    await t.test('a box count that differs from the tasks refuses the click', async () => {
      const { els, cm, warnings } = await load('- [ ] a\n- [ ] b');
      els.preview.innerHTML = `<input type="checkbox">${els.preview.innerHTML}`;
      const boxes = els.preview.checkboxes();
      assert.equal(boxes.length, 3);
      for (const box of boxes) assert.equal(click(els, box).defaultPrevented, true);
      assert.equal(cm().getValue(), '- [ ] a\n- [ ] b');
      assert.deepEqual(cm().replaced, []);
      assert.deepEqual(warnings.map(([what]) => what), Array(3).fill('tabnotes: toggle task:'));
      assert.match(String(warnings[0][1]), /3 checkboxes for 2 tasks/);
    });

    await t.test('a second click unticks, also an upper case mark', async () => {
      const { els, cm } = await load('- [ ] a\n- [X] b');
      click(els, els.preview.checkboxes()[0]);
      assert.equal(cm().getValue(), '- [x] a\n- [X] b');
      click(els, els.preview.checkboxes()[0]);
      assert.equal(cm().getValue(), '- [ ] a\n- [X] b');
      click(els, els.preview.checkboxes()[1]);
      assert.equal(cm().getValue(), '- [ ] a\n- [ ] b');
    });

    await t.test('with a diagram being drawn', async (t) => {
      const content = '```mermaid\na-->b\n```\n\n- [ ] a\n- [ ] b';
      // focuses the box as a real click does, then clicks it
      const held = async () => {
        const page = await runNote({ storage: { [KEY]: stored(content) }, mermaidLoad: 'hold' });
        await settle();
        const clicked = page.els.preview.checkboxes()[1];
        clicked.focus();
        click(page.els, clicked);
        await settle();
        return { ...page, box: page.els.preview.checkboxes()[1] };
      };
      const drawn = async ({ scripts }) => {
        scripts[0].dispatch('load');
        for (let i = 0; i < 5; i++) await settle();
      };

      await t.test('focus moves to the same box once it is done', async () => {
        const page = await held();
        assert.equal(page.box.focused, false);
        await drawn(page);
        assert.equal(page.box.focused, true);
        assert.equal(page.box.focusOptions.preventScroll, true);
      });

      await t.test('focus the user moved elsewhere stays there', async () => {
        const page = await held();
        page.cm().focus();
        await drawn(page);
        assert.equal(page.box.focused, false);
        assert.equal(page.cm().focused, true);
      });

      await t.test('a failed focus is logged and later passes still run', async () => {
        const page = await held();
        page.box.focus = () => {
          throw new Error('boom');
        };
        await drawn(page);
        assert.deepEqual(page.warnings.map(([what]) => what), ['tabnotes: focus task:']);
        const passed = page.els.preview.checkboxes()[0];
        click(page.els, passed);
        await settle();
        assert.equal(page.els.preview.checkboxes()[0].focused, true);
      });
    });

    await t.test('a binned note stays binned', async () => {
      const { els, clock, writes } = await load('- [ ] a', { deletedAt: 5 });
      click(els, els.preview.checkboxes()[0]);
      clock.run();
      await settle();
      assert.deepEqual(writes().map(([, v]) => [v[KEY].content, v[KEY].deletedAt]), [['- [x] a', 5]]);
    });

    await t.test('a stopped tab does not toggle', async () => {
      const { els, cm, clock, writes, message, warnings } = await load('- [ ] a');
      await message({ type: 'stop', id: ID, tabId: 7 })[0];
      const e = click(els, els.preview.checkboxes()[0]);
      assert.equal(e.defaultPrevented, true);
      assert.equal(cm().getValue(), '- [ ] a');
      clock.run();
      await settle();
      assert.deepEqual(writes(), []);
      assert.deepEqual(warnings, []);
    });

    await t.test('an empty task ticks', async () => {
      const { els, cm } = await load('- [ ] a\n- [ ] \n- [ ] c');
      click(els, els.preview.checkboxes()[1]);
      assert.equal(cm().getValue(), '- [ ] a\n- [x] \n- [ ] c');
    });

    await t.test('a pending render flushes and does not edit', async () => {
      const { els, cm, type } = await load('- [ ] a');
      const stale = els.preview.checkboxes()[0];
      type('- [ ] new\n- [ ] a');
      const e = click(els, stale);
      assert.equal(e.defaultPrevented, true);
      assert.equal(cm().getValue(), '- [ ] new\n- [ ] a');
      assert.deepEqual(cm().replaced, []);
      assert.equal(els.preview.checkboxes().length, 2);
    });

    await t.test('a refused mapping warns and does not edit', async (t) => {
      const cases = [
        { name: 'whole note refused', content: '- [ ] - [ ] x\n- [ ] y' },
        { name: 'sentinel in the note', content: '- [ ] a \uE000' },
        { name: 'task with no marker', content: '- > - [ ] a' },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { els, cm, clock, warnings } = await load(c.content);
          const e = click(els, els.preview.checkboxes()[0]);
          assert.equal(e.defaultPrevented, true);
          assert.equal(cm().getValue(), c.content);
          assert.deepEqual(clock.active(), []);
          assert.equal(warnings.length, 1);
          assert.match(warnings[0][0], /^tabnotes: toggle task:/);
        });
      }
    });

    await t.test('an undone toggle saves and re-renders', async () => {
      const { els, cm, clock, writes } = await load('- [ ] a');
      click(els, els.preview.checkboxes()[0]);
      clock.run();
      await settle();
      cm().undo();
      assert.equal(els.preview.checkboxes()[0].checked, true);
      clock.run();
      await settle();
      assert.equal(cm().getValue(), '- [ ] a');
      assert.equal(els.preview.checkboxes()[0].checked, false);
      assert.deepEqual(writes().map(([, v]) => v[KEY].content), ['- [x] a', '- [ ] a']);
    });

    // the history of a real Doc, with no editor or DOM behind it: a fake one
    // would only repeat what the test expects
    await t.test('a toggle is its own undo step in the CodeMirror history', async () => {
      const { els, cm, clock, CodeMirror } = await load('- [ ] a');
      click(els, els.preview.checkboxes()[0]);
      const [origin] = cm().replaced;
      const doc = new CodeMirror.Doc('- [ ] a\n');
      const origins = [];
      CodeMirror.on(doc, 'change', (_, c) => origins.push(c.origin));
      const mark = (text) => doc.replaceRange(text, { line: 0, ch: 3 }, { line: 0, ch: 4 }, origin);
      doc.replaceRange('b', { line: 1, ch: 0 }, undefined, '+input');
      doc.replaceRange('c', { line: 1, ch: 1 }, undefined, '+input');
      mark('x');
      mark(' ');
      doc.replaceRange('d', { line: 1, ch: 2 }, undefined, '+input');
      const steps = [doc.getValue()];
      for (let i = 0; i < 4; i++) {
        doc.undo();
        steps.push(doc.getValue());
      }
      assert.deepEqual(steps, ['- [ ] a\nbcd', '- [ ] a\nbc', '- [x] a\nbc', '- [ ] a\nbc', '- [ ] a\n']);
      // a Doc with no editor delivers its events on a timer
      clock.run();
      assert.equal(origins.at(-1), 'undo');
    });

    await t.test('a second tab adopts the toggle and can toggle back', async () => {
      const first = await load('- [ ] a\n- [ ] b');
      const second = await load('- [ ] a\n- [ ] b');
      click(first.els, first.els.preview.checkboxes()[1]);
      first.clock.run();
      await settle();
      const [[, saved]] = first.writes();
      second.change({ [KEY]: { oldValue: stored('- [ ] a\n- [ ] b'), newValue: saved[KEY] } });
      assert.equal(second.cm().getValue(), '- [ ] a\n- [x] b');
      assert.deepEqual(second.els.preview.checkboxes().map((b) => b.checked), [false, true]);
      assert.deepEqual(second.clock.active(), []);
      assert.deepEqual(second.writes(), []);
      click(second.els, second.els.preview.checkboxes()[1]);
      assert.equal(second.cm().getValue(), '- [ ] a\n- [ ] b');
    });

    await t.test('a box the selector excludes as a diagram label neither toggles nor counts', async () => {
      const { els, cm } = await load('- [ ] a\n- [ ] b');
      const label = els.preview.diagramBox();
      const e = click(els, label);
      assert.equal(e.defaultPrevented, false);
      assert.equal(cm().getValue(), '- [ ] a\n- [ ] b');
      click(els, els.preview.checkboxes()[0]);
      assert.equal(cm().getValue(), '- [x] a\n- [ ] b');
    });
  });

  await t.test('jump to source', async (t) => {
    const load = (content, extra) => runNote({ storage: { [KEY]: stored(content, extra) } });
    const dblclick = (els, target) => els.preview.dispatch('dblclick', { target });
    const CONTENT = '# a\n\nb\n\n- c\n- d';

    await t.test('a double-click puts the cursor on the block and focuses the editor', async () => {
      const { els, cm } = await load(CONTENT);
      els.preview.focus();
      dblclick(els, els.preview.children[2].inside('li'));
      assert.deepEqual({ ...cm().getCursor() }, { line: 4, ch: 0 });
      assert.equal(cm().focused, true);
      assert.deepEqual(cm().replaced, []);
    });

    await t.test('preview-only mode cycles to split first', async () => {
      const { els, cm } = await load(CONTENT);
      els.mode.dispatch('click');
      els.mode.dispatch('click');
      assert.equal(els.mode.textContent, 'Preview');
      const refreshes = cm().refreshes;
      dblclick(els, els.preview.children[1].inside('p'));
      assert.equal(els.mode.textContent, 'Split');
      assert.equal(cm().getWrapperElement().hidden, false);
      assert.equal(els.preview.hidden, false);
      assert.equal(cm().refreshes, refreshes + 1);
      assert.deepEqual({ ...cm().getCursor() }, { line: 2, ch: 0 });
      assert.equal(cm().focused, true);
    });

    await t.test('a double-click in the split layout does not cycle', async () => {
      const { els, cm } = await load(CONTENT);
      dblclick(els, els.preview.children[1].inside('p'));
      assert.equal(els.mode.textContent, 'Split');
      assert.equal(cm().getWrapperElement().hidden, false);
    });

    // readOnly 'nocursor' makes focus a no-op and setCursor skip its scroll
    await t.test('on a stopped tab only moves the cursor', async () => {
      const { els, cm, message } = await load(CONTENT);
      await message({ type: 'stop', id: ID, tabId: 7 })[0];
      els.preview.focus();
      dblclick(els, els.preview.children[1].inside('p'));
      assert.deepEqual({ ...cm().getCursor() }, { line: 2, ch: 0 });
      assert.equal(cm().focused, false);
      assert.equal(els.preview.focused, true);
    });

    await t.test('ignored targets do nothing', async (t) => {
      const cases = [
        { name: 'link', target: (p) => p.children[1].inside('a') },
        { name: 'checkbox', target: (p) => p.children[1].inside('input') },
        { name: 'button', target: (p) => p.children[1].inside('button') },
        { name: 'outside any block', target: () => ({ closest: () => null }) },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { els, cm } = await load(CONTENT);
          els.mode.dispatch('click');
          els.mode.dispatch('click');
          els.preview.focus();
          dblclick(els, c.target(els.preview));
          assert.equal(els.mode.textContent, 'Preview');
          assert.deepEqual({ ...cm().getCursor() }, { line: 0, ch: 0 });
          assert.equal(els.preview.focused, true);
        });
      }
    });

    await t.test('a pending render flushes and does not jump', async () => {
      const { els, cm, type } = await load(CONTENT);
      const stale = els.preview.children[2].inside('li');
      type('new\n\n# a\n\nb\n\n- c\n- d');
      els.preview.focus();
      dblclick(els, stale);
      assert.deepEqual({ ...cm().getCursor() }, { line: 0, ch: 0 });
      assert.equal(els.preview.focused, true);
      assert.deepEqual(els.preview.children.map((c) => c.dataset.line), ['0', '2', '4', '6']);
    });
  });

  await t.test('diagram theme', async (t) => {
    const themes = (mermaid) => mermaid.inits.map((i) => i.theme);
    const load = async (extra = {}, storage = {}) => {
      const page = await runNote({ storage: { [KEY]: stored(diagram('a-->b')), ...storage }, ...extra });
      await settled();
      return page;
    };
    const setTheme = (change, value) => change({ theme: { oldValue: 'x', newValue: value } });

    await t.test('the first draw uses the effective theme', async (t) => {
      const cases = [
        { name: 'absent on a light system', want: 'default' },
        { name: 'absent on a dark system', systemDark: true, want: 'dark' },
        { name: 'system on a dark system', theme: 'system', systemDark: true, want: 'dark' },
        { name: 'explicit dark on a light system', theme: 'dark', want: 'dark' },
        { name: 'explicit light on a dark system', theme: 'light', systemDark: true, want: 'default' },
        { name: 'invalid on a dark system', theme: 'blue', systemDark: true, want: 'dark' },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { mermaid } = await load({ systemDark: c.systemDark }, c.theme ? { theme: c.theme } : {});
          assert.deepEqual(themes(mermaid), [c.want]);
        });
      }
    });

    await t.test('a setting change re-initializes with the full config and redraws', async () => {
      const { els, mermaid, change, warnings } = await load();
      const [first] = els.preview.diagrams();
      setTheme(change, 'dark');
      assert.equal(first.isConnected, false);
      await settled();
      assert.deepEqual(themes(mermaid), ['default', 'dark']);
      assert.deepEqual({ ...mermaid.inits[1], theme: 'default' }, mermaid.inits[0]);
      assert.ok(mermaid.inits[1].secure.includes('securityLevel'));
      assert.ok(!mermaid.inits[1].secure.includes('theme'));
      assert.deepEqual(mermaid.runs, [['a-->b'], ['a-->b']]);
      assert.equal(els.preview.diagrams()[0].rendered, true);
      assert.deepEqual(warnings, []);
    });

    await t.test('a system change redraws in system mode', async () => {
      const { mermaid, setSystemDark } = await load();
      setSystemDark(true);
      await settled();
      assert.deepEqual(themes(mermaid), ['default', 'dark']);
      assert.equal(mermaid.runs.length, 2);
    });

    await t.test('the diagrams of the old theme are not served from the cache', async () => {
      const { els, mermaid, change, type, clock } = await load();
      setTheme(change, 'dark');
      await settled();
      type(`x\n\n${diagram('a-->b')}`);
      clock.run();
      await settled();
      assert.equal(mermaid.runs.length, 2);
      assert.equal(els.preview.diagrams()[0].clone, true);
    });

    await t.test('an unchanged effective theme does nothing', async (t) => {
      const cases = [
        { name: 'system switch in explicit dark', storage: { theme: 'dark' }, act: (p) => p.setSystemDark(true) },
        { name: 'system switch in explicit light', storage: { theme: 'light' }, act: (p) => p.setSystemDark(true) },
        { name: 'dark to system on a dark system', storage: { theme: 'dark' }, systemDark: true, act: (p) => setTheme(p.change, 'system') },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const page = await load({ systemDark: c.systemDark }, c.storage);
          const [before] = page.els.preview.diagrams();
          c.act(page);
          await settled();
          assert.equal(before.isConnected, true);
          assert.equal(page.mermaid.inits.length, 1);
          assert.equal(page.mermaid.runs.length, 1);
        });
      }
    });

    await t.test('a removed key means system', async () => {
      const { mermaid, change } = await load({ systemDark: true }, { theme: 'light' });
      change({ theme: { oldValue: 'light' } });
      await settled();
      assert.deepEqual(themes(mermaid), ['default', 'dark']);
    });

    await t.test('a note with no diagrams keeps its preview', async (t) => {
      const cases = [
        { name: 'on a setting change', act: (p) => setTheme(p.change, 'dark') },
        { name: 'on a system change', act: (p) => p.setSystemDark(true) },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const page = await runNote({ storage: { [KEY]: stored('# hi') } });
          await settled();
          const box = page.els.preview.children[0];
          c.act(page);
          await settled();
          assert.equal(page.els.preview.children[0], box);
          assert.deepEqual(page.scripts, []);
        });
      }
    });

    await t.test('a diagram removed and re-added after a change uses the new theme', async () => {
      const { mermaid, change, type, clock } = await load();
      type('none');
      clock.run();
      await settled();
      setTheme(change, 'dark');
      await settled();
      assert.deepEqual(themes(mermaid), ['default']);
      type(diagram('a-->b'));
      clock.run();
      await settled();
      assert.deepEqual(themes(mermaid), ['default', 'dark']);
      assert.equal(mermaid.runs.length, 2);
    });

    await t.test('a change in another area or of another key does nothing', async () => {
      const { els, mermaid, change } = await load();
      const [before] = els.preview.diagrams();
      change({ theme: { newValue: 'dark' } }, 'sync');
      change({ fontSize: { newValue: 20 } });
      await settled();
      assert.equal(before.isConnected, true);
      assert.equal(mermaid.inits.length, 1);
      assert.equal(mermaid.runs.length, 1);
    });

    await t.test('one event with the theme and the note applies both', async () => {
      const { cm, mermaid, change } = await load();
      change({ theme: { newValue: 'dark' }, [KEY]: { newValue: stored(diagram('c-->d'), { updatedAt: 5 }) } });
      await settled();
      assert.equal(cm().getValue(), diagram('c-->d'));
      assert.equal(themes(mermaid).at(-1), 'dark');
      assert.deepEqual(mermaid.runs.at(-1), ['c-->d']);
    });

    await t.test('two changes in a row end on the last theme', async () => {
      const { els, mermaid, change, type, clock } = await load();
      setTheme(change, 'dark');
      await settled();
      setTheme(change, 'light');
      await settled();
      assert.deepEqual(themes(mermaid), ['default', 'dark', 'default']);
      assert.equal(mermaid.runs.length, 3);
      type(`x\n\n${diagram('a-->b')}`);
      clock.run();
      await settled();
      assert.equal(mermaid.runs.length, 3);
      assert.equal(els.preview.diagrams()[0].clone, true);
    });

    await t.test('two changes during a run end on the last theme', async () => {
      const { els, mermaid, change, type, clock } = await runNote({ storage: { [KEY]: stored('') } });
      const release = holdRun(mermaid);
      type(diagram('a-->b'));
      clock.run();
      await settled();
      setTheme(change, 'dark');
      setTheme(change, 'light');
      release();
      await settled();
      assert.equal(themes(mermaid).at(-1), 'default');
      assert.equal(mermaid.runs.length, 2);
      type(`x\n\n${diagram('a-->b')}`);
      clock.run();
      await settled();
      assert.equal(mermaid.runs.length, 2);
      assert.equal(els.preview.diagrams()[0].clone, true);
    });

    await t.test('a change with a typed render pending draws the text once', async () => {
      const { els, mermaid, change, type, clock } = await load();
      type(`${diagram('a-->b')}\n\n${diagram('c-->d')}`);
      setTheme(change, 'dark');
      await settled();
      clock.run();
      await settled();
      assert.equal(themes(mermaid).at(-1), 'dark');
      assert.deepEqual(mermaid.runs, [['a-->b'], ['a-->b', 'c-->d']]);
      assert.equal(els.preview.diagrams().length, 2);
      assert.ok(els.preview.diagrams().every((n) => n.clone));
    });

    await t.test('the config is set when the script loads, also with nothing to draw', async (t) => {
      const cases = [
        { name: 'preview hidden meanwhile', act: (p) => p.els.mode.dispatch('click') },
        {
          name: 'nodes replaced meanwhile',
          act: (p) => {
            p.type('none');
            p.clock.run();
          },
        },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const page = await load({ mermaidLoad: 'hold' });
          c.act(page);
          await settled();
          page.scripts[0].dispatch('load');
          await settled();
          assert.equal(page.mermaid.inits.length, 1);
          const { startOnLoad, securityLevel, secure } = page.mermaid.inits[0];
          assert.equal(startOnLoad, false);
          assert.equal(securityLevel, 'strict');
          assert.ok(secure.includes('themeCSS'));
          assert.deepEqual(page.mermaid.runs, []);
        });
      }
    });

    await t.test('a failing initialize is logged, runs nothing and is retried', async () => {
      const { els, mermaid, type, clock, warnings } = await runNote({ storage: { [KEY]: stored('') } });
      const initialize = mermaid.initialize;
      mermaid.initialize = () => {
        mermaid.initialize = initialize;
        throw new Error('boom');
      };
      type(diagram('a-->b'));
      clock.run();
      await settled();
      assert.deepEqual(warnings.map(([what]) => what), ['tabnotes: draw diagrams:']);
      assert.deepEqual(mermaid.runs, []);
      assert.equal(els.preview.diagrams()[0].textContent, 'a-->b');
      type(`x\n\n${diagram('a-->b')}`);
      clock.run();
      await settled();
      assert.equal(mermaid.inits.length, 1);
      assert.equal(mermaid.inits[0].securityLevel, 'strict');
      assert.equal(mermaid.inits[0].startOnLoad, false);
      assert.deepEqual(mermaid.runs, [['a-->b']]);
      assert.equal(els.preview.diagrams()[0].rendered, true);
      assert.equal(warnings.length, 1);
    });

    await t.test('a diagram added after a change uses the new theme', async () => {
      const { mermaid, change, type, clock } = await runNote({ storage: { [KEY]: stored('none') } });
      setTheme(change, 'dark');
      type(diagram('a-->b'));
      clock.run();
      await settled();
      assert.deepEqual(themes(mermaid), ['dark']);
    });

    await t.test('the preview position is kept', async (t) => {
      const content = `${diagram('a-->b')}\n\na\n\nb\n\nc`;
      // the redraw shrinks the preview, so the sync after the pass reads a clamped top
      const shrinkOnRun = (els, mermaid) => {
        const run = mermaid.run;
        mermaid.run = (opts) => {
          els.preview.scrollTop = 0;
          return run(opts);
        };
      };

      await t.test('when the preview drives, which also moves the editor back', async () => {
        const { els, cm, change, mermaid } = await load({}, { [KEY]: stored(content) });
        els.preview.dispatch('wheel');
        els.preview.scrollTop = 300;
        shrinkOnRun(els, mermaid);
        setTheme(change, 'dark');
        await settled();
        assert.equal(els.preview.scrollTop, 300);
        assert.ok(cm().getScrollInfo().top > 0);
      });

      await t.test('with the editor hidden', async () => {
        const { els, change, mermaid } = await load({}, { [KEY]: stored(content) });
        els.mode.dispatch('click');
        els.mode.dispatch('click');
        await settled();
        els.preview.scrollTop = 300;
        shrinkOnRun(els, mermaid);
        setTheme(change, 'dark');
        await settled();
        assert.equal(els.preview.scrollTop, 300);
      });

      await t.test('a failed sync after the restore is logged and later passes still run', async () => {
        const { els, cm, change, mermaid, type, clock, warnings } = await load({}, { [KEY]: stored(content) });
        els.preview.dispatch('wheel');
        els.preview.scrollTop = 300;
        shrinkOnRun(els, mermaid);
        const height = cm().heightAtLine;
        // the sync chained to the pass runs at the clamped top and must not fail
        cm().heightAtLine = (...args) => {
          if (els.preview.scrollTop === 300) throw new Error('boom');
          return height(...args);
        };
        setTheme(change, 'dark');
        await settled();
        assert.deepEqual(warnings.map(([what]) => what), ['tabnotes: restore preview scroll:']);
        cm().heightAtLine = height;
        type(`${diagram('c-->d')}\n\n${content}`);
        clock.run();
        await settled();
        assert.deepEqual(mermaid.runs.at(-1), ['c-->d']);
        assert.equal(warnings.length, 1);
      });
    });

    await t.test('a hidden preview gets no position written back', async () => {
      const { els, change } = await load();
      els.mode.dispatch('click');
      els.preview.scrollTop = 100;
      setTheme(change, 'dark');
      els.preview.scrollTop = 50;
      await settled();
      assert.equal(els.preview.scrollTop, 50);
    });

    await t.test('a change during the load wins over the loaded value', async () => {
      const { releaseLoad, change, mermaid } = await runNote({ storage: { [KEY]: stored(diagram('a-->b')), theme: 'light' }, holdLoad: true });
      setTheme(change, 'dark');
      releaseLoad();
      await settled();
      assert.deepEqual(themes(mermaid), ['dark']);
      assert.equal(mermaid.runs.length, 1);
    });

    await t.test('a change on a failed note load is harmless', async () => {
      const { els, change, media, scripts, warnings } = await runNote({ reject: { 'storage.local.get': true } });
      assert.equal(els.error.hidden, false);
      setTheme(change, 'dark');
      await settled();
      assert.equal(media.listeners.change, undefined);
      assert.deepEqual(scripts, []);
      assert.deepEqual(warnings.map(([what]) => what), ['tabnotes: load note:']);
    });

    await t.test('a change while the preview is hidden draws once it is shown', async () => {
      const { els, mermaid, change } = await load();
      els.mode.dispatch('click');
      assert.equal(els.preview.hidden, true);
      setTheme(change, 'dark');
      await settled();
      assert.equal(mermaid.runs.length, 1);
      assert.equal(mermaid.inits.length, 1);
      els.mode.dispatch('click');
      await settled();
      assert.deepEqual(themes(mermaid), ['default', 'dark']);
      assert.equal(mermaid.runs.length, 2);
      assert.equal(els.preview.diagrams()[0].rendered, true);
    });

    await t.test('a change during a run caches no old-theme SVG', async () => {
      const { els, mermaid, change, type, clock } = await runNote({ storage: { [KEY]: stored('') } });
      const release = holdRun(mermaid);
      type(diagram('a-->b'));
      clock.run();
      await settled();
      const [old] = els.preview.diagrams();
      setTheme(change, 'dark');
      assert.equal(old.isConnected, false);
      release();
      await settled();
      assert.deepEqual(themes(mermaid), ['default', 'dark']);
      assert.equal(mermaid.runs.length, 2);
      // only the second run's result is cached, and it serves the next render
      type(`x\n\n${diagram('a-->b')}`);
      clock.run();
      await settled();
      assert.equal(mermaid.runs.length, 2);
      assert.equal(els.preview.diagrams()[0].clone, true);
    });

    await t.test('a change while the script loads draws once, in the new theme', async () => {
      const { mermaid, scripts, change } = await load({ mermaidLoad: 'hold' });
      setTheme(change, 'dark');
      scripts[0].dispatch('load');
      await settled();
      assert.deepEqual([...new Set(themes(mermaid))], ['dark']);
      assert.equal(mermaid.runs.length, 1);
    });

    await t.test('a change after a failed mermaid load keeps the source and logs nothing new', async () => {
      const { els, change, scripts, warnings } = await load({ mermaidLoad: 'error' });
      assert.equal(warnings.length, 1);
      setTheme(change, 'dark');
      await settled();
      assert.equal(scripts.length, 1);
      assert.equal(warnings.length, 1);
      assert.equal(els.preview.diagrams()[0].textContent, 'a-->b');
    });

    await t.test('a stopped tab still redraws and writes nothing', async () => {
      const { mermaid, change, message, writes } = await load();
      await message({ type: 'stop', id: ID, tabId: 7 })[0];
      const before = writes().length;
      setTheme(change, 'dark');
      await settled();
      assert.equal(mermaid.runs.length, 2);
      assert.equal(writes().length, before);
    });
  });

  await t.test('scroll sync', async (t) => {
    // blocks on lines 0, 2, 4, 6, 8: editor tops 0..160, preview tops 0..320,
    // so above the last block the preview scrolls twice as far as the editor
    const CONTENT = 'a\n\nb\n\nc\n\nd\n\ne';
    const load = (content = CONTENT, extra = {}) => runNote({ storage: { [KEY]: stored(content) }, ...extra });
    const editorTop = (cm) => cm().getScrollInfo().top;
    const scrollPreview = (els, top) => {
      els.preview.scrollTop = top;
      els.preview.dispatch('scroll');
    };
    const usePreview = (els) => els.preview.dispatch('wheel');
    const useEditor = (cm) => cm().getWrapperElement().dispatch('wheel');

    await t.test('an editor scroll moves the preview', async () => {
      const { els, cm } = await load();
      cm().userScroll(60);
      assert.equal(els.preview.scrollTop, 120);
    });

    await t.test('past the last anchor the map runs to both ends', async () => {
      const { els, cm } = await load();
      cm().userScroll(800);
      assert.equal(els.preview.scrollTop, 1200);
    });

    await t.test('a preview scroll moves the editor', async (t) => {
      for (const type of ['wheel', 'pointerdown', 'keydown', 'focusin']) {
        await t.test(type, async () => {
          const { els, cm } = await load();
          els.preview.dispatch(type);
          scrollPreview(els, 120);
          assert.equal(editorTop(cm), 60);
        });
      }
    });

    await t.test('focusing the preview makes it the driving pane', async () => {
      const { els, cm } = await load();
      els.preview.focus();
      scrollPreview(els, 120);
      assert.equal(editorTop(cm), 60);
    });

    await t.test('interacting with the editor takes the drive back', async (t) => {
      for (const type of ['wheel', 'pointerdown', 'keydown', 'focusin']) {
        await t.test(type, async () => {
          const { els, cm } = await load();
          usePreview(els);
          cm().getWrapperElement().dispatch(type);
          cm().userScroll(60);
          assert.equal(els.preview.scrollTop, 120);
        });
      }
    });

    await t.test('the non-driving pane is ignored', async (t) => {
      await t.test('preview, while the editor drives', async () => {
        const { els, cm } = await load();
        scrollPreview(els, 120);
        assert.equal(editorTop(cm), 0);
      });
      await t.test('editor, while the preview drives', async () => {
        const { els, cm } = await load();
        usePreview(els);
        cm().userScroll(60);
        assert.equal(els.preview.scrollTop, 0);
      });
    });

    await t.test('nothing happens outside split mode', async (t) => {
      await t.test('editor only', async () => {
        const { els, cm } = await load();
        els.mode.dispatch('click');
        assert.equal(els.mode.textContent, 'Editor');
        cm().userScroll(60);
        assert.equal(els.preview.scrollTop, 0);
      });
      await t.test('preview only', async () => {
        const { els, cm } = await load();
        els.mode.dispatch('click');
        els.mode.dispatch('click');
        assert.equal(els.mode.textContent, 'Preview');
        scrollPreview(els, 120);
        assert.equal(editorTop(cm), 0);
      });
    });

    await t.test('an echo after the drive changed hands is skipped', async (t) => {
      for (const echo of [120, 119, 121]) {
        await t.test(`at ${echo}`, async () => {
          const { els, cm } = await load();
          cm().userScroll(60);
          cm().scrollTo(null, 300);
          usePreview(els);
          scrollPreview(els, echo);
          assert.equal(editorTop(cm), 300);
        });
      }
    });

    await t.test('an echo is skipped in the other direction too', async () => {
      const { els, cm } = await load();
      usePreview(els);
      scrollPreview(els, 120);
      els.preview.scrollTop = 500;
      useEditor(cm);
      cm().userScroll(60);
      assert.equal(els.preview.scrollTop, 500);
    });

    await t.test('more than 1px from the written value is a real scroll', async () => {
      const { els, cm } = await load();
      cm().userScroll(60);
      usePreview(els);
      scrollPreview(els, 122);
      assert.equal(editorTop(cm), 61);
    });

    await t.test('a write that fires no event does not swallow the next scroll', async () => {
      const { els, cm } = await load();
      cm().userScroll(60);
      usePreview(els);
      scrollPreview(els, 200);
      assert.equal(editorTop(cm), 100);
    });

    await t.test('an echo is skipped once, so a return to that spot syncs', async () => {
      const { els, cm } = await load();
      cm().userScroll(60);
      usePreview(els);
      scrollPreview(els, 120);
      cm().scrollTo(null, 300);
      scrollPreview(els, 120);
      assert.equal(editorTop(cm), 60);
    });

    await t.test('re-syncs after a render, as the diagram pass settles', async () => {
      const { els, cm, type, clock } = await load();
      cm().scrollTo(null, 60);
      type(`${CONTENT}\n`);
      clock.run();
      assert.equal(els.preview.scrollTop, 0);
      await settle();
      assert.equal(els.preview.scrollTop, 120);
    });

    await t.test('re-syncs when a preview image loads, which does not bubble', async () => {
      const { els, cm } = await load();
      cm().scrollTo(null, 60);
      assert.equal(els.preview.scrollTop, 0);
      els.preview.dispatch('load');
      assert.equal(els.preview.scrollTop, 120);
      assert.deepEqual(els.preview.captured, ['load']);
    });

    await t.test('re-syncs once an uncached diagram finishes', async () => {
      const { els, cm, scripts } = await load('a\n\n```mermaid\nx\n```\n\nb', { mermaidLoad: 'hold' });
      await settle();
      cm().scrollTo(null, 20);
      await settle();
      assert.equal(els.preview.scrollTop, 0);
      scripts[0].dispatch('load');
      await settle();
      assert.equal(els.preview.scrollTop, 40);
    });

    await t.test('a failed diagram pass still re-syncs', async (t) => {
      const content = 'a\n\n```mermaid\nx\n```\n\nb';
      const cases = [
        { name: 'render rejects', extra: { mermaidFails: true }, warning: 'tabnotes: render diagram:' },
        { name: 'the pass throws', extra: {}, warning: 'tabnotes: draw diagrams:', boom: true },
      ];
      for (const c of cases) {
        await t.test(c.name, async () => {
          const { els, cm, scripts, mermaid, warnings } = await load(content, { mermaidLoad: 'hold', ...c.extra });
          if (c.boom) {
            mermaid.run = () => {
              throw new Error('boom');
            };
          }
          await settle();
          cm().scrollTo(null, 20);
          await settle();
          assert.equal(els.preview.scrollTop, 0);
          scripts[0].dispatch('load');
          for (let i = 0; i < 5; i++) await settle();
          assert.equal(els.preview.scrollTop, 40);
          assert.deepEqual(warnings.map(([what]) => what), [c.warning]);
        });
      }
    });

    await t.test('a failed sync is logged under its own name and later passes still run', async () => {
      const { els, cm, type, clock, warnings } = await load();
      const height = cm().heightAtLine;
      cm().heightAtLine = () => {
        throw new Error('boom');
      };
      type(`${CONTENT}\n`);
      clock.run();
      await settle();
      assert.deepEqual(warnings.map(([what]) => what), ['tabnotes: sync scroll:']);
      cm().heightAtLine = height;
      cm().scrollTo(null, 60);
      type(`${CONTENT}\n\n`);
      clock.run();
      await settle();
      assert.equal(els.preview.scrollTop, 120);
      assert.equal(warnings.length, 1);
    });

    await t.test('a driving pane with nothing to scroll moves nothing', async (t) => {
      await t.test('an editor that fits keeps the preview where it is', async () => {
        const { els, type, clock } = await load(CONTENT, { layout: { editor: { height: 200 } } });
        els.preview.scrollTop = 300;
        type(`${CONTENT}\n`);
        clock.run();
        await settle();
        assert.equal(els.preview.scrollTop, 300);
      });
      await t.test('a preview that fits keeps the editor where it is', async () => {
        const { els, cm, type, clock } = await load(CONTENT, { layout: { preview: { scrollHeight: 200 } } });
        usePreview(els);
        cm().scrollTo(null, 300);
        type(`${CONTENT}\n`);
        clock.run();
        await settle();
        assert.equal(editorTop(cm), 300);
      });
    });

    await t.test('a preview too short for the mapped value clamps', async () => {
      const { els, cm } = await load(CONTENT, { layout: { preview: { scrollHeight: 300 } } });
      cm().userScroll(800);
      assert.equal(els.preview.scrollTop, 100);
    });

    await t.test('re-syncs from a driving preview, which stays put', async () => {
      const { els, cm, type, clock } = await load();
      usePreview(els);
      els.preview.scrollTop = 120;
      type(`${CONTENT}\n`);
      clock.run();
      await settle();
      assert.equal(els.preview.scrollTop, 120);
      assert.equal(editorTop(cm), 60);
    });

    await t.test('a checkbox toggle keeps the reader in the preview', async () => {
      const { els, cm } = await load('a\n\nb\n\n- [ ] c');
      els.preview.dispatch('pointerdown');
      els.preview.scrollTop = 40;
      els.preview.dispatch('click', { target: els.preview.checkboxes()[0] });
      await settle();
      assert.equal(cm().getValue(), 'a\n\nb\n\n- [x] c');
      assert.equal(els.preview.scrollTop, 40);
      assert.equal(editorTop(cm), 20);
    });

    await t.test('entering split syncs the editor to the preview that was read', async () => {
      const { els, cm } = await load();
      els.mode.dispatch('click');
      els.mode.dispatch('click');
      els.preview.scrollTop = 120;
      els.mode.dispatch('click');
      assert.equal(els.mode.textContent, 'Split');
      assert.equal(editorTop(cm), 60);
      await settle();
      assert.equal(els.preview.scrollTop, 120);
    });

    await t.test('works on a stopped tab', async () => {
      const { els, cm, message } = await load();
      await message({ type: 'stop', id: ID, tabId: 7 })[0];
      cm().userScroll(60);
      assert.equal(els.preview.scrollTop, 120);
    });
  });
});
