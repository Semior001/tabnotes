'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bundle } = require('./bundle.js');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const script = bundle('src/recovery/recovery.ts');

const DAY_MS = 86400000;
const NOW = Date.UTC(2026, 9, 29);
const BASE = 'moz-extension://uuid/note/note.html';
const ID1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ID3 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const ID4 = '886313e1-3b8a-4372-9b90-0c9aee199e5d';
const key = (id) => `note:${id}`;
const url = (id) => `${BASE}?id=${id}`;

// focus is shared by every element of one page, like document.activeElement
function element(attrs = {}, focus = { active: null }) {
  const listeners = {};
  return {
    value: '',
    hidden: false,
    className: '',
    textContent: '',
    children: [],
    dataset: {},
    ...attrs,
    listeners,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    focus() {
      focus.active = this;
    },
    contains(node) {
      return node === this || this.children.some((c) => c.contains(node));
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatch(type, props = {}) {
      const e = { type, ...props };
      for (const fn of listeners[type] || []) fn(e);
      return e;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
  };
}

// find returns the first descendant of node with the given class, or null
function find(node, cls) {
  for (const c of node.children) {
    if (c.className === cls) return c;
    const hit = find(c, cls);
    if (hit) return hit;
  }
  return null;
}

// text is what a node shows, as textContent does in a real DOM
const text = (node) => node.textContent || node.children.map(text).join('');

// buttons returns every action button under node, a row's main area included
function buttons(node) {
  const out = [];
  for (const c of node.children) {
    if (c.className === 'action' || c.tagName === 'BUTTON') out.push(c);
    out.push(...buttons(c));
  }
  return out;
}

// label is what an action does: a main area holds it in its aria-label, before the name
const label = (b) => b.attributes['aria-label']?.split(': ')[0] ?? b.textContent;

// settle lets pending promise chains in the page run to completion
const settle = () => new Promise((r) => setImmediate(r));

const note = (updatedAt, { content = '', title = 'Sprint', deletedAt = null, temporary = false } = {}) => ({
  title,
  content,
  updatedAt,
  deletedAt,
  ...(temporary ? { temporary } : {}),
});

// FixedDate pins Date.now so days left and dates are stable
class FixedDate extends Date {
  static now() {
    return NOW;
  }
}

// runRecovery evaluates the recovery bundle against a fake
// DOM and browser API. state is read at call time, so tests can mutate it and
// fire an event to simulate a change; reject is read at call time too
// ('storage.local.getKeys' and 'storage.local.get' fail the refresh at its first
// and second read, 'storage.local.get key' the re-read; a function value decides
// by the call's arguments). With
// hold set, getRecentlyClosed stays pending until the test calls one of the
// held resolvers, which take an optional error to reject with instead.
// onStop runs inside runtime.sendMessage before it resolves, like the final
// flush a note tab makes before it replies to a stop. Like Firefox, writes
// fire storage.onChanged, closed tabs fire tabs.onRemoved and tabs.remove
// rejects (closing nothing) when an id is not an open tab.
async function runRecovery({
  storage = {},
  tabs = [],
  closed = [],
  reject = {},
  hold = false,
  confirmed = true,
  onStop = () => {},
} = {}) {
  const state = { storage, tabs, closed };
  const focus = { active: null };
  // hidden state mirrors recovery.html, which the 'recovery.html' test asserts
  const make = (attrs) => element(attrs, focus);
  const els = {
    header: make(),
    search: make(),
    error: make({ hidden: true }),
    settings: make(),
    empty: make({ hidden: true }),
    bar: make({ hidden: true }),
    'new-permanent': make(),
    'new-temporary': make(),
    'bar-count': make(),
    'bar-permanent': make(),
    'bar-temporary': make(),
    'bar-move': make(),
    'bar-restore': make(),
    'bar-delete': make(),
    'bar-clear': make(),
    status: make({ hidden: true }),
    'status-text': make(),
    'status-undo': make({ hidden: true }),
    'empty-bin': make(),
    'bin-details': make({ open: false }),
    'bin-summary': make(),
  };
  els.bar.children = ['bar-count', 'bar-permanent', 'bar-temporary', 'bar-move', 'bar-restore', 'bar-delete', 'bar-clear'].map((id) => els[id]);
  for (const s of ['open', 'recent', 'other', 'bin']) {
    els[s] = make();
    els[`${s}-section`] = make({ hidden: true });
    els[`${s}-count`] = make();
    els[`${s}-all`] = make({ checked: false, indeterminate: false });
  }
  els['bin-details'].children = [els.bin];
  const doc = make();
  const warnings = [];
  const calls = [];
  const held = [];
  const confirms = [];
  const timers = [];
  const counter = { refreshes: 0 };
  // the key lists refreshes passed to get; calls holds only per-note re-reads
  const reads = [];
  const listeners = {};
  const event = (name) => ({
    addListener: (fn) => {
      (listeners[name] = listeners[name] || []).push(fn);
    },
  });
  const events = new Proxy(
    {},
    {
      get: (_, name) => (...args) => {
        for (const fn of listeners[name] || []) fn(...args);
      },
    },
  );
  const queries = [];
  // call records a browser API call and rejects when the test asked it to;
  // args are cloned into this realm so deepStrictEqual compares prototypes
  const call = async (name, ...args) => {
    calls.push(structuredClone([name, ...args]));
    const fails = typeof reject[name] === 'function' ? reject[name](...args) : reject[name];
    if (fails) throw new Error(`${name} rejected`);
  };
  const ctx = vm.createContext({
    URL,
    Date: FixedDate,
    crypto: { randomUUID: () => ID4 },
    console: { warn: (...a) => warnings.push(a) },
    // recorded, never run: the page must not depend on timers
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    clearTimeout: () => {},
    setInterval: (fn, delay) => timers.push({ fn, delay }),
    confirm: (msg) => {
      confirms.push(msg);
      return confirmed;
    },
    document: {
      getElementById: (id) => els[id],
      body: make(),
      addEventListener: (type, fn) => doc.addEventListener(type, fn),
      createElement: (tag) => element({ tagName: tag.toUpperCase() }, focus),
      get activeElement() {
        return focus.active;
      },
    },
    browser: {
      runtime: {
        getURL: (p) => `moz-extension://uuid/${p}`,
        openOptionsPage: () => call('runtime.openOptionsPage'),
        sendMessage: async (msg) => {
          await call('runtime.sendMessage', msg);
          onStop(state, msg);
        },
      },
      storage: {
        local: {
          getKeys: async () => {
            counter.refreshes++;
            if (reject['storage.local.getKeys']) throw new Error('storage.local.getKeys rejected');
            return Object.keys(state.storage);
          },
          get: async (keys) => {
            if (Array.isArray(keys)) {
              reads.push(structuredClone(keys));
              if (reject['storage.local.get']) throw new Error('storage.local.get rejected');
              return structuredClone(Object.fromEntries(keys.filter((k) => Object.hasOwn(state.storage, k)).map((k) => [k, state.storage[k]])));
            }
            calls.push(['storage.local.get', keys]);
            if (reject['storage.local.get key']) throw new Error('storage.local.get rejected');
            return Object.hasOwn(state.storage, keys) ? structuredClone({ [keys]: state.storage[keys] }) : {};
          },
          set: async (items) => {
            await call('storage.local.set', items);
            Object.assign(state.storage, structuredClone(items));
            events['storage.onChanged'](Object.fromEntries(Object.keys(items).map((k) => [k, {}])), 'local');
          },
          remove: async (k) => {
            await call('storage.local.remove', k);
            delete state.storage[k];
            events['storage.onChanged']({ [k]: {} }, 'local');
          },
        },
        onChanged: event('storage.onChanged'),
      },
      tabs: {
        query: async (q) => {
          queries.push(structuredClone(q));
          return structuredClone(state.tabs);
        },
        update: (...a) => call('tabs.update', ...a),
        create: (...a) => call('tabs.create', ...a),
        remove: async (ids) => {
          await call('tabs.remove', ids);
          if (!ids.every((id) => state.tabs.some((t) => t.id === id))) throw new Error('Invalid tab ID');
          state.tabs = state.tabs.filter((t) => !ids.includes(t.id));
          for (const id of ids) events['tabs.onRemoved'](id, {});
        },
        onRemoved: event('tabs.onRemoved'),
        onUpdated: event('tabs.onUpdated'),
        onAttached: event('tabs.onAttached'),
        onReplaced: event('tabs.onReplaced'),
      },
      windows: {
        update: (...a) => call('windows.update', ...a),
      },
      sessions: {
        getRecentlyClosed: () => {
          const snapshot = structuredClone(state.closed);
          if (!hold) return Promise.resolve(snapshot);
          return new Promise((resolve, fail) => held.push((err) => (err ? fail(err) : resolve(snapshot))));
        },
        restore: (...a) => call('sessions.restore', ...a),
        onChanged: event('sessions.onChanged'),
      },
    },
  });
  script.runInContext(ctx);
  await settle();
  const entry = (s, i) => els[s].children[i];
  // tick clicks a row's checkbox, as a click flips it before listeners run
  const tick = (s, i, props = {}) => {
    const box = find(entry(s, i), 'pick');
    box.checked = !box.checked;
    box.dispatch('click', props);
  };
  const ticked = (s) => els[s].children.map((li) => find(li, 'pick').checked);
  const key_ = (props) => doc.dispatch('keydown', { target: els.search, preventDefault() { this.prevented = true; }, ...props });
  const tickAll = (s) => {
    els[`${s}-all`].checked = !els[`${s}-all`].checked;
    els[`${s}-all`].dispatch('click');
  };
  const snippets = (s) => els[s].children.map((li) => text(find(li, 'preview')));
  const labels = (s, i) => buttons(entry(s, i)).map(label);
  const click = async (s, i, text) => {
    const b = buttons(entry(s, i)).find((x) => label(x) === text);
    assert.ok(b, `${s}[${i}] has no ${text} button`);
    b.dispatch('click');
    await settle();
  };
  const button = (s, i, text) => buttons(entry(s, i)).find((x) => label(x) === text);
  return { els, state, warnings, calls, reads, held, confirms, timers, counter, events, listeners, queries, entry, snippets, labels, click, button, focus, tick, ticked, tickAll, press: key_ };
}

test('recovery.html loads its scripts and starts with the harness state', () => {
  const html = read('src', 'recovery', 'recovery.html');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['../theme.js', 'recovery.js']);
  const hidden = ['error', 'empty', 'bar', 'status', 'status-undo'];
  const ids = [
    'header', 'search', 'new-permanent', 'new-temporary', 'settings', ...hidden, 'bar-count', 'bar-permanent', 'bar-temporary', 'bar-move', 'bar-restore', 'bar-delete', 'bar-clear',
    'status-text', 'bin-details', 'bin-summary', 'empty-bin',
  ];
  for (const s of ['open', 'recent', 'other', 'bin']) {
    ids.push(s, `${s}-count`, `${s}-section`, `${s}-all`);
    hidden.push(`${s}-section`);
  }
  for (const id of ids) {
    const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
    assert.ok(tag, id);
    assert.equal(/\shidden[\s>]/.test(tag[0]), hidden.includes(id), id);
  }
  assert.doesNotMatch(html.match(/<details[^>]*>/)[0], /\sopen/);
});

test('recovery', async (t) => {
  await t.test('subscribes exactly one listener per event, queries all tabs and sets no timers', async () => {
    const { listeners, queries, timers } = await runRecovery();
    const names = [
      'storage.onChanged',
      'sessions.onChanged',
      'tabs.onRemoved',
      'tabs.onUpdated',
      'tabs.onAttached',
      'tabs.onReplaced',
    ];
    assert.deepEqual(Object.keys(listeners).sort(), [...names].sort());
    for (const name of names) assert.equal(listeners[name].length, 1, name);
    assert.deepEqual(queries, [{}]);
    assert.deepEqual(timers, []);
  });

  await t.test('renders notes into four sections, ignoring non-note keys', async () => {
    const { els, snippets } = await runRecovery({
      storage: {
        [key(ID1)]: note(1, { content: 'open' }),
        [key(ID2)]: note(2, { content: 'recent' }),
        [key(ID3)]: note(3, { content: 'other' }),
        [key(ID4)]: note(4, { content: 'binned', deletedAt: NOW }),
        settings: { defaultTitle: 'X' },
        notes: { 'https://a.com/': { title: null, content: 'legacy', updatedAt: 1 } },
        'note:bad': note(5, { content: 'bad id' }),
      },
      tabs: [
        { id: 1, windowId: 10, url: url(ID1) },
        { id: 2, windowId: 10, url: 'https://a.com/' },
        { id: 3, windowId: 10, url: 'moz-extension://uuid/recovery/recovery.html' },
      ],
      closed: [{ tab: { sessionId: 's1', url: url(ID2) } }],
    });
    assert.deepEqual(snippets('open'), ['open']);
    assert.deepEqual(snippets('recent'), ['recent']);
    assert.deepEqual(snippets('other'), ['other']);
    assert.deepEqual(snippets('bin'), ['binned']);
    for (const s of ['open', 'recent', 'other', 'bin']) {
      assert.equal(els[`${s}-section`].hidden, false, s);
      assert.equal(els[`${s}-count`].textContent, '(1)', s);
    }
    assert.equal(els.empty.hidden, true);
  });

  await t.test('no notes hides every section and shows one message', async () => {
    const { els } = await runRecovery({ storage: { settings: { defaultTitle: 'X' } } });
    for (const s of ['open', 'recent', 'other', 'bin']) {
      assert.deepEqual(els[s].children, [], s);
      assert.equal(els[`${s}-section`].hidden, true, s);
    }
    assert.equal(els.empty.hidden, false);
    assert.equal(els.empty.textContent, 'No notes yet. Create one with New permanent note or New temporary note.');
  });

  await t.test('a search with no hits says so, as text', async () => {
    const { els } = await runRecovery({ storage: { [key(ID1)]: note(1, { content: 'a' }) } });
    els.search.value = ' <b>zzz ';
    els.search.dispatch('input');
    assert.equal(els.empty.hidden, false);
    assert.equal(els.empty.textContent, 'No notes match "<b>zzz".');
    assert.equal(els['other-section'].hidden, true);
  });

  await t.test('counts follow the search', async () => {
    const { els } = await runRecovery({
      storage: { [key(ID1)]: note(1, { content: 'apple' }), [key(ID2)]: note(2, { content: 'apple pie' }), [key(ID3)]: note(3, { content: 'kiwi' }) },
    });
    assert.equal(els['other-count'].textContent, '(3)');
    els.search.value = 'apple';
    els.search.dispatch('input');
    assert.equal(els['other-count'].textContent, '(2)');
  });

  await t.test('no message beside a failed first load', async () => {
    const { els } = await runRecovery({ reject: { 'storage.local.getKeys': true } });
    els.search.value = 'x';
    els.search.dispatch('input');
    assert.equal(els.error.hidden, false);
    assert.equal(els.empty.hidden, true);
  });

  await t.test('the Bin keeps its state across a refresh', async () => {
    const { els, events } = await runRecovery({ storage: { [key(ID1)]: note(1, { content: 'a', deletedAt: NOW }) } });
    const bin = els['bin-details'];
    assert.equal(bin.open, false);
    events['sessions.onChanged']();
    await settle();
    assert.equal(bin.open, false);
    bin.open = true;
    events['sessions.onChanged']();
    await settle();
    assert.equal(bin.open, true);
  });

  await t.test('a search matching the Bin opens it, and clearing the search restores it', async () => {
    const { els, events } = await runRecovery({
      storage: { [key(ID1)]: note(1, { content: 'apple', deletedAt: NOW }), [key(ID2)]: note(2, { content: 'kiwi' }) },
    });
    const bin = els['bin-details'];
    const search = (q) => {
      els.search.value = q;
      els.search.dispatch('input');
    };
    search('kiwi');
    assert.equal(bin.open, false);
    search('apple');
    assert.equal(bin.open, true);
    search('');
    assert.equal(bin.open, false);

    bin.open = true;
    search('apple');
    search('');
    assert.equal(bin.open, true);

    bin.open = false;
    search('apple');
    bin.open = false;
    search('appl');
    events['sessions.onChanged']();
    await settle();
    assert.equal(bin.open, false, 'stays closed by the user');
  });

  await t.test('a row shows name, plain preview and short date as text; bin shows days left', async () => {
    const long = '**<b>x</b>** ' + 'y'.repeat(300);
    const ts = NOW - 2 * 60 * 60 * 1000;
    const { entry, labels } = await runRecovery({
      storage: {
        [key(ID1)]: note(ts, { content: long, title: '<i>t</i>' }),
        [key(ID2)]: note(1, { content: 'a', deletedAt: NOW - 29.5 * DAY_MS }),
        [key(ID3)]: note(1, { content: 'b', deletedAt: NOW - DAY_MS }),
      },
    });
    const a = entry('other', 0);
    assert.equal(find(a, 'name').textContent, '<i>t</i>');
    assert.equal(find(a, 'preview').textContent, `<b>x</b> ${'y'.repeat(300)}`.slice(0, 200));
    assert.equal(find(a, 'date').textContent, '2h');
    assert.equal(find(a, 'date').title, new Date(ts).toLocaleString());
    assert.equal(find(a, 'days'), null);
    assert.deepEqual(labels('other', 0), ['Open', 'Make temporary', 'Move to Bin']);
    assert.equal(find(entry('bin', 0), 'days').textContent, '29 days left');
    assert.equal(find(entry('bin', 1), 'days').textContent, '1 day left');
    assert.equal(find(entry('bin', 0), 'date'), null);
    assert.deepEqual(labels('bin', 0), ['Restore', 'Delete forever']);
  });

  await t.test('the main area runs the section action and names it; a Bin row has none', async () => {
    const { entry, click, calls, button } = await runRecovery({
      storage: {
        [key(ID1)]: note(1, { content: 'a' }),
        [key(ID2)]: note(2, { content: 'b' }),
        [key(ID3)]: note(3, { content: 'c' }),
        [key(ID4)]: note(4, { content: 'd', deletedAt: NOW }),
      },
      tabs: [{ id: 1, windowId: 10, url: url(ID1) }],
      closed: [{ window: { sessionId: 'w1', tabs: [{ url: url(ID2) }, { url: 'https://a.com/' }] } }],
    });
    const main = (s) => find(entry(s, 0), 'row-main');
    assert.equal(main('open').attributes['aria-label'], 'Go to tab: Sprint');
    assert.equal(main('recent').attributes['aria-label'], 'Restore window (2 tabs): Sprint');
    assert.equal(main('recent').title, 'Restore window (2 tabs): Sprint');
    assert.equal(main('other').attributes['aria-label'], 'Open: Sprint');
    assert.equal(find(main('other'), 'name').textContent, 'Sprint');
    assert.equal(main('bin').tagName, 'DIV');
    assert.equal(button('other', 0, 'Open'), main('other'));
    await click('other', 0, 'Open');
    assert.deepEqual(calls, [['tabs.create', { url: url(ID3) }]]);
  });

  await t.test('names a default-titled note from its text, following the setting', async () => {
    const { state, events, entry, reads, snippets } = await runRecovery({
      storage: {
        [key(ID1)]: note(1, { title: 'Scratch', content: '# Plan\nbody' }),
        settings: { defaultTitle: 'Scratch' },
      },
    });
    assert.equal(find(entry('other', 0), 'name').textContent, 'Plan');
    assert.deepEqual(snippets('other'), ['body']);
    assert.deepEqual(reads, [[key(ID1), 'settings']]);
    state.storage.settings = { defaultTitle: 'Other' };
    events['storage.onChanged']({ settings: {} }, 'local');
    await settle();
    assert.equal(find(entry('other', 0), 'name').textContent, 'Scratch');
  });

  await t.test('a missing default title falls back to the stock one', async () => {
    const { entry } = await runRecovery({ storage: { [key(ID1)]: note(1, { title: 'Notes', content: '# Plan' }) } });
    assert.equal(find(entry('other', 0), 'name').textContent, 'Plan');
  });

  await t.test('selection', async (t2) => {
    const storage = () => ({
      [key(ID1)]: note(4, { content: 'one' }),
      [key(ID2)]: note(3, { content: 'two' }),
      [key(ID3)]: note(2, { content: 'three' }),
      [key(ID4)]: note(1, { content: 'binned', deletedAt: NOW }),
    });

    await t2.test('a pick swaps the header for the bar and survives a refresh', async () => {
      const { els, events, tick, ticked, entry } = await runRecovery({ storage: storage() });
      assert.equal(els.bar.hidden, true);
      tick('other', 1);
      assert.equal(els.bar.hidden, false);
      assert.equal(els.header.hidden, true);
      assert.equal(els['bar-count'].textContent, '1 selected');
      assert.equal(entry('other', 1).className, 'entry selected');
      events['sessions.onChanged']();
      await settle();
      assert.deepEqual(ticked('other'), [false, true, false]);
      assert.equal(find(entry('other', 1), 'pick').attributes['aria-label'], 'Select Sprint');
    });

    await t2.test('unticking the last row and Clear bring the header back', async () => {
      const { els, tick, ticked } = await runRecovery({ storage: storage() });
      tick('other', 0);
      tick('other', 0);
      assert.equal(els.bar.hidden, true);
      assert.equal(els.header.hidden, false);
      tick('other', 0);
      tick('other', 2);
      assert.equal(els['bar-count'].textContent, '2 selected');
      els['bar-clear'].dispatch('click');
      assert.equal(els.bar.hidden, true);
      assert.deepEqual(ticked('other'), [false, false, false]);
    });

    await t2.test('a pick in the other scope replaces the selection', async () => {
      const { els, tick, ticked } = await runRecovery({ storage: storage() });
      tick('other', 0);
      tick('other', 1);
      tick('bin', 0);
      assert.deepEqual(ticked('other'), [false, false, false]);
      assert.deepEqual(ticked('bin'), [true]);
      assert.equal(els['bar-count'].textContent, '1 selected');
      tick('other', 2);
      assert.deepEqual(ticked('bin'), [false]);
    });

    await t2.test('a range spans live sections and adds to the selection', async () => {
      const { tick, ticked } = await runRecovery({
        storage: storage(),
        tabs: [{ id: 1, windowId: 10, url: url(ID1) }],
      });
      tick('open', 0);
      tick('other', 1, { shiftKey: true });
      assert.deepEqual(ticked('open'), [true]);
      assert.deepEqual(ticked('other'), [true, true]);
    });

    await t2.test('a range works backward', async () => {
      const { tick, ticked } = await runRecovery({ storage: storage() });
      tick('other', 2);
      tick('other', 0, { shiftKey: true });
      assert.deepEqual(ticked('other'), [true, true, true]);
    });

    await t2.test('a range stays within rows the search shows', async () => {
      const { els, tick, ticked } = await runRecovery({
        storage: { ...storage(), [key(ID1)]: note(4, { content: 'apple' }), [key(ID2)]: note(3, { content: 'kiwi' }), [key(ID3)]: note(2, { content: 'apple pie' }) },
      });
      els.search.value = 'apple';
      els.search.dispatch('input');
      tick('other', 0);
      tick('other', 1, { shiftKey: true });
      assert.deepEqual(ticked('other'), [true, true]);
      assert.equal(els['bar-count'].textContent, '2 selected');
    });

    await t2.test('select all covers shown rows and shows a partial state', async () => {
      const { els, tick, tickAll, ticked } = await runRecovery({ storage: storage() });
      tick('other', 0);
      assert.equal(els['other-all'].indeterminate, true);
      assert.equal(els['other-all'].checked, false);
      tickAll('other');
      assert.deepEqual(ticked('other'), [true, true, true]);
      assert.equal(els['other-all'].checked, true);
      assert.equal(els['other-all'].indeterminate, false);
      tickAll('other');
      assert.equal(els.bar.hidden, true);
    });

    await t2.test('a note going away leaves the selection', async () => {
      const { els, state, events, tick } = await runRecovery({ storage: storage() });
      tick('other', 0);
      tick('other', 1);
      delete state.storage[key(ID1)];
      events['storage.onChanged']({ [key(ID1)]: {} }, 'local');
      await settle();
      assert.equal(els['bar-count'].textContent, '1 selected');
    });

    await t2.test('a Bin note restored elsewhere leaves a Bin selection', async () => {
      const { els, state, events, tick } = await runRecovery({ storage: storage() });
      tick('bin', 0);
      state.storage[key(ID4)] = note(1, { content: 'binned' });
      events['storage.onChanged']({ [key(ID4)]: {} }, 'local');
      await settle();
      assert.equal(els.bar.hidden, true);
      assert.equal(find(els.other.children.at(-1), 'pick').checked, false);
    });

    await t2.test('a live note binned elsewhere leaves a live selection', async () => {
      const { els, state, events, tick, ticked } = await runRecovery({ storage: storage() });
      tick('other', 0);
      state.storage[key(ID1)] = note(4, { content: 'one', deletedAt: NOW });
      events['storage.onChanged']({ [key(ID1)]: {} }, 'local');
      await settle();
      assert.equal(els.bar.hidden, true);
      assert.deepEqual(ticked('bin'), [false, false]);
    });

    await t2.test('a note moving between live sections stays selected', async () => {
      const { state, events, tick, ticked } = await runRecovery({ storage: storage() });
      tick('other', 0);
      state.tabs = [{ id: 1, windowId: 10, url: url(ID1) }];
      events['sessions.onChanged']();
      await settle();
      assert.deepEqual(ticked('open'), [true]);
    });

    await t2.test('closing the Bin clears a Bin selection and keeps focus on the page', async () => {
      const { els, tick, focus } = await runRecovery({ storage: storage() });
      els['bin-details'].open = true;
      tick('bin', 0);
      assert.equal(focus.active.className, 'pick');
      els['bin-details'].open = false;
      els['bin-details'].dispatch('toggle');
      assert.equal(els.bar.hidden, true);
      assert.equal(focus.active, els['bin-summary']);
    });

    await t2.test('opening the Bin and a live selection ignore the toggle', async () => {
      const { els, tick } = await runRecovery({ storage: storage() });
      tick('other', 0);
      els['bin-details'].open = false;
      els['bin-details'].dispatch('toggle');
      assert.equal(els.bar.hidden, false);
    });

    await t2.test('a clicked checkbox takes focus from the search field it hides', async () => {
      const { els, tick, focus } = await runRecovery({ storage: storage() });
      els.search.focus();
      tick('other', 1);
      assert.equal(focus.active.dataset.action, `${ID2} pick`);
      assert.equal(focus.active.checked, true);
    });

    await t2.test('Clear with focus in the bar moves focus to search', async () => {
      const { els, tick, focus } = await runRecovery({ storage: storage() });
      tick('other', 0);
      els['bar-clear'].focus();
      els['bar-clear'].dispatch('click');
      assert.equal(focus.active, els.search);
    });

    await t2.test('focus on a row survives Clear and a refresh leaves it alone', async () => {
      const { els, tick, focus, events } = await runRecovery({ storage: storage() });
      tick('other', 0);
      els['bar-clear'].dispatch('click');
      assert.equal(focus.active.dataset.action, `${ID1} pick`);
      focus.active = null;
      events['sessions.onChanged']();
      await settle();
      assert.equal(focus.active, null);
    });
  });

  await t.test('search filters all sections and survives a refresh', async () => {
    const { els, state, events, snippets } = await runRecovery({
      storage: {
        [key(ID1)]: note(1, { content: 'apple' }),
        [key(ID2)]: note(2, { content: 'banana' }),
        [key(ID3)]: note(3, { content: 'cherry', title: 'Apple list' }),
        [key(ID4)]: note(4, { content: 'apple core', deletedAt: NOW }),
      },
      tabs: [{ id: 1, windowId: 1, url: url(ID1) }],
      closed: [{ tab: { sessionId: 's1', url: url(ID2) } }],
    });
    els.search.value = 'APPLE';
    els.search.dispatch('input');
    assert.deepEqual(snippets('open'), ['apple']);
    assert.deepEqual(snippets('recent'), []);
    assert.equal(els['recent-section'].hidden, true);
    assert.deepEqual(snippets('other'), ['cherry']);
    assert.deepEqual(snippets('bin'), ['apple core']);

    state.storage[key(ID2)].content = 'apple pie';
    events['storage.onChanged']({ [key(ID2)]: {} }, 'local');
    await settle();
    assert.deepEqual(snippets('recent'), ['apple pie']);
    assert.equal(els['recent-section'].hidden, false);

    els.search.value = '  ';
    els.search.dispatch('input');
    assert.deepEqual(snippets('other'), ['cherry']);
    assert.deepEqual(snippets('open'), ['apple']);
  });

  await t.test('refresh on subscribed events', async (t) => {
    const cases = [
      { name: 'storage.onChanged with a note key', args: [{ [key(ID1)]: {} }, 'local'], refreshes: true },
      { name: 'storage.onChanged with settings only', args: [{ settings: {} }, 'local'], refreshes: true },
      { name: 'storage.onChanged with legacy notes only', args: [{ notes: {} }, 'local'], refreshes: false },
      { name: 'storage.onChanged with an image key', args: [{ [`image:${ID1}`]: {} }, 'local'], refreshes: false },
      { name: 'storage.onChanged with imageOrphans', args: [{ imageOrphans: {} }, 'local'], refreshes: false },
      { name: 'sessions.onChanged', args: [], refreshes: true },
      { name: 'tabs.onRemoved', args: [1, {}], refreshes: true },
      { name: 'tabs.onAttached', args: [1, { newWindowId: 2, newPosition: 0 }], refreshes: true },
      { name: 'tabs.onReplaced', args: [2, 1], refreshes: true },
      { name: 'tabs.onUpdated with url', args: [1, { url: 'https://n.com/' }], refreshes: true },
      { name: 'tabs.onUpdated without url', args: [1, { status: 'complete' }], refreshes: false },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { state, events, counter, snippets } = await runRecovery();
        assert.equal(counter.refreshes, 1);
        state.storage[key(ID1)] = note(1, { content: 'n' });
        events[c.name.split(' ')[0]](...c.args);
        await settle();
        assert.equal(counter.refreshes, c.refreshes ? 2 : 1);
        assert.deepEqual(snippets('other'), c.refreshes ? ['n'] : []);
      });
    }
  });

  await t.test('stale refresh does not overwrite a newer one', async () => {
    const { state, events, held, snippets } = await runRecovery({ hold: true });
    held.shift()();
    await settle();
    events['sessions.onChanged']();
    state.storage[key(ID1)] = note(1, { content: 'n' });
    events['sessions.onChanged']();
    await settle();
    const [older, newer] = held;
    newer();
    await settle();
    older();
    await settle();
    assert.deepEqual(snippets('other'), ['n']);
  });

  await t.test('older refresh still applies when the newer one fails', async () => {
    const { els, state, events, held, snippets, warnings } = await runRecovery({ hold: true });
    held.shift()();
    await settle();
    state.storage[key(ID1)] = note(1, { content: 'n' });
    events['sessions.onChanged']();
    events['sessions.onChanged']();
    await settle();
    const [older, newer] = held;
    newer(new Error('gone'));
    await settle();
    assert.equal(warnings.length, 1);
    assert.equal(els.error.hidden, false);
    older();
    await settle();
    assert.deepEqual(snippets('other'), ['n']);
    assert.equal(els.error.hidden, true);
  });

  await t.test('Settings opens the options page', async () => {
    const { els, calls } = await runRecovery();
    els.settings.dispatch('click');
    await settle();
    assert.deepEqual(calls, [['runtime.openOptionsPage']]);
  });

  await t.test('Go to tab focuses the first tab and its window, then refreshes', async () => {
    const { click, calls, counter, labels } = await runRecovery({
      storage: { [key(ID1)]: note(1) },
      tabs: [
        { id: 7, windowId: 70, url: url(ID1) },
        { id: 8, windowId: 80, url: url(ID1) },
      ],
    });
    assert.deepEqual(labels('open', 0), ['Go to tab', 'Make temporary', 'Move to Bin']);
    await click('open', 0, 'Go to tab');
    assert.deepEqual(calls, [
      ['tabs.update', 7, { active: true }],
      ['windows.update', 70, { focused: true }],
    ]);
    assert.equal(counter.refreshes, 2);
  });

  await t.test('recent entries restore with tab or window label', async () => {
    const { click, calls, counter, labels } = await runRecovery({
      storage: { [key(ID1)]: note(2), [key(ID2)]: note(1) },
      closed: [
        { tab: { sessionId: 's1', url: url(ID1) } },
        { window: { sessionId: 'w1', tabs: [{ url: url(ID2) }, { url: 'about:blank' }, { url: 'https://x/' }] } },
      ],
    });
    assert.deepEqual(labels('recent', 0), ['Restore tab', 'Make temporary', 'Move to Bin']);
    assert.deepEqual(labels('recent', 1), ['Restore window (3 tabs)', 'Make temporary', 'Move to Bin']);
    await click('recent', 0, 'Restore tab');
    await click('recent', 1, 'Restore window (3 tabs)');
    assert.deepEqual(calls, [
      ['sessions.restore', 's1'],
      ['sessions.restore', 'w1'],
    ]);
    assert.equal(counter.refreshes, 3);
  });

  await t.test('Open on other notes creates a tab with the note URL', async () => {
    const { click, calls } = await runRecovery({ storage: { [key(ID1)]: note(1) } });
    await click('other', 0, 'Open');
    assert.deepEqual(calls, [['tabs.create', { url: url(ID1) }]]);
  });

  // whether a closing tab's own pagehide write lands before tabs.remove
  // resolves is not guaranteed in Firefox, so each tab is stopped first and
  // its last write lands before it replies
  await t.test('Delete stops every tab, closes them, then trashes the re-read note', async () => {
    const { click, calls, state, snippets } = await runRecovery({
      storage: { [key(ID1)]: note(1, { content: 'old' }) },
      tabs: [
        { id: 1, windowId: 1, url: url(ID1) },
        { id: 2, windowId: 2, url: url(ID1) },
        { id: 3, windowId: 1, url: 'https://a.com/' },
      ],
      onStop: (s, msg) => {
        if (msg.tabId === 2) s.storage[key(ID1)] = note(2, { content: 'flushed' });
      },
    });
    await click('open', 0, 'Move to Bin');
    assert.deepEqual(calls, [
      ['runtime.sendMessage', { type: 'stop', id: ID1, tabId: 1 }],
      ['runtime.sendMessage', { type: 'stop', id: ID1, tabId: 2 }],
      ['tabs.remove', [1, 2]],
      ['storage.local.get', key(ID1)],
      ['storage.local.set', { [key(ID1)]: note(2, { content: 'flushed', deletedAt: NOW }) }],
    ]);
    assert.deepEqual(state.tabs.map((x) => x.id), [3]);
    assert.deepEqual(snippets('open'), []);
    assert.deepEqual(snippets('bin'), ['flushed']);
  });

  await t.test('Delete goes on when a tab does not reply to the stop', async () => {
    const { click, calls, warnings, state } = await runRecovery({
      storage: { [key(ID1)]: note(1) },
      tabs: [{ id: 1, windowId: 1, url: url(ID1) }],
      reject: { 'runtime.sendMessage': true },
    });
    await click('open', 0, 'Move to Bin');
    assert.deepEqual(calls.map((c) => c[0]), ['runtime.sendMessage', 'tabs.remove', 'storage.local.get', 'storage.local.set']);
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: stop note tab:']);
    assert.equal(state.storage[key(ID1)].deletedAt, NOW);
  });

  await t.test('Delete without open tabs does not call tabs.remove', async (t) => {
    for (const section of ['recent', 'other']) {
      await t.test(section, async () => {
        const { click, calls } = await runRecovery({
          storage: { [key(ID1)]: note(1) },
          closed: section === 'recent' ? [{ tab: { sessionId: 's1', url: url(ID1) } }] : [],
        });
        await click(section, 0, 'Move to Bin');
        assert.deepEqual(calls, [
          ['storage.local.get', key(ID1)],
          ['storage.local.set', { [key(ID1)]: note(1, { deletedAt: NOW }) }],
        ]);
      });
    }
  });

  await t.test('Delete of a note removed meanwhile writes nothing', async () => {
    const { click, calls, state } = await runRecovery({ storage: { [key(ID1)]: note(1) } });
    delete state.storage[key(ID1)];
    await click('other', 0, 'Move to Bin');
    assert.deepEqual(calls, [['storage.local.get', key(ID1)]]);
    assert.deepEqual(state.storage, {});
  });

  // the stopped tabs write nothing more, so a failed close cannot save over
  // the trash
  await t.test('Delete still trashes when closing the tabs fails', async (t) => {
    const cases = [
      { name: 'rejected', reject: { 'tabs.remove': true }, tabs: [{ id: 1, windowId: 1, url: url(ID1) }] },
      // the tab was closed by the user after the last refresh
      { name: 'tab already gone', reject: {}, tabs: [] },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { click, calls, warnings, state } = await runRecovery({
          storage: { [key(ID1)]: note(1) },
          tabs: [{ id: 1, windowId: 1, url: url(ID1) }],
          reject: c.reject,
        });
        state.tabs = c.tabs;
        await click('open', 0, 'Move to Bin');
        assert.deepEqual(calls.slice(0, 2), [
          ['runtime.sendMessage', { type: 'stop', id: ID1, tabId: 1 }],
          ['tabs.remove', [1]],
        ]);
        assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: close note tabs:']);
        assert.equal(state.storage[key(ID1)].deletedAt, NOW);
      });
    }
  });

  await t.test('Restore from bin writes the re-read note with deletedAt cleared', async () => {
    const { click, calls, state, snippets } = await runRecovery({
      storage: { [key(ID1)]: note(1, { content: 'old', deletedAt: NOW - DAY_MS }) },
    });
    state.storage[key(ID1)] = note(2, { content: 'edited in bin', deletedAt: NOW - DAY_MS });
    await click('bin', 0, 'Restore');
    assert.deepEqual(calls, [
      ['storage.local.get', key(ID1)],
      ['storage.local.set', { [key(ID1)]: note(2, { content: 'edited in bin' }) }],
    ]);
    assert.deepEqual(snippets('bin'), []);
    assert.deepEqual(snippets('other'), ['edited in bin']);
  });

  await t.test('Restore from bin of a blank note removes it', async () => {
    const { click, calls, state, snippets } = await runRecovery({
      storage: { [key(ID1)]: note(1, { content: ' \n', deletedAt: NOW }) },
    });
    await click('bin', 0, 'Restore');
    assert.deepEqual(calls, [
      ['storage.local.get', key(ID1)],
      ['storage.local.remove', key(ID1)],
    ]);
    assert.deepEqual(state.storage, {});
    assert.deepEqual(snippets('other'), []);
  });

  await t.test('Restore of a note purged meanwhile writes nothing', async () => {
    const { click, calls, state } = await runRecovery({
      storage: { [key(ID1)]: note(1, { deletedAt: NOW }) },
    });
    delete state.storage[key(ID1)];
    await click('bin', 0, 'Restore');
    assert.deepEqual(calls, [['storage.local.get', key(ID1)]]);
    assert.deepEqual(state.storage, {});
  });

  await t.test('Delete forever confirms, closes the open tabs, then removes', async () => {
    const { click, calls, confirms, snippets } = await runRecovery({
      storage: { [key(ID1)]: note(1, { title: 'Jira', deletedAt: NOW }) },
      tabs: [
        { id: 4, windowId: 1, url: url(ID1) },
        { id: 5, windowId: 1, url: url(ID1) },
      ],
    });
    await click('bin', 0, 'Delete forever');
    assert.deepEqual(confirms, ['Delete "Jira" forever?']);
    assert.deepEqual(calls, [
      ['runtime.sendMessage', { type: 'stop', id: ID1, tabId: 4 }],
      ['runtime.sendMessage', { type: 'stop', id: ID1, tabId: 5 }],
      ['tabs.remove', [4, 5]],
      ['storage.local.get', key(ID1)],
      ['storage.local.remove', key(ID1)],
    ]);
    assert.deepEqual(snippets('bin'), []);
  });

  await t.test('Delete forever without tabs skips tabs.remove', async () => {
    const { click, calls } = await runRecovery({ storage: { [key(ID1)]: note(1, { deletedAt: NOW }) } });
    await click('bin', 0, 'Delete forever');
    assert.deepEqual(calls, [['storage.local.get', key(ID1)], ['storage.local.remove', key(ID1)]]);
  });

  await t.test('Delete forever declined writes nothing and closes nothing', async () => {
    const { click, calls, confirms, state } = await runRecovery({
      storage: { [key(ID1)]: note(1, { deletedAt: NOW }) },
      tabs: [{ id: 4, windowId: 1, url: url(ID1) }],
      confirmed: false,
    });
    await click('bin', 0, 'Delete forever');
    assert.equal(confirms.length, 1);
    assert.deepEqual(calls, []);
    assert.ok(state.storage[key(ID1)]);
  });

  await t.test('Delete forever still removes when closing the tabs fails', async () => {
    const { click, calls, state, warnings } = await runRecovery({
      storage: { [key(ID1)]: note(1, { deletedAt: NOW }) },
      tabs: [{ id: 4, windowId: 1, url: url(ID1) }],
      reject: { 'tabs.remove': true },
    });
    await click('bin', 0, 'Delete forever');
    assert.deepEqual(calls, [
      ['runtime.sendMessage', { type: 'stop', id: ID1, tabId: 4 }],
      ['tabs.remove', [4]],
      ['storage.local.get', key(ID1)],
      ['storage.local.remove', key(ID1)],
    ]);
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: close note tabs:']);
    assert.deepEqual(state.storage, {});
  });

  await t.test('a refresh keeps keyboard focus on the same action', async () => {
    const { button, focus, events, state } = await runRecovery({
      storage: { [key(ID1)]: note(2), [key(ID2)]: note(1) },
    });
    button('other', 1, 'Move to Bin').focus();
    state.storage[key(ID1)] = note(2, { content: 'edited' });
    events['storage.onChanged']({ [key(ID1)]: {} }, 'local');
    await settle();
    assert.equal(focus.active, button('other', 1, 'Move to Bin'));
    assert.equal(focus.active.dataset.action, `${ID2} trash`);
  });

  await t.test('focus stays on Restore window when its tab count changes', async () => {
    const win = (n) => ({
      window: { sessionId: 'w1', tabs: [{ url: url(ID1) }, ...Array.from({ length: n - 1 }, () => ({ url: 'about:blank' }))] },
    });
    const { button, focus, events, state } = await runRecovery({
      storage: { [key(ID1)]: note(1) },
      closed: [win(2)],
    });
    button('recent', 0, 'Restore window (2 tabs)').focus();
    state.closed = [win(3)];
    events['sessions.onChanged']();
    await settle();
    assert.equal(focus.active, button('recent', 0, 'Restore window (3 tabs)'));
    assert.equal(focus.active.dataset.action, `${ID1} restore-session`);
  });

  await t.test('rejected actions are logged and still refresh', async (t) => {
    const storage = () => ({
      [key(ID1)]: note(4),
      [key(ID2)]: note(3),
      [key(ID3)]: note(2),
      [key(ID4)]: note(1, { content: 'binned', deletedAt: NOW }),
    });
    const opts = () => ({
      storage: storage(),
      tabs: [{ id: 1, windowId: 1, url: url(ID1) }],
      closed: [{ tab: { sessionId: 's1', url: url(ID2) } }],
      reject: {
        'tabs.update': true,
        'windows.update': true,
        'sessions.restore': true,
        'tabs.create': true,
        'storage.local.set': true,
        'storage.local.remove': true,
        'runtime.openOptionsPage': true,
      },
    });
    const cases = [
      { section: 'open', label: 'Go to tab', warns: ['tabnotes: focus tab:', 'tabnotes: focus window:'] },
      { section: 'open', label: 'Move to Bin', warns: ['tabnotes: trash note:'] },
      { section: 'recent', label: 'Restore tab', warns: ['tabnotes: restore session:'] },
      { section: 'other', label: 'Open', warns: ['tabnotes: open note:'] },
      { section: 'bin', label: 'Restore', warns: ['tabnotes: restore note:'] },
      { section: 'bin', label: 'Delete forever', warns: ['tabnotes: delete note:'] },
    ];
    for (const c of cases) {
      await t.test(`${c.section} ${c.label}`, async () => {
        const { click, warnings, counter } = await runRecovery(opts());
        await click(c.section, 0, c.label);
        assert.deepEqual(warnings.map((w) => w[0]), c.warns);
        // the action's own refresh, on top of any from closed tabs
        assert.ok(counter.refreshes >= 2, String(counter.refreshes));
      });
    }
    await t.test('Settings', async () => {
      const { els, warnings } = await runRecovery(opts());
      els.settings.dispatch('click');
      await settle();
      assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: open settings:']);
    });
  });

  await t.test('keyboard', async (t2) => {
    const storage = { [key(ID1)]: note(2, { content: 'one' }), [key(ID2)]: note(1, { content: 'two' }) };
    const box = { tagName: 'INPUT', type: 'checkbox' };
    const rows = { tagName: 'BUTTON' };

    await t2.test('/ focuses search and is not typed', async () => {
      const { els, press, focus } = await runRecovery({ storage });
      const e = press({ key: '/', target: rows });
      assert.equal(focus.active, els.search);
      assert.equal(e.prevented, true);
    });

    await t2.test('/ works from a checkbox', async () => {
      const { els, press, focus } = await runRecovery({ storage });
      press({ key: '/', target: box });
      assert.equal(focus.active, els.search);
    });

    await t2.test('/ is typed in a text field, and left alone with a modifier', async () => {
      const { press, focus } = await runRecovery({ storage });
      for (const props of [
        { target: { tagName: 'INPUT', type: 'search' } },
        { target: { tagName: 'TEXTAREA' } },
        { target: rows, ctrlKey: true },
        { target: rows, metaKey: true },
        { target: rows, altKey: true },
      ]) {
        const e = press({ key: '/', ...props });
        assert.equal(e.prevented, undefined);
        assert.equal(focus.active, null);
      }
    });

    await t2.test('/ does nothing while a selection hides search', async () => {
      const { press, tick, focus } = await runRecovery({ storage });
      tick('other', 0);
      const before = focus.active;
      const e = press({ key: '/', target: rows });
      assert.equal(e.prevented, undefined);
      assert.equal(focus.active, before);
    });

    await t2.test('Esc clears a selection, and does nothing without one', async () => {
      const { els, press, tick, focus } = await runRecovery({ storage });
      press({ key: 'Escape' });
      assert.equal(focus.active, null);
      tick('other', 0);
      press({ key: 'Escape', target: box });
      assert.equal(els.bar.hidden, true);
    });
  });

  for (const [kind, param] of [['permanent', 0], ['temporary', 1]]) {
    await t.test(`New ${kind} note opens a tab on a new id with its kind in the URL`, async () => {
      const { els, calls } = await runRecovery();
      els[`new-${kind}`].dispatch('click');
      await settle();
      assert.deepEqual(calls, [['tabs.create', { url: `${url(ID4)}&temporary=${param}` }]]);
    });

    await t.test(`a failed New ${kind} note is logged`, async () => {
      const { els, warnings } = await runRecovery({ reject: { 'tabs.create': true } });
      els[`new-${kind}`].dispatch('click');
      await settle();
      assert.deepEqual(warnings.map((w) => w[0]), [`tabnotes: new ${kind} note:`]);
    });
  }

  await t.test('search hits', async (t2) => {
    const marks = (node) => [...(node.tagName === 'MARK' ? [node] : []), ...node.children.flatMap(marks)];

    await t2.test('marks hits in name and preview, keeping note HTML as text', async () => {
      const { els, entry } = await runRecovery({
        storage: { [key(ID1)]: note(1, { title: 'an <b>apple</b>', content: 'apple <i>pie</i>' }) },
      });
      els.search.value = 'apple';
      els.search.dispatch('input');
      assert.deepEqual(marks(entry('other', 0)).map((m) => m.textContent), ['apple', 'apple']);
      assert.equal(text(find(entry('other', 0), 'name')), 'an <b>apple</b>');
      assert.equal(text(find(entry('other', 0), 'preview')), 'apple <i>pie</i>');
    });

    await t2.test('finds a hit past the first 200 characters', async () => {
      const { els, entry } = await runRecovery({
        storage: { [key(ID1)]: note(1, { content: `${'x '.repeat(200)}needle` }) },
      });
      els.search.value = 'needle';
      els.search.dispatch('input');
      assert.deepEqual(marks(entry('other', 0)).map((m) => m.textContent), ['needle']);
    });

    await t2.test('a note matched only in its markup lists without a mark', async () => {
      const { els, entry, snippets } = await runRecovery({ storage: { [key(ID1)]: note(1, { content: 'a [b](http://needle)' }) } });
      els.search.value = 'needle';
      els.search.dispatch('input');
      assert.deepEqual(snippets('other'), ['a b']);
      assert.deepEqual(marks(entry('other', 0)), []);
    });

    await t2.test('the button label stays plain', async () => {
      const { els, entry } = await runRecovery({ storage: { [key(ID1)]: note(1, { title: 'apple', content: 'x' }) } });
      els.search.value = 'apple';
      els.search.dispatch('input');
      assert.equal(find(entry('other', 0), 'row-main').attributes['aria-label'], 'Open: apple');
    });

    await t2.test('a search for the default title does not list every note', async () => {
      const { els } = await runRecovery({ storage: { [key(ID1)]: note(1, { title: 'Notes', content: 'body' }) } });
      els.search.value = 'notes';
      els.search.dispatch('input');
      assert.equal(els.other.children.length, 0);
    });
  });

  await t.test('bulk actions', async (t2) => {
    const live = () => ({
      [key(ID1)]: note(3, { content: 'one' }),
      [key(ID2)]: note(2, { content: 'two' }),
      [key(ID3)]: note(1, { content: 'three' }),
    });
    const binned = () => ({
      [key(ID1)]: note(3, { content: 'one', deletedAt: NOW }),
      [key(ID2)]: note(2, { content: 'two', deletedAt: NOW - 1 }),
      [key(ID3)]: note(1, { content: 'three', deletedAt: NOW - 2 }),
    });
    const press = async (els, id) => {
      els[id].dispatch('click');
      await settle();
    };

    await t2.test('Move to Bin stops and closes each note\'s tabs, then re-reads and writes', async () => {
      const { els, calls, state, tick } = await runRecovery({
        storage: live(),
        tabs: [{ id: 4, windowId: 1, url: url(ID1) }, { id: 5, windowId: 1, url: url(ID2) }],
      });
      tick('open', 0);
      tick('open', 1);
      await press(els, 'bar-move');
      for (const [id, tab] of [[ID1, 4], [ID2, 5]]) {
        const names = calls.filter((c) => JSON.stringify(c).includes(id) || (c[0] === 'tabs.remove' && c[1][0] === tab));
        assert.deepEqual(names.map((c) => c[0]), ['runtime.sendMessage', 'tabs.remove', 'storage.local.get', 'storage.local.set']);
        assert.equal(state.storage[key(id)].deletedAt, NOW);
      }
      assert.equal(state.storage[key(ID3)].deletedAt, null);
      assert.equal(els.bar.hidden, true);
      assert.equal(els['status-text'].textContent, 'Moved 2 notes to the Bin');
      assert.equal(els.status.hidden, false);
      assert.equal(els['status-undo'].hidden, false);
    });

    await t2.test('the tab\'s final flush lands in the moved note', async () => {
      const { els, state, tick } = await runRecovery({
        storage: live(),
        tabs: [{ id: 4, windowId: 1, url: url(ID1) }],
        onStop: (s) => {
          s.storage[key(ID1)] = note(9, { content: 'flushed' });
        },
      });
      tick('open', 0);
      await press(els, 'bar-move');
      assert.equal(state.storage[key(ID1)].content, 'flushed');
    });

    await t2.test('a second activation during a run is ignored', async () => {
      const { button, calls } = await runRecovery({ storage: live() });
      const b = button('other', 0, 'Move to Bin');
      b.dispatch('click');
      b.dispatch('click');
      await settle();
      assert.equal(calls.filter((c) => c[0] === 'storage.local.set').length, 1);
    });

    await t2.test('a selection cleared by the run cannot be acted on twice', async () => {
      const { els, calls, tick } = await runRecovery({ storage: live() });
      tick('other', 0);
      els['bar-move'].dispatch('click');
      els['bar-move'].dispatch('click');
      await settle();
      assert.equal(calls.filter((c) => c[0] === 'storage.local.set').length, 1);
    });

    await t2.test('a render during a run does not change what it acts on', async () => {
      const { els, state, events, tick } = await runRecovery({
        storage: live(),
        tabs: [{ id: 4, windowId: 1, url: url(ID1) }, { id: 5, windowId: 1, url: url(ID2) }],
        onStop: () => events['sessions.onChanged'](),
      });
      tick('open', 0);
      tick('open', 1);
      await press(els, 'bar-move');
      assert.equal(state.storage[key(ID1)].deletedAt, NOW);
      assert.equal(state.storage[key(ID2)].deletedAt, NOW);
    });

    await t2.test('a note binned elsewhere keeps its countdown', async () => {
      const { els, state, tick, calls } = await runRecovery({
        storage: live(),
        tabs: [{ id: 4, windowId: 1, url: url(ID1) }],
        onStop: (s) => {
          s.storage[key(ID1)] = note(3, { content: 'one', deletedAt: NOW - DAY_MS });
        },
      });
      tick('open', 0);
      await press(els, 'bar-move');
      assert.equal(state.storage[key(ID1)].deletedAt, NOW - DAY_MS);
      assert.equal(calls.some((c) => c[0] === 'storage.local.set'), false);
      assert.equal(els.status.hidden, true);
    });

    await t2.test('a note gone before the write is not a failure', async () => {
      const { els, state, tick } = await runRecovery({ storage: live() });
      tick('other', 0);
      tick('other', 1);
      delete state.storage[key(ID1)];
      await press(els, 'bar-move');
      assert.equal(els['status-text'].textContent, 'Moved 1 note to the Bin');
    });

    await t2.test('a failed write is reported and left out of Undo', async () => {
      const { els, state, tick } = await runRecovery({
        storage: live(),
        reject: { 'storage.local.set': (items) => key(ID1) in items },
      });
      tick('other', 0);
      tick('other', 1);
      await press(els, 'bar-move');
      assert.equal(els['status-text'].textContent, 'Moved 1 of 2 notes to the Bin. 1 could not be moved.');
      assert.equal(state.storage[key(ID1)].deletedAt, null);
      assert.equal(els['status-undo'].hidden, false);
      await press(els, 'status-undo');
      assert.equal(els['status-text'].textContent, 'Restored 1 note');
      assert.equal(state.storage[key(ID2)].deletedAt, null);
    });

    await t2.test('a failed re-read counts as a failure', async () => {
      const { els, tick } = await runRecovery({ storage: live(), reject: { 'storage.local.get key': true } });
      tick('other', 0);
      await press(els, 'bar-move');
      assert.equal(els['status-text'].textContent, 'Moved 0 of 1 note to the Bin. 1 could not be moved.');
    });

    await t2.test('Undo restores the moved notes, keeps updatedAt, and takes focus', async () => {
      const { els, state, tick, focus } = await runRecovery({ storage: live() });
      tick('other', 0);
      tick('other', 1);
      await press(els, 'bar-move');
      assert.equal(focus.active, els['status-undo']);
      await press(els, 'status-undo');
      assert.deepEqual(state.storage[key(ID1)], note(3, { content: 'one' }));
      assert.deepEqual(state.storage[key(ID2)], note(2, { content: 'two' }));
      assert.equal(els['status-text'].textContent, 'Restored 2 notes');
      assert.equal(els['status-undo'].hidden, true);
    });

    await t2.test('a row move offers Undo too', async () => {
      const { els, state, click } = await runRecovery({ storage: live() });
      await click('other', 0, 'Move to Bin');
      assert.equal(els['status-text'].textContent, 'Moved 1 note to the Bin');
      await press(els, 'status-undo');
      assert.equal(state.storage[key(ID1)].deletedAt, null);
    });

    await t2.test('a partial Undo reports and keeps the failed notes for a retry', async () => {
      const reject = {};
      const { els, state, tick } = await runRecovery({ storage: live(), reject });
      tick('other', 0);
      tick('other', 1);
      await press(els, 'bar-move');
      reject['storage.local.set'] = (items) => key(ID1) in items;
      await press(els, 'status-undo');
      assert.equal(els['status-text'].textContent, 'Restored 1 of 2 notes. 1 could not be restored.');
      assert.equal(els['status-undo'].hidden, false);
      assert.equal(state.storage[key(ID2)].deletedAt, null);
      assert.equal(state.storage[key(ID1)].deletedAt, NOW);
      delete reject['storage.local.set'];
      await press(els, 'status-undo');
      assert.equal(els['status-text'].textContent, 'Restored 1 note');
      assert.equal(state.storage[key(ID1)].deletedAt, null);
      assert.equal(els['status-undo'].hidden, true);
    });

    await t2.test('a note purged before Undo is skipped', async () => {
      const { els, state, tick } = await runRecovery({ storage: live() });
      tick('other', 0);
      tick('other', 1);
      await press(els, 'bar-move');
      delete state.storage[key(ID1)];
      await press(els, 'status-undo');
      assert.equal(els['status-text'].textContent, 'Restored 1 note');
    });

    await t2.test('the next action replaces Undo', async () => {
      const { els, click, state } = await runRecovery({ storage: live() });
      await click('other', 0, 'Move to Bin');
      els['bin-details'].open = true;
      await click('bin', 0, 'Restore');
      assert.equal(els['status-undo'].hidden, true);
      assert.equal(els['status-text'].textContent, 'Restored 1 note');
      assert.equal(state.storage[key(ID1)].deletedAt, null);
    });

    await t2.test('the bar offers what the scope allows', async () => {
      const { els, tick } = await runRecovery({ storage: { ...live(), [key(ID4)]: note(1, { deletedAt: NOW }) } });
      tick('other', 0);
      const hiddenBar = () => ['bar-permanent', 'bar-temporary', 'bar-move', 'bar-restore', 'bar-delete'].map((id) => els[id].hidden);
      assert.deepEqual(hiddenBar(), [false, false, false, true, true]);
      tick('bin', 0);
      assert.deepEqual(hiddenBar(), [true, true, true, false, false]);
    });

    await t2.test('the kind row action makes a note temporary', async () => {
      const { els, click, state, labels } = await runRecovery({ storage: { [key(ID1)]: note(1) } });
      await click('other', 0, 'Make temporary');
      assert.deepEqual(state.storage[key(ID1)], note(NOW, { temporary: true }));
      assert.equal(els['status-text'].textContent, 'Changed 1 note to temporary');
      assert.equal(els['status-undo'].hidden, true);
      assert.deepEqual(labels('other', 0), ['Open', 'Make permanent', 'Move to Bin']);
    });

    await t2.test('the kind row action makes a note permanent, stamped above updatedAt', async () => {
      const { els, click, state, labels } = await runRecovery({ storage: { [key(ID1)]: note(NOW + 5, { temporary: true }) } });
      await click('other', 0, 'Make permanent');
      assert.deepEqual(state.storage[key(ID1)], note(NOW + 6));
      assert.equal(els['status-text'].textContent, 'Changed 1 note to permanent');
      assert.deepEqual(labels('other', 0), ['Open', 'Make temporary', 'Move to Bin']);
    });

    await t2.test('the kind row action keeps focus and leaves an open tab alone', async () => {
      const { click, button, focus, calls, state } = await runRecovery({
        storage: { [key(ID1)]: note(1) },
        tabs: [{ id: 4, windowId: 1, url: url(ID1) }],
      });
      button('open', 0, 'Make temporary').focus();
      await click('open', 0, 'Make temporary');
      assert.equal(state.storage[key(ID1)].temporary, true);
      assert.equal(focus.active, button('open', 0, 'Make permanent'));
      assert.deepEqual(calls.filter((c) => ['runtime.sendMessage', 'tabs.remove'].includes(c[0])), []);
    });

    await t2.test('the bar changes the selected notes both ways', async () => {
      for (const [id, temporary, status] of [
        ['bar-temporary', true, 'Changed 2 notes to temporary'],
        ['bar-permanent', false, 'Changed 2 notes to permanent'],
      ]) {
        const { els, state, tick } = await runRecovery({
          storage: {
            [key(ID1)]: note(3, { temporary: !temporary }),
            [key(ID2)]: note(2, { temporary: !temporary }),
            [key(ID3)]: note(1, { temporary: !temporary }),
          },
        });
        tick('other', 0);
        tick('other', 1);
        await press(els, id);
        assert.deepEqual([ID1, ID2, ID3].map((i) => state.storage[key(i)].temporary === true), [temporary, temporary, !temporary]);
        assert.equal(els['status-text'].textContent, status);
        assert.equal(els.bar.hidden, true);
        assert.equal(els['status-undo'].hidden, true);
      }
    });

    await t2.test('a failed kind change is counted and warned', async () => {
      const { els, state, tick, warnings } = await runRecovery({
        storage: live(),
        reject: { 'storage.local.set': (items) => key(ID2) in items },
      });
      tick('other', 0);
      tick('other', 1);
      await press(els, 'bar-temporary');
      assert.equal(els['status-text'].textContent, 'Changed 1 of 2 notes to temporary. 1 could not be changed.');
      assert.equal(state.storage[key(ID1)].temporary, true);
      assert.equal(key(ID2) in state.storage && 'temporary' in state.storage[key(ID2)], false);
      assert.ok(warnings.some((w) => w[0] === 'tabnotes: change note kind:'));
      assert.equal(els['status-undo'].hidden, true);
    });

    await t2.test('a failed re-read counts as failed and writes nothing', async () => {
      const { els, calls, tick, warnings } = await runRecovery({ storage: { [key(ID1)]: note(1) }, reject: { 'storage.local.get key': true } });
      tick('other', 0);
      await press(els, 'bar-temporary');
      assert.equal(els['status-text'].textContent, 'Changed 0 of 1 note to temporary. 1 could not be changed.');
      assert.ok(warnings.some((w) => w[0] === 'tabnotes: reload note:'));
      assert.equal(calls.some((c) => c[0] === 'storage.local.set'), false);
    });

    await t2.test('a kind change ends an earlier Undo', async () => {
      const { els, click, state } = await runRecovery({ storage: live() });
      await click('other', 0, 'Move to Bin');
      assert.equal(els['status-undo'].hidden, false);
      await click('other', 0, 'Make temporary');
      assert.equal(els['status-undo'].hidden, true);
      await press(els, 'status-undo');
      assert.equal(state.storage[key(ID1)].deletedAt, NOW);
    });

    await t2.test('a note already of that kind is not written and keeps its updatedAt', async () => {
      const { els, state, tick, calls } = await runRecovery({
        storage: {
          [key(ID1)]: note(3, { temporary: true }),
          [key(ID2)]: note(2),
        },
      });
      tick('other', 0);
      tick('other', 1);
      await press(els, 'bar-temporary');
      assert.deepEqual(state.storage[key(ID1)], note(3, { temporary: true }));
      assert.deepEqual(calls.filter((c) => c[0] === 'storage.local.set').map((c) => Object.keys(c[1])), [[key(ID2)]]);
      assert.equal(els['status-text'].textContent, 'Changed 1 note to temporary');
    });

    await t2.test('a selection needing no change shows no status', async () => {
      const { els, calls, tick } = await runRecovery({ storage: { [key(ID1)]: note(1, { temporary: true }) } });
      tick('other', 0);
      await press(els, 'bar-temporary');
      assert.equal(calls.some((c) => c[0] === 'storage.local.set'), false);
      assert.equal(els.status.hidden, true);
    });

    await t2.test('a note binned or removed meanwhile counts as gone', async () => {
      const { els, state, tick, calls } = await runRecovery({ storage: live() });
      tick('other', 0);
      tick('other', 1);
      tick('other', 2);
      state.storage[key(ID1)] = note(9, { deletedAt: NOW });
      delete state.storage[key(ID2)];
      await press(els, 'bar-temporary');
      assert.deepEqual(state.storage[key(ID1)], note(9, { deletedAt: NOW }));
      assert.equal(key(ID2) in state.storage, false);
      assert.deepEqual(calls.filter((c) => c[0] === 'storage.local.set').map((c) => Object.keys(c[1])), [[key(ID3)]]);
      assert.equal(els['status-text'].textContent, 'Changed 1 note to temporary');
    });

    await t2.test('Restore brings back the selected Bin notes', async () => {
      const { els, state, tick } = await runRecovery({ storage: binned() });
      tick('bin', 0);
      tick('bin', 2);
      await press(els, 'bar-restore');
      assert.equal(state.storage[key(ID1)].deletedAt, null);
      assert.equal(state.storage[key(ID3)].deletedAt, null);
      assert.ok(state.storage[key(ID2)].deletedAt);
      assert.equal(els['status-text'].textContent, 'Restored 2 notes');
      assert.equal(els['status-undo'].hidden, true);
    });

    await t2.test('a blank note in a bulk restore is removed and not counted', async () => {
      const { els, state, tick } = await runRecovery({
        storage: { [key(ID1)]: note(3, { content: ' ', deletedAt: NOW }), [key(ID2)]: note(2, { content: 'two', deletedAt: NOW - 1 }) },
      });
      tick('bin', 0);
      tick('bin', 1);
      await press(els, 'bar-restore');
      assert.equal(Object.hasOwn(state.storage, key(ID1)), false);
      assert.equal(els['status-text'].textContent, 'Restored 1 note');
    });

    await t2.test('Delete forever confirms once with the count, then removes', async () => {
      const { els, state, tick, confirms } = await runRecovery({ storage: binned() });
      tick('bin', 0);
      tick('bin', 1);
      await press(els, 'bar-delete');
      assert.deepEqual(confirms, ['Delete 2 notes forever?']);
      assert.deepEqual(Object.keys(state.storage), [key(ID3)]);
      assert.equal(els['status-text'].textContent, 'Deleted 2 notes forever');
    });

    await t2.test('one selected note is named by what its row shows', async () => {
      const { els, tick, confirms } = await runRecovery({
        storage: { [key(ID1)]: note(1, { title: 'Notes', content: '# Plan', deletedAt: NOW }) },
      });
      tick('bin', 0);
      await press(els, 'bar-delete');
      assert.deepEqual(confirms, ['Delete "Plan" forever?']);
    });

    await t2.test('a declined confirmation changes nothing, selection included', async () => {
      const { els, state, tick, calls } = await runRecovery({ storage: binned(), confirmed: false });
      tick('bin', 0);
      await press(els, 'bar-delete');
      assert.equal(Object.keys(state.storage).length, 3);
      assert.deepEqual(calls, []);
      assert.equal(els.bar.hidden, false);
    });

    await t2.test('a note restored behind the dialog survives', async () => {
      const { els, state, tick } = await runRecovery({
        storage: { [key(ID1)]: note(1, { content: 'one', deletedAt: NOW }) },
        tabs: [{ id: 4, windowId: 1, url: url(ID1) }],
        onStop: (s) => {
          s.storage[key(ID1)] = note(1, { content: 'one' });
        },
      });
      tick('bin', 0);
      await press(els, 'bar-delete');
      assert.ok(state.storage[key(ID1)]);
      assert.equal(els.status.hidden, true);
    });

    await t2.test('Empty bin covers notes the search hides, with the full count', async () => {
      const { els, state, confirms } = await runRecovery({ storage: { ...binned(), [key(ID4)]: note(1, { content: 'live' }) } });
      els.search.value = 'one';
      els.search.dispatch('input');
      await press(els, 'empty-bin');
      assert.deepEqual(confirms, ['Delete all 3 notes in the Bin forever?']);
      assert.deepEqual(Object.keys(state.storage), [key(ID4)]);
    });

    await t2.test('Empty bin declined removes nothing', async () => {
      const { els, state } = await runRecovery({ storage: binned(), confirmed: false });
      await press(els, 'empty-bin');
      assert.equal(Object.keys(state.storage).length, 3);
    });
  });

  await t.test('rejected re-read is logged and writes nothing', async (t) => {
    const cases = [
      { section: 'other', label: 'Move to Bin', deletedAt: null },
      { section: 'bin', label: 'Restore', deletedAt: NOW },
    ];
    for (const c of cases) {
      await t.test(c.label, async () => {
        const { click, calls, warnings, counter } = await runRecovery({
          storage: { [key(ID1)]: note(1, { deletedAt: c.deletedAt }) },
          reject: { 'storage.local.get key': true },
        });
        await click(c.section, 0, c.label);
        assert.deepEqual(calls, [['storage.local.get', key(ID1)]]);
        assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: reload note:']);
        assert.equal(counter.refreshes, 2);
      });
    }
  });

  for (const api of ['storage.local.getKeys', 'storage.local.get']) {
    await t.test(`rejected ${api} on the first refresh is logged and shows the error`, async () => {
      const { els, warnings } = await runRecovery({
        storage: { [key(ID1)]: note(1) },
        reject: { [api]: true },
      });
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], 'tabnotes: refresh:');
      assert.equal(els.error.hidden, false);
    });

    await t.test(`rejected ${api} keeps the previous render`, async () => {
      const reject = {};
      const { els, state, snippets, warnings, events } = await runRecovery({
        storage: { [key(ID1)]: note(1, { content: 'a' }) },
        reject,
      });
      assert.deepEqual(snippets('other'), ['a']);
      assert.equal(els.error.hidden, true);
      reject[api] = true;
      state.storage = {};
      events['tabs.onRemoved'](1, {});
      await settle();
      assert.equal(warnings.length, 1);
      assert.equal(els.error.hidden, false);
      assert.deepEqual(snippets('other'), ['a']);
      assert.equal(els['other-section'].hidden, false);
    });
  }

  await t.test('a refresh requests only note keys, never an image value', async () => {
    const { reads, snippets } = await runRecovery({
      storage: {
        [key(ID1)]: note(1, { content: 'a' }),
        settings: { defaultTitle: 'Notes' },
        [`image:${ID2}`]: { dataUrl: 'data:image/png;base64,AAAA' },
        imageOrphans: { [ID2]: 1 },
      },
    });
    assert.deepEqual(reads, [[key(ID1), 'settings']]);
    assert.deepEqual(snippets('other'), ['a']);
  });
});
