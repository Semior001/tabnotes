'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bundle } = require('./bundle.js');
const { TITLE_HINT } = require('../src/lib/notes.ts');

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
  };
}

const recoveryURL = 'moz-extension://uuid/recovery/recovery.html';

// settle lets pending promise chains in the page run to completion
const settle = () => new Promise((r) => setImmediate(r));

// runOptions evaluates the options bundle against a fake DOM
// and browser API and resolves once the page's async setup has finished. The
// initial element state mirrors options.html, which the 'options.html' test
// asserts. storage is read live and set merges into it; holdLoad keeps the
// first get pending until releaseLoad is called.
async function runOptions({ storage = {}, reject = {}, allTabs = [], holdLoad = false } = {}) {
  const els = {
    error: element({ hidden: true }),
    'default-title': element({ disabled: true }),
    'title-hint': element({ textContent: '' }),
    'font-size': element({ disabled: true }),
    theme: element({ disabled: true, value: 'system' }),
    'all-notes': element(),
  };
  const doc = { getElementById: (id) => els[id] };
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
  // change delivers a storage.onChanged event to the page
  const change = (changes, area = 'local') => {
    for (const fn of changeListeners) fn(structuredClone(changes), area);
  };
  const writes = () => calls.filter(([name]) => name === 'storage.local.set');
  return { els, input, size, theme, storage, warnings, calls, writes, type, enterSize, pickTheme, change, releaseLoad };
}

test('options.html starts with the harness state', () => {
  const html = read('src', 'options', 'options.html');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['../theme.js', 'options.js']);
  assert.match(html, /<p id="error"[^>]*\shidden[\s>][^<]*Could not load settings</);
  assert.match(html, /<input id="default-title"[^>]*\sdisabled[\s>]/);
  assert.match(html, /<input id="font-size" type="number" min="10" max="32"[^>]*\sdisabled[\s>]/);
  assert.match(html, /<select id="theme" disabled>/);
  const options = [...html.matchAll(/<option value="([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(options, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]);
  assert.match(html, /id="all-notes"[^>]*>All notes</);
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
