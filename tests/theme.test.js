'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { bundle } = require('./bundle.js');

const script = bundle('src/theme.ts');

// settle lets pending promise chains in the page run to completion
const settle = () => new Promise((r) => setImmediate(r));

// runTheme evaluates the theme bundle against a fake DOM and browser API.
// mirror is the initial localStorage value, stored the storage.local content.
// With holdLoad the read stays pending until releaseLoad is called. readFails
// and writeFails make localStorage throw, rejectGet rejects the storage read.
function runTheme({ mirror, stored = {}, holdLoad = false, readFails = false, writeFails = false, rejectGet = false } = {}) {
  const values = new Map(mirror === undefined ? [] : [['theme', mirror]]);
  const root = { dataset: {} };
  const warnings = [];
  const gets = [];
  const changeListeners = [];
  let releaseLoad = () => {};
  const held = holdLoad ? new Promise((r) => (releaseLoad = r)) : Promise.resolve();
  const localStorage = {
    getItem(key) {
      if (readFails) throw new Error('getItem refused');
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (writeFails) throw new Error('setItem refused');
      values.set(key, value);
    },
  };
  const ctx = vm.createContext({
    console: { warn: (...a) => warnings.push(a) },
    document: { documentElement: root },
    localStorage,
    browser: {
      storage: {
        local: {
          get: async (keys) => {
            gets.push(keys);
            await held;
            if (rejectGet) throw new Error('get rejected');
            return { ...stored };
          },
        },
        onChanged: { addListener: (fn) => changeListeners.push(fn) },
      },
    },
  });
  script.runInContext(ctx);
  const change = (changes, area = 'local') => { for (const fn of changeListeners) fn(changes, area); };
  return { root, values, warnings, gets, change, releaseLoad };
}

test('the mirror applies synchronously, before any storage reply', async () => {
  const { root, gets, releaseLoad } = runTheme({ holdLoad: true, mirror: 'dark', stored: { theme: 'dark' } });
  assert.equal(root.dataset.theme, 'dark');
  assert.deepEqual(gets, ['theme']);
  releaseLoad();
  await settle();
  assert.equal(root.dataset.theme, 'dark');
});

test('an empty mirror means system until storage answers', async () => {
  const { root, values, releaseLoad } = runTheme({ holdLoad: true, stored: { theme: 'light' } });
  assert.equal(root.dataset.theme, 'system');
  releaseLoad();
  await settle();
  assert.equal(root.dataset.theme, 'light');
  assert.equal(values.get('theme'), 'light');
});

test('storage corrects a stale mirror', async () => {
  const { root, values, warnings } = runTheme({ mirror: 'dark', stored: { theme: 'light' } });
  await settle();
  assert.equal(root.dataset.theme, 'light');
  assert.equal(values.get('theme'), 'light');
  assert.deepEqual(warnings, []);
});

test('a key missing from storage resets a stale mirror to system', async () => {
  const { root, values } = runTheme({ mirror: 'dark' });
  await settle();
  assert.equal(root.dataset.theme, 'system');
  assert.equal(values.get('theme'), 'system');
});

test('onChanged updates data-theme and the mirror', async () => {
  const { root, values, change } = runTheme({ stored: { theme: 'light' } });
  await settle();
  change({ theme: { newValue: 'dark' } });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(values.get('theme'), 'dark');
});

test('a change during the load wins over the loaded value', async () => {
  const { root, values, change, releaseLoad } = runTheme({ holdLoad: true, mirror: 'light', stored: { theme: 'light' } });
  change({ theme: { newValue: 'dark' } });
  releaseLoad();
  await settle();
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(values.get('theme'), 'dark');
});

test('other keys and areas are ignored', async () => {
  const { root, values, change } = runTheme({ stored: { theme: 'light' } });
  await settle();
  change({ fontSize: { newValue: 20 } });
  change({ theme: { newValue: 'dark' } }, 'sync');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(values.get('theme'), 'light');
});

test('an ignored change does not block the loaded value', async () => {
  const { root, change, releaseLoad } = runTheme({ holdLoad: true, stored: { theme: 'dark' } });
  change({ theme: { newValue: 'light' } }, 'sync');
  change({ fontSize: { newValue: 20 } });
  releaseLoad();
  await settle();
  assert.equal(root.dataset.theme, 'dark');
});

test('a removed key means system', async () => {
  const { root, values, change } = runTheme({ stored: { theme: 'dark' } });
  await settle();
  change({ theme: { oldValue: 'dark' } });
  assert.equal(root.dataset.theme, 'system');
  assert.equal(values.get('theme'), 'system');
});

for (const [name, value] of [['unknown string', 'sepia'], ['number', 7], ['object', {}], ['null', null]]) {
  test(`an invalid stored value means system: ${name}`, async () => {
    const { root, change } = runTheme({ mirror: 'dark', stored: { theme: value } });
    await settle();
    assert.equal(root.dataset.theme, 'system');
    change({ theme: { newValue: 'dark' } });
    change({ theme: { newValue: value } });
    assert.equal(root.dataset.theme, 'system');
  });
}

test('an invalid mirror means system', () => {
  const { root } = runTheme({ mirror: 'sepia' });
  assert.equal(root.dataset.theme, 'system');
});

test('a rejected read is logged and keeps the mirror', async () => {
  const { root, values, warnings } = runTheme({ mirror: 'dark', rejectGet: true });
  await settle();
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(values.get('theme'), 'dark');
  assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: load theme:']);
});

test('a throwing mirror read is logged and storage still applies', async () => {
  const { root, warnings, releaseLoad } = runTheme({ holdLoad: true, readFails: true, stored: { theme: 'dark' } });
  assert.equal(root.dataset.theme, undefined);
  assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: read theme mirror:']);
  releaseLoad();
  await settle();
  assert.equal(root.dataset.theme, 'dark');
});

test('a throwing mirror write is logged and data-theme still changes', async () => {
  const { root, values, warnings, change } = runTheme({ mirror: 'light', writeFails: true, stored: { theme: 'dark' } });
  await settle();
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(values.get('theme'), 'light');
  assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: write theme mirror:']);
  change({ theme: { newValue: 'system' } });
  assert.equal(root.dataset.theme, 'system');
  assert.equal(warnings.length, 2);
});
