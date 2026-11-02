'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { unzipSync, zipSync } = require('fflate');
const { bundle } = require('./bundle.js');
const { TITLE_HINT, importSummary, noteFile } = require('../src/lib/notes.ts');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const script = bundle('src/options/options.ts');

function element(attrs = {}) {
  const listeners = {};
  return {
    value: '',
    hidden: false,
    ...attrs,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatch(type) {
      for (const fn of listeners[type] || []) fn({ type });
    },
    clicks: 0,
    click() {
      this.clicks++;
    },
  };
}

const recoveryURL = 'moz-extension://uuid/recovery/recovery.html';

// settle lets pending promise chains in the page run to completion
const settle = () => new Promise((r) => setImmediate(r));

// runOptions evaluates the options bundle against a fake DOM
// and browser API and resolves once the page's async setup has finished. The
// initial element state mirrors options.html, which the 'options.html' test
// asserts. storage is read live and set merges into it; holdLoad keeps the
// first get pending until releaseLoad is called, holdKeys the first getKeys
// until releaseKeys. The <a download> elements the page creates are in
// anchors, the Blobs given to URL.createObjectURL in blobs.
async function runOptions({ storage = {}, reject = {}, allTabs = [], holdLoad = false, holdKeys = false } = {}) {
  const els = {
    error: element({ hidden: true }),
    'default-title': element({ disabled: true }),
    'title-hint': element({ textContent: '' }),
    'new-notes': element({ disabled: true, value: 'permanent' }),
    'font-size': element({ disabled: true }),
    theme: element({ disabled: true, value: 'system' }),
    'all-notes': element(),
    'export-notes': element({ disabled: true }),
    'import-notes': element({ disabled: true }),
    'import-file': element({ hidden: true, files: [] }),
    'transfer-status': element({ textContent: '' }),
  };
  const anchors = [];
  const blobs = [];
  const body = { children: [], append(...nodes) { this.children.push(...nodes); } };
  const doc = {
    getElementById: (id) => els[id],
    body,
    createElement: (tag) => {
      const el = {
        tagName: tag.toUpperCase(),
        clicked: [],
        click() {
          this.clicked.push({ href: this.href, download: this.download, attached: body.children.includes(this) });
        },
        remove() {
          body.children = body.children.filter((c) => c !== this);
        },
      };
      anchors.push(el);
      return el;
    },
  };
  let releaseKeys = () => {};
  let heldKeys = holdKeys ? new Promise((r) => (releaseKeys = r)) : null;
  const changeListeners = [];
  let releaseLoad = () => {};
  let held = holdLoad ? new Promise((r) => (releaseLoad = r)) : null;
  const warnings = [];
  const calls = [];
  // call records a browser API call and rejects when the test asked it to;
  // args are cloned into this realm so deepStrictEqual compares prototypes
  const call = async (name, ...args) => {
    calls.push(structuredClone([name, ...args]));
    if (reject[name]) throw new Error(`${name} rejected`);
  };
  const ctx = vm.createContext({
    console: { warn: (...a) => warnings.push(a) },
    document: doc,
    Blob,
    crypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    setTimeout: () => {},
    URL: class extends URL {
      static createObjectURL(blob) {
        blobs.push(blob);
        return `blob:moz-extension://uuid/${blobs.length}`;
      }

      static revokeObjectURL() {}
    },
    browser: {
      runtime: { getURL: (p) => `moz-extension://uuid/${p}` },
      windows: { update: (...a) => call('windows.update', ...a) },
      tabs: {
        create: (props) => call('tabs.create', props),
        update: (...a) => call('tabs.update', ...a),
        query: async (q) => {
          await call('tabs.query', q);
          return structuredClone(allTabs);
        },
      },
      storage: {
        local: {
          getKeys: async () => {
            const wait = heldKeys;
            heldKeys = null;
            await call('storage.local.getKeys');
            if (wait) await wait;
            return Object.keys(storage);
          },
          get: async (keys) => {
            const wait = held;
            held = null;
            await call('storage.local.get', keys);
            if (wait) await wait;
            const want = Array.isArray(keys) ? keys : [keys];
            return structuredClone(Object.fromEntries(want.filter((k) => k in storage).map((k) => [k, storage[k]])));
          },
          set: async (v) => {
            await call('storage.local.set', v);
            Object.assign(storage, structuredClone(v));
          },
        },
        onChanged: { addListener: (fn) => changeListeners.push(fn) },
      },
    },
  });
  script.runInContext(ctx);
  await settle();
  const input = els['default-title'];
  const size = els['font-size'];
  const theme = els.theme;
  const kind = els['new-notes'];
  const type = (value) => {
    input.value = value;
    input.dispatch('input');
  };
  // enterSize types value into the font size field and commits it the way
  // Firefox does: input events while typing, then change
  const enterSize = (value) => {
    size.value = value;
    size.dispatch('input');
    size.dispatch('change');
  };
  const pickTheme = (value) => {
    theme.value = value;
    theme.dispatch('change');
  };
  const pickKind = (value) => {
    kind.value = value;
    kind.dispatch('change');
  };
  // change delivers a storage.onChanged event to the page
  const change = (changes, area = 'local') => {
    for (const fn of changeListeners) fn(structuredClone(changes), area);
  };
  const writes = () => calls.filter(([name]) => name === 'storage.local.set');
  // pick selects files in the hidden input the way the file picker does
  const pick = (files) => {
    els['import-file'].files = files;
    els['import-file'].dispatch('change');
  };
  return {
    els, input, size, theme, kind, storage, warnings, calls, writes, type, enterSize, pickTheme, pickKind, change, releaseLoad,
    anchors, blobs, pick, releaseKeys,
  };
}

test('options.html starts with the harness state', () => {
  const html = read('src', 'options', 'options.html');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['../theme.js', 'options.js']);
  assert.match(html, /<p id="error"[^>]*\shidden[\s>][^<]*Could not load settings</);
  assert.match(html, /<input id="default-title"[^>]*\sdisabled[\s>]/);
  assert.match(html, /<input id="font-size" type="number" min="10" max="32"[^>]*\sdisabled[\s>]/);
  assert.match(html, /<select id="theme" disabled>/);
  const options = (id) => {
    const select = html.match(new RegExp(`<select id="${id}"[^>]*>[\\s\\S]*?</select>`))[0];
    return [...select.matchAll(/<option value="([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2]]);
  };
  assert.deepEqual(options('theme'), [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]);
  assert.match(html, /toolbar button<\/span>\s*<select id="new-notes" disabled>/);
  assert.deepEqual(options('new-notes'), [['permanent', 'Permanent'], ['temporary', 'Temporary']]);
  assert.match(html, /id="all-notes"[^>]*>All notes</);
  assert.match(html, /<button id="export-notes" type="button" disabled>Export all notes<\/button>/);
  assert.match(html, /<button id="import-notes" type="button" disabled>Import\.\.\.<\/button>/);
  assert.match(html, /<input id="import-file" type="file" accept="\.zip,\.md" multiple hidden>/);
  assert.match(html, /<small id="transfer-status"[^>]*><\/small>/);
  assert.match(html, /Default title for new notes/);
  // the hint sits in .field for the spacing but outside the label, so it is not
  // part of the input's name and a click on it does not focus the input; its
  // text stays in code
  assert.match(html, /<div class="field">\s*<label for="default-title">[^<]*<\/label>\s*<input id="default-title"[^>]*aria-describedby="title-hint"[^>]*>\s*<small id="title-hint" class="title-hint"><\/small>\s*<\/div>/);
});

test('options page', async (t) => {
  await t.test('loads the stored default title and enables the input', async () => {
    const { input, els, calls, warnings } = await runOptions({ storage: { settings: { defaultTitle: 'Ticket' } } });
    assert.deepEqual(calls, [['storage.local.get', ['settings', 'fontSize', 'theme']]]);
    assert.equal(input.value, 'Ticket');
    assert.equal(input.disabled, false);
    assert.equal(els.error.hidden, true);
    assert.deepEqual(warnings, []);
  });

  await t.test('shows "Notes" when settings or the title are missing', async (t) => {
    for (const storage of [{}, { settings: {} }, { settings: { defaultTitle: '' } }]) {
      await t.test(JSON.stringify(storage), async () => {
        const { input } = await runOptions({ storage });
        assert.equal(input.value, 'Notes');
        assert.equal(input.disabled, false);
      });
    }
  });

  await t.test('every input saves the trimmed title at once', async () => {
    const { writes, type } = await runOptions();
    type('  Jira ');
    type('Jira ticket');
    assert.deepEqual(writes(), [
      ['storage.local.set', { settings: { defaultTitle: 'Jira' } }],
      ['storage.local.set', { settings: { defaultTitle: 'Jira ticket' } }],
    ]);
  });

  await t.test('shows the title hint', async () => {
    const { els } = await runOptions();
    assert.equal(els['title-hint'].textContent, TITLE_HINT);
  });

  await t.test('a template is stored unexpanded and trimmed', async () => {
    const { writes, type, input } = await runOptions();
    type('  {date} - {tab | trunc 30} ');
    assert.deepEqual(writes(), [['storage.local.set', { settings: { defaultTitle: '{date} - {tab | trunc 30}' } }]]);
    assert.equal(input.value, '  {date} - {tab | trunc 30} ');
  });

  await t.test('blank input saves "Notes"', async () => {
    const { writes, type } = await runOptions({ storage: { settings: { defaultTitle: 'X' } } });
    type('');
    type('   ');
    assert.deepEqual(writes(), [
      ['storage.local.set', { settings: { defaultTitle: 'Notes' } }],
      ['storage.local.set', { settings: { defaultTitle: 'Notes' } }],
    ]);
  });

  await t.test('rejected load shows the error, keeps the input disabled and never saves', async () => {
    const { els, input, warnings, writes, type } = await runOptions({
      storage: { settings: { defaultTitle: 'keep' } },
      reject: { 'storage.local.get': true },
    });
    assert.equal(els.error.hidden, false);
    assert.equal(input.disabled, true);
    assert.equal(input.value, '');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'tabnotes: load settings:');
    type('x');
    assert.deepEqual(writes(), []);
  });

  await t.test('rejected save is logged', async () => {
    const { warnings, type } = await runOptions({ reject: { 'storage.local.set': true } });
    type('x');
    await settle();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'tabnotes: save settings:');
  });

  await t.test('All notes focuses an existing recovery tab in its window', async () => {
    const allTabs = [
      { id: 1, windowId: 10, url: 'https://a.com/' },
      { id: 2, windowId: 20, url: `${recoveryURL}#x` },
    ];
    const { els, calls } = await runOptions({ allTabs });
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
    const { els, calls } = await runOptions({ allTabs });
    calls.length = 0;
    els['all-notes'].dispatch('click');
    await settle();
    assert.deepEqual(calls, [
      ['tabs.query', {}],
      ['tabs.create', { url: recoveryURL }],
    ]);
  });

  await t.test('All notes works after a failed load', async () => {
    const { els, calls } = await runOptions({ reject: { 'storage.local.get': true } });
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
        const { els, warnings } = await runOptions(c);
        els['all-notes'].dispatch('click');
        await settle();
        assert.deepEqual(warnings.map((w) => w[0]).sort(), c.warns.sort());
      });
    }
  });
});

test('options font size', async (t) => {
  await t.test('load shows the stored size and enables the field', async () => {
    const { size, warnings } = await runOptions({ storage: { fontSize: 18 } });
    assert.equal(size.value, '18');
    assert.equal(size.disabled, false);
    assert.deepEqual(warnings, []);
  });

  await t.test('load shows the default or clamped size for an absent or invalid value', async (t) => {
    const cases = [
      { name: 'absent', storage: {}, want: '14' },
      { name: 'string', storage: { fontSize: '20' }, want: '14' },
      { name: 'too big', storage: { fontSize: 99 }, want: '32' },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { size } = await runOptions({ storage: c.storage });
        assert.equal(size.value, c.want);
      });
    }
  });

  await t.test('change writes only fontSize, clamped and rounded', async (t) => {
    const cases = [
      { name: 'valid', value: '16', want: 16 },
      { name: 'rounded', value: '16.6', want: 17 },
      { name: 'below range', value: '1', want: 10 },
      { name: 'above range', value: '100', want: 32 },
      { name: 'blank', value: '', want: 14 },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { size, writes, enterSize } = await runOptions({ storage: { settings: { defaultTitle: 'X' }, fontSize: 12 } });
        enterSize(c.value);
        assert.deepEqual(writes(), [['storage.local.set', { fontSize: c.want }]]);
        assert.equal(size.value, String(c.want));
      });
    }
  });

  await t.test('input alone writes nothing', async () => {
    const { size, writes } = await runOptions();
    size.value = '1';
    size.dispatch('input');
    assert.deepEqual(writes(), []);
  });

  await t.test('rejected save is logged', async () => {
    const { warnings, enterSize } = await runOptions({ reject: { 'storage.local.set': true } });
    enterSize('20');
    await settle();
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: save font size:']);
  });

  await t.test('failed load keeps the field disabled and never saves', async () => {
    const { size, writes, enterSize } = await runOptions({
      storage: { fontSize: 20 },
      reject: { 'storage.local.get': true },
    });
    assert.equal(size.disabled, true);
    assert.equal(size.value, '');
    enterSize('12');
    assert.deepEqual(writes(), []);
  });

  await t.test('an external change updates the field', async () => {
    const { size, change, writes } = await runOptions({ storage: { fontSize: 14 } });
    change({ fontSize: { oldValue: 14, newValue: 15 } });
    assert.equal(size.value, '15');
    change({ fontSize: { oldValue: 15 } });
    assert.equal(size.value, '14');
    assert.deepEqual(writes(), []);
  });

  await t.test('other keys and areas are ignored', async () => {
    const { size, change } = await runOptions({ storage: { fontSize: 18 } });
    change({ settings: { newValue: { defaultTitle: 'Y' } } });
    change({ fontSize: { newValue: 30 } }, 'sync');
    assert.equal(size.value, '18');
  });

  await t.test('an external change replaces a draft, a later commit writes the typed size', async () => {
    const { size, storage, change, enterSize, writes } = await runOptions({ storage: { fontSize: 14 } });
    size.value = '2';
    size.dispatch('input');
    change({ fontSize: { oldValue: 14, newValue: 20 } });
    assert.equal(size.value, '20');
    enterSize('18');
    await settle();
    assert.deepEqual(writes(), [['storage.local.set', { fontSize: 18 }]]);
    assert.equal(size.value, '18');
    assert.equal(storage.fontSize, 18);
  });

  await t.test('a change during the load wins over the loaded value', async () => {
    const { size, change, releaseLoad } = await runOptions({ storage: { fontSize: 14 }, holdLoad: true });
    assert.equal(size.disabled, true);
    change({ fontSize: { oldValue: 14, newValue: 22 } });
    releaseLoad();
    await settle();
    assert.equal(size.value, '22');
    assert.equal(size.disabled, false);
  });

  await t.test('a removal during the load wins over the loaded value', async () => {
    const { size, change, releaseLoad } = await runOptions({ storage: { fontSize: 20 }, holdLoad: true });
    change({ fontSize: { oldValue: 20 } });
    releaseLoad();
    await settle();
    assert.equal(size.value, '14');
  });
});

test('options theme', async (t) => {
  await t.test('load shows the stored mode and enables the select', async (t) => {
    for (const mode of ['system', 'light', 'dark']) {
      await t.test(mode, async () => {
        const { theme, writes, warnings } = await runOptions({ storage: { theme: mode } });
        assert.equal(theme.value, mode);
        assert.equal(theme.disabled, false);
        assert.deepEqual(writes(), []);
        assert.deepEqual(warnings, []);
      });
    }
  });

  await t.test('load shows System for an absent or invalid value', async (t) => {
    const cases = [
      { name: 'absent', storage: {} },
      { name: 'unknown string', storage: { theme: 'sepia' } },
      { name: 'non-string', storage: { theme: 1 } },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { theme } = await runOptions({ storage: c.storage });
        assert.equal(theme.value, 'system');
        assert.equal(theme.disabled, false);
      });
    }
  });

  await t.test('change writes only theme', async () => {
    const { storage, writes, pickTheme } = await runOptions({ storage: { settings: { defaultTitle: 'X' }, fontSize: 12 } });
    pickTheme('dark');
    pickTheme('light');
    await settle();
    assert.deepEqual(writes(), [
      ['storage.local.set', { theme: 'dark' }],
      ['storage.local.set', { theme: 'light' }],
    ]);
    assert.equal(storage.theme, 'light');
  });

  await t.test('rejected save is logged', async () => {
    const { warnings, pickTheme } = await runOptions({ reject: { 'storage.local.set': true } });
    pickTheme('dark');
    await settle();
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: save theme:']);
  });

  await t.test('failed load keeps the select disabled and never saves', async () => {
    const { theme, writes, pickTheme } = await runOptions({
      storage: { theme: 'dark' },
      reject: { 'storage.local.get': true },
    });
    assert.equal(theme.disabled, true);
    assert.equal(theme.value, 'system');
    pickTheme('light');
    assert.deepEqual(writes(), []);
  });

  await t.test('an external change updates the select without saving', async () => {
    const { theme, change, writes } = await runOptions({ storage: { theme: 'light' } });
    change({ theme: { oldValue: 'light', newValue: 'dark' } });
    assert.equal(theme.value, 'dark');
    change({ theme: { oldValue: 'dark', newValue: 'sepia' } });
    assert.equal(theme.value, 'system');
    change({ theme: { oldValue: 'sepia', newValue: 'light' } });
    change({ theme: { oldValue: 'light' } });
    assert.equal(theme.value, 'system');
    assert.deepEqual(writes(), []);
  });

  await t.test('other keys and areas are ignored', async () => {
    const { theme, change } = await runOptions({ storage: { theme: 'dark' } });
    change({ fontSize: { newValue: 20 } });
    change({ theme: { newValue: 'light' } }, 'sync');
    assert.equal(theme.value, 'dark');
  });

  await t.test('one event carrying both keys updates both fields', async () => {
    const { size, theme, change } = await runOptions({ storage: { fontSize: 14, theme: 'light' } });
    change({ fontSize: { newValue: 20 }, theme: { newValue: 'dark' } });
    assert.equal(size.value, '20');
    assert.equal(theme.value, 'dark');
  });

  await t.test('a change during the load wins over the loaded value', async () => {
    const { theme, size, change, releaseLoad } = await runOptions({ storage: { fontSize: 18, theme: 'light' }, holdLoad: true });
    assert.equal(theme.disabled, true);
    change({ theme: { oldValue: 'light', newValue: 'dark' } });
    releaseLoad();
    await settle();
    assert.equal(theme.value, 'dark');
    assert.equal(theme.disabled, false);
    assert.equal(size.value, '18', 'the flag is per key');
  });

  await t.test('a removal during the load wins over the loaded value', async () => {
    const { theme, change, releaseLoad } = await runOptions({ storage: { theme: 'dark' }, holdLoad: true });
    change({ theme: { oldValue: 'dark' } });
    releaseLoad();
    await settle();
    assert.equal(theme.value, 'system');
  });
});

test('options kind of new notes', async (t) => {
  await t.test('defaults to permanent and enables the select', async (t) => {
    const cases = [
      { name: 'no settings', storage: {} },
      { name: 'no key', storage: { settings: { defaultTitle: 'X' } } },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const { kind, writes, warnings } = await runOptions({ storage: c.storage });
        assert.equal(kind.value, 'permanent');
        assert.equal(kind.disabled, false);
        assert.deepEqual(writes(), []);
        assert.deepEqual(warnings, []);
      });
    }
  });

  await t.test('an unknown stored value reads as permanent', async (t) => {
    for (const temporary of [false, 1, 'yes', 'true', null]) {
      await t.test(JSON.stringify(temporary), async () => {
        const { kind } = await runOptions({ storage: { settings: { defaultTitle: 'X', temporary } } });
        assert.equal(kind.value, 'permanent');
      });
    }
  });

  await t.test('a saved value round-trips', async () => {
    const { storage, pickKind, writes } = await runOptions({ storage: { settings: { defaultTitle: 'X' } } });
    pickKind('temporary');
    await settle();
    assert.deepEqual(writes(), [['storage.local.set', { settings: { defaultTitle: 'X', temporary: true } }]]);
    const { kind } = await runOptions({ storage });
    assert.equal(kind.value, 'temporary');
  });

  await t.test('permanent omits the key, never storing false', async () => {
    const { storage, pickKind } = await runOptions({ storage: { settings: { defaultTitle: 'X', temporary: true } } });
    pickKind('permanent');
    await settle();
    assert.deepEqual(storage.settings, { defaultTitle: 'X' });
  });

  await t.test('editing the title keeps the kind', async () => {
    const { storage, type } = await runOptions({ storage: { settings: { defaultTitle: 'X', temporary: true } } });
    type('Y');
    await settle();
    assert.deepEqual(storage.settings, { defaultTitle: 'Y', temporary: true });
  });

  await t.test('changing the kind keeps the title', async () => {
    const { storage, pickKind } = await runOptions({ storage: { settings: { defaultTitle: '{date} X' } } });
    pickKind('temporary');
    await settle();
    assert.deepEqual(storage.settings, { defaultTitle: '{date} X', temporary: true });
  });

  await t.test('rejected save is logged', async () => {
    const { warnings, pickKind } = await runOptions({ reject: { 'storage.local.set': true } });
    pickKind('temporary');
    await settle();
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: save settings:']);
  });

  await t.test('failed load keeps the select disabled and never saves', async () => {
    const { kind, writes, pickKind } = await runOptions({
      storage: { settings: { defaultTitle: 'keep', temporary: true } },
      reject: { 'storage.local.get': true },
    });
    assert.equal(kind.disabled, true);
    assert.equal(kind.value, 'permanent');
    pickKind('temporary');
    assert.deepEqual(writes(), []);
  });
});

test('options export and import', async (t) => {
  const NOW = Date.UTC(2026, 10, 2);
  const ID1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const IMG = '886313e1-3b8a-4372-9b90-0c9aee199e5d';
  const notes = () => ({
    [`note:${ID1}`]: { title: 'Shopping list', content: 'milk', updatedAt: NOW, deletedAt: null },
    [`note:${ID2}`]: { title: 'Old draft', content: 'gone', updatedAt: NOW - 2, deletedAt: NOW - 1 },
  });
  const files = async (blob) => Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer())));
  const exportEl = (els) => els['export-notes'];
  const importEl = (els) => els['import-notes'];
  const backup = () => new File([zipSync({
    'permanent/Shopping list.md': new TextEncoder().encode(noteFile(ID1, notes()[`note:${ID1}`], 'milk')),
  })], 'tabnotes-2026-11-02.zip');

  await t.test('the buttons are enabled after a successful load', async () => {
    const { els } = await runOptions();
    assert.equal(exportEl(els).disabled, false);
    assert.equal(importEl(els).disabled, false);
  });

  await t.test('a failed load keeps the buttons disabled', async () => {
    const { els } = await runOptions({ reject: { 'storage.local.get': true } });
    assert.equal(exportEl(els).disabled, true);
    assert.equal(importEl(els).disabled, true);
  });

  await t.test('export downloads a zip of all notes through <a download>', async () => {
    const { els, anchors, blobs, warnings } = await runOptions({ storage: { ...notes(), fontSize: 16 } });
    exportEl(els).dispatch('click');
    await settle();
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].clicked.length, 1);
    assert.equal(anchors[0].clicked[0].attached, true);
    assert.match(anchors[0].clicked[0].download, /^tabnotes-\d{4}-\d{2}-\d{2}\.zip$/);
    assert.equal(anchors[0].clicked[0].href, 'blob:moz-extension://uuid/1');
    assert.deepEqual(await files(blobs[0]), ['bin/Old draft.md', 'permanent/Shopping list.md']);
    assert.equal(els['transfer-status'].textContent, 'Exported 2 notes.');
    assert.equal(exportEl(els).disabled, false);
    assert.deepEqual(warnings, []);
  });

  await t.test('export names the images it left out', async () => {
    const storage = notes();
    storage[`note:${ID1}`].content = `![x](tabnotes-image:${IMG})`;
    storage[`image:${IMG}`] = { dataUrl: 'data:text/plain;base64,AAAA' };
    const { els } = await runOptions({ storage });
    exportEl(els).dispatch('click');
    await settle();
    assert.equal(els['transfer-status'].textContent, `Exported 2 notes. Left out 1 image that could not be read: ${IMG}.`);
  });

  await t.test('the buttons are disabled during a run and a pick during it is refused with a message', async () => {
    const { els, calls, releaseKeys, anchors, pick } = await runOptions({ storage: notes(), holdKeys: true });
    exportEl(els).dispatch('click');
    await settle();
    assert.equal(exportEl(els).disabled, true);
    assert.equal(importEl(els).disabled, true);
    // a disabled button fires no click, but a picker opened before the run
    // can still deliver files
    pick([new File(['x'], 'x.md')]);
    await settle();
    assert.equal(els['transfer-status'].textContent, 'Could not import notes: another export or import is running.');
    releaseKeys();
    await settle();
    assert.equal(calls.filter(([name]) => name === 'storage.local.getKeys').length, 1);
    assert.equal(anchors.length, 1);
    assert.equal(exportEl(els).disabled, false);
    assert.equal(importEl(els).disabled, false);
  });

  await t.test('Import opens the file picker', async () => {
    const { els } = await runOptions();
    importEl(els).dispatch('click');
    assert.equal(els['import-file'].clicks, 1);
  });

  await t.test('picked files are imported and the summary shown', async () => {
    const { els, storage, pick, warnings } = await runOptions();
    pick([backup(), new File(['x'], 'notes.txt')]);
    await settle();
    assert.deepEqual(storage[`note:${ID1}`], notes()[`note:${ID1}`]);
    assert.equal(
      els['transfer-status'].textContent,
      importSummary({ imported: 1, images: 0, identical: 0, copies: 0, rejected: { 'unsupported file': 1 } }),
    );
    // cleared, so picking the same file again fires change
    assert.equal(els['import-file'].value, '');
    assert.equal(importEl(els).disabled, false);
    assert.deepEqual(warnings, []);
  });

  await t.test('the buttons are disabled during an import', async () => {
    const { els, pick, releaseKeys } = await runOptions({ holdKeys: true });
    pick([backup()]);
    await settle();
    assert.equal(exportEl(els).disabled, true);
    assert.equal(importEl(els).disabled, true);
    releaseKeys();
    await settle();
    assert.equal(exportEl(els).disabled, false);
    assert.equal(importEl(els).disabled, false);
  });

  await t.test('a pick with no files does nothing', async () => {
    const { els, calls, pick } = await runOptions();
    calls.length = 0;
    pick([]);
    await settle();
    assert.deepEqual(calls, []);
    assert.equal(els['transfer-status'].textContent, '');
  });

  await t.test('a failed export shows a message, logs and saves nothing', async () => {
    const { els, anchors, warnings } = await runOptions({ storage: notes(), reject: { 'storage.local.getKeys': true } });
    exportEl(els).dispatch('click');
    await settle();
    assert.equal(anchors.length, 0);
    assert.equal(els['transfer-status'].textContent, 'Could not export notes: list keys.');
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: export notes:']);
    assert.equal(exportEl(els).disabled, false);
  });

  await t.test('a new run clears the status of the last one', async () => {
    const { els, pick } = await runOptions({ storage: notes() });
    exportEl(els).dispatch('click');
    await settle();
    assert.equal(els['transfer-status'].textContent, 'Exported 2 notes.');
    pick([backup()]);
    assert.equal(els['transfer-status'].textContent, '');
    await settle();
    assert.match(els['transfer-status'].textContent, /^Imported/);
  });

  await t.test('a failed note write shows the summary and logs the error', async () => {
    const { els, pick, warnings } = await runOptions({ reject: { 'storage.local.set': true } });
    pick([backup()]);
    await settle();
    const stopped = 'Error: storage.local.set rejected';
    // the error itself is logged, so the console keeps its stack
    assert.equal(
      els['transfer-status'].textContent,
      importSummary({ imported: 0, images: 0, identical: 0, copies: 0, rejected: {}, stopped }),
    );
    assert.deepEqual(warnings.map(([what, err]) => [what, typeof err, String(err)]), [['tabnotes: import notes:', 'object', stopped]]);
  });

  await t.test('a rejection that is no Error shows its text', async () => {
    const { els, pick, warnings } = await runOptions();
    // a name getter throwing a string is the one way to reach it here, as
    // transfer.ts wraps every browser.* failure in an Error
    pick([{ get name() { throw 'boom'; } }]);
    await settle();
    assert.equal(els['transfer-status'].textContent, 'Could not import notes: boom.');
    assert.deepEqual(warnings, [['tabnotes: import notes:', 'boom']]);
  });

  await t.test('a failed import shows a message and logs', async () => {
    const { els, pick, warnings, writes } = await runOptions({ reject: { 'storage.local.getKeys': true } });
    pick([backup()]);
    await settle();
    assert.equal(els['transfer-status'].textContent, 'Could not import notes: list keys.');
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: import notes:']);
    assert.deepEqual(writes(), []);
    assert.equal(importEl(els).disabled, false);
  });
});
