'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { noteIdFromUrl } = require('../src/lib/notes.ts');
const { bundle } = require('./bundle.js');

const script = bundle('src/background.ts');

const DAY_MS = 86400000;
const CLOSE_SWEEP_MS = 600000;
const NOW = Date.UTC(2026, 9, 29);
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ID3 = '16fd2706-8baf-433b-82eb-8c7fada847da';

// settle lets pending promise chains in the script run to completion
const settle = () => new Promise((r) => setImmediate(r));

// runBackground evaluates the background bundle in a vm context with a
// browser stub, a fixed clock and recorded (never real) timers so node --test
// can exit. onRead runs after each get has taken its snapshot, so a test can
// land a write the script has not seen, and after each tabs.query too. tabs is
// what tabs.query returns, read at call time, and a function in reject decides
// by the call's arguments.
async function runBackground({ storage = {}, reject = {}, onRead = () => {}, tabs = [] } = {}) {
  const warnings = [];
  const calls = [];
  const intervals = [];
  const clicks = [];
  let now = NOW;
  // call records a browser API call and rejects when the test asked it to;
  // args are cloned into this realm so deepStrictEqual compares prototypes
  const call = async (name, ...args) => {
    calls.push(structuredClone([name, ...args]));
    const fails = typeof reject[name] === 'function' ? reject[name](...args) : reject[name];
    if (fails) throw new Error(`${name} rejected`);
  };
  const ctx = vm.createContext({
    console: { warn: (...a) => warnings.push(a) },
    Date: { now: () => now },
    URL,
    setInterval: (fn, delay) => intervals.push({ fn, delay }),
    setTimeout: () => assert.fail('setTimeout must not be used'),
    crypto: { randomUUID: () => ID },
    browser: {
      runtime: { getURL: (p) => `moz-extension://uuid/${p}` },
      browserAction: { onClicked: { addListener: (fn) => clicks.push(fn) } },
      tabs: {
        create: (props) => call('tabs.create', props),
        query: async (props) => {
          await call('tabs.query', props);
          const got = structuredClone(tabs);
          onRead();
          return got;
        },
      },
      storage: {
        local: {
          getKeys: async () => {
            await call('storage.local.getKeys');
            return Object.keys(storage);
          },
          get: async (keys) => {
            await call('storage.local.get', keys);
            const got = structuredClone(Object.fromEntries(keys.filter((k) => Object.hasOwn(storage, k)).map((k) => [k, storage[k]])));
            onRead();
            return got;
          },
          set: async (items) => {
            await call('storage.local.set', items);
            Object.assign(storage, structuredClone(items));
          },
          remove: async (keys) => {
            await call('storage.local.remove', keys);
            for (const key of keys) delete storage[key];
          },
        },
      },
    },
  });
  script.runInContext(ctx);
  await settle();
  const click = async (tab) => {
    for (const fn of clicks) fn(tab);
    await settle();
  };
  const of = (name) => calls.filter(([n]) => n === name);
  // fire runs the interval of the given delay with the clock at the given time
  const fire = async (delay, time) => {
    now = time;
    intervals.find((i) => i.delay === delay).fn();
    await settle();
  };
  // sweepAt runs the 24h purge, closeSweepAt the 10-minute close sweep
  const sweepAt = (time) => fire(DAY_MS, time);
  const closeSweepAt = (time) => fire(CLOSE_SWEEP_MS, time);
  return { warnings, calls, intervals, click, of, sweepAt, closeSweepAt };
}

const note = (deletedAt) => ({ title: 'Notes', content: 'x', updatedAt: 1, deletedAt });

test('toolbar click', async (t) => {
  await t.test('opens a note tab as a child next to the clicked-from tab', async () => {
    const { click, of, warnings } = await runBackground();
    await click({ id: 7, index: 3, windowId: 2 });
    const url = `moz-extension://uuid/note/note.html?id=${ID}`;
    assert.deepEqual(of('tabs.create'), [['tabs.create', { url, openerTabId: 7, windowId: 2, index: 4 }]]);
    // the note page must accept the URL it is opened with
    assert.equal(noteIdFromUrl(url, 'moz-extension://uuid/note/note.html'), ID);
    assert.deepEqual(warnings, []);
  });

  await t.test('the URL names no kind and reads nothing, as the note page takes it from settings', async () => {
    const { click, of, calls } = await runBackground({ storage: { settings: { temporary: true } } });
    calls.length = 0;
    await click({ id: 7, index: 3, windowId: 2 });
    assert.equal(of('tabs.create')[0][1].url, `moz-extension://uuid/note/note.html?id=${ID}`);
    assert.deepEqual(calls.map(([name]) => name), ['tabs.create']);
  });

  await t.test('rejected create is logged', async () => {
    const { click, warnings } = await runBackground({ reject: { 'tabs.create': true } });
    await click({ id: 7, index: 0 });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'tabnotes: open note tab:');
  });
});

test('purge', async (t) => {
  await t.test('removes only expired binned notes on load', async () => {
    const { of, warnings } = await runBackground({
      storage: {
        [`note:${ID}`]: note(NOW - 30 * DAY_MS),
        [`note:${ID2}`]: note(NOW - 30 * DAY_MS + 1),
        [`note:${ID3}`]: note(null),
        settings: { defaultTitle: 'Notes', deletedAt: 0 },
        notes: { 'https://a/': { title: '', content: 'x', updatedAt: 1, deletedAt: 0 } },
        'note:not-an-id': note(0),
      },
    });
    assert.deepEqual(of('storage.local.get'), [['storage.local.get', [`note:${ID}`, `note:${ID2}`, `note:${ID3}`, 'imageOrphans']]]);
    assert.deepEqual(of('storage.local.remove'), [['storage.local.remove', [`note:${ID}`]]]);
    assert.deepEqual(warnings, []);
  });

  await t.test('skips remove when nothing expired', async () => {
    const { of } = await runBackground({
      storage: { [`note:${ID}`]: note(NOW - DAY_MS), [`note:${ID2}`]: note(null) },
    });
    assert.deepEqual(of('storage.local.remove'), []);
  });

  await t.test('runs again every 24h', async () => {
    const storage = {};
    const { intervals, of, sweepAt } = await runBackground({ storage });
    assert.deepEqual(intervals.map((i) => i.delay), [DAY_MS, CLOSE_SWEEP_MS]);
    storage[`note:${ID}`] = note(NOW - 31 * DAY_MS);
    await sweepAt(NOW);
    assert.equal(of('storage.local.getKeys').length, 2);
    assert.equal(of('storage.local.get').length, 2);
    assert.deepEqual(of('storage.local.remove'), [['storage.local.remove', [`note:${ID}`]]]);
  });

  await t.test('requests only note keys, never an image value', async () => {
    const { of } = await runBackground({
      storage: {
        [`note:${ID}`]: note(null),
        [`image:${ID2}`]: { dataUrl: 'data:image/png;base64,AAAA' },
        imageOrphans: { [ID2]: 1 },
      },
    });
    const read = ['storage.local.get', [`note:${ID}`, 'imageOrphans']];
    // the second read comes before the image goes, as its grace is over
    assert.deepEqual(of('storage.local.get'), [read, read]);
  });

  await t.test('rejected key listing is logged and reads and removes nothing', async () => {
    const { of, warnings } = await runBackground({
      storage: { [`note:${ID}`]: note(0) },
      reject: { 'storage.local.getKeys': true },
    });
    assert.deepEqual(of('storage.local.get'), []);
    assert.deepEqual(of('storage.local.remove'), []);
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: list keys for purge:']);
  });

  await t.test('rejected load is logged and removes nothing', async () => {
    const { of, warnings } = await runBackground({
      storage: { [`note:${ID}`]: note(0) },
      reject: { 'storage.local.get': true },
    });
    assert.deepEqual(of('storage.local.remove'), []);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'tabnotes: load notes for purge:');
  });

  await t.test('rejected remove is logged', async () => {
    const { warnings } = await runBackground({
      storage: { [`note:${ID}`]: note(0) },
      reject: { 'storage.local.remove': true },
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], 'tabnotes: purge notes:');
  });
});

test('image sweep', async (t) => {
  const IMG = '9b2d3c1e-4f5a-4b6c-8d7e-0a1b2c3d4e5f';
  const IMG2 = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
  const IMAGE = { dataUrl: 'data:image/png;base64,AAAA' };
  const noteWith = (id, deletedAt = null) => ({ ...note(deletedAt), content: `![a](tabnotes-image:${id})` });
  const sets = (of) => of('storage.local.set').map(([, items]) => items);

  await t.test('runs when no note expired, records a new orphan and keeps it', async () => {
    const { of, warnings } = await runBackground({ storage: { [`image:${IMG}`]: IMAGE } });
    assert.deepEqual(sets(of), [{ imageOrphans: { [IMG]: NOW } }]);
    assert.deepEqual(of('storage.local.remove'), []);
    assert.deepEqual(warnings, []);
  });

  await t.test('keeps an old image at first sighting and removes it 7 days later', async () => {
    const storage = { [`image:${IMG}`]: IMAGE };
    const { of, sweepAt } = await runBackground({ storage });
    await sweepAt(NOW + 7 * DAY_MS - 1);
    assert.deepEqual(of('storage.local.remove'), []);
    assert.deepEqual(storage.imageOrphans, { [IMG]: NOW });
    await sweepAt(NOW + 7 * DAY_MS);
    assert.deepEqual(of('storage.local.remove'), [['storage.local.remove', [`image:${IMG}`]]]);
    assert.deepEqual(storage.imageOrphans, {});
  });

  await t.test('a referenced image leaves the map', async () => {
    const { of } = await runBackground({
      storage: {
        [`note:${ID}`]: noteWith(IMG),
        [`image:${IMG}`]: IMAGE,
        imageOrphans: { [IMG]: NOW - 30 * DAY_MS },
      },
    });
    assert.deepEqual(sets(of), [{ imageOrphans: {} }]);
    assert.deepEqual(of('storage.local.remove'), []);
  });

  await t.test('an image referenced only by a binned note stays', async () => {
    const { of } = await runBackground({
      storage: { [`note:${ID}`]: noteWith(IMG, NOW - DAY_MS), [`image:${IMG}`]: IMAGE },
    });
    assert.deepEqual(sets(of), []);
    assert.deepEqual(of('storage.local.remove'), []);
  });

  await t.test('an image of a note purged in this run becomes a new orphan', async () => {
    const { of } = await runBackground({
      storage: { [`note:${ID}`]: noteWith(IMG, NOW - 30 * DAY_MS), [`image:${IMG}`]: IMAGE },
    });
    assert.deepEqual(of('storage.local.remove'), [['storage.local.remove', [`note:${ID}`]]]);
    assert.deepEqual(sets(of), [{ imageOrphans: { [IMG]: NOW } }]);
  });

  await t.test('a note that failed to purge still references its image', async () => {
    const { of, warnings } = await runBackground({
      storage: { [`note:${ID}`]: noteWith(IMG, NOW - 30 * DAY_MS), [`image:${IMG}`]: IMAGE },
      reject: { 'storage.local.remove': true },
    });
    assert.deepEqual(sets(of), []);
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: purge notes:']);
  });

  await t.test('a failed read removes and writes nothing', async () => {
    const { of, warnings } = await runBackground({
      storage: { [`image:${IMG}`]: IMAGE, imageOrphans: { [IMG]: NOW - 30 * DAY_MS } },
      reject: { 'storage.local.get': true },
    });
    assert.deepEqual(of('storage.local.remove'), []);
    assert.deepEqual(sets(of), []);
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: load notes for purge:']);
  });

  await t.test('a failed key listing removes and writes nothing', async () => {
    const { of } = await runBackground({
      storage: { [`image:${IMG}`]: IMAGE, imageOrphans: { [IMG]: NOW - 30 * DAY_MS } },
      reject: { 'storage.local.getKeys': true },
    });
    assert.deepEqual(of('storage.local.remove'), []);
    assert.deepEqual(sets(of), []);
  });

  await t.test('a failed remove is logged and keeps the ids with their first sighting', async () => {
    const seen = NOW - 30 * DAY_MS;
    const { of, warnings } = await runBackground({
      storage: { [`image:${IMG}`]: IMAGE, [`image:${IMG2}`]: IMAGE, imageOrphans: { [IMG]: seen } },
      reject: { 'storage.local.remove': true },
    });
    assert.deepEqual(sets(of), [{ imageOrphans: { [IMG]: seen, [IMG2]: NOW } }]);
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: purge images:']);
  });

  await t.test('a failed remove alone does not rewrite the map', async () => {
    const { of } = await runBackground({
      storage: { [`image:${IMG}`]: IMAGE, imageOrphans: { [IMG]: NOW - 30 * DAY_MS } },
      reject: { 'storage.local.remove': true },
    });
    assert.equal(of('storage.local.remove').length, 1);
    assert.deepEqual(sets(of), []);
  });

  await t.test('an unchanged map is not written, whatever its key order', async () => {
    const { of } = await runBackground({
      storage: {
        [`image:${IMG}`]: IMAGE,
        [`image:${IMG2}`]: IMAGE,
        imageOrphans: { [IMG2]: NOW - DAY_MS, [IMG]: NOW - 2 * DAY_MS },
      },
    });
    assert.deepEqual(sets(of), []);
  });

  await t.test('a map of one size with other ids is written', async () => {
    const { of } = await runBackground({
      storage: {
        [`note:${ID}`]: noteWith(IMG),
        [`image:${IMG}`]: IMAGE,
        [`image:${IMG2}`]: IMAGE,
        imageOrphans: { [IMG]: NOW - DAY_MS },
      },
    });
    assert.deepEqual(sets(of), [{ imageOrphans: { [IMG2]: NOW } }]);
  });

  await t.test('a failed remove is retried by the next sweep', async () => {
    const reject = { 'storage.local.remove': true };
    const storage = { [`image:${IMG}`]: IMAGE, imageOrphans: { [IMG]: NOW - 30 * DAY_MS } };
    const { sweepAt } = await runBackground({ storage, reject });
    assert.ok(Object.hasOwn(storage, `image:${IMG}`));
    assert.deepEqual(storage.imageOrphans, { [IMG]: NOW - 30 * DAY_MS });
    reject['storage.local.remove'] = false;
    await sweepAt(NOW + DAY_MS);
    assert.equal(Object.hasOwn(storage, `image:${IMG}`), false);
    assert.deepEqual(storage.imageOrphans, {});
  });

  await t.test('one run removes an expired note and an expired image', async () => {
    const { of } = await runBackground({
      storage: {
        [`note:${ID}`]: note(NOW - 30 * DAY_MS),
        [`image:${IMG}`]: IMAGE,
        imageOrphans: { [IMG]: NOW - 30 * DAY_MS },
      },
    });
    assert.deepEqual(of('storage.local.remove'), [
      ['storage.local.remove', [`note:${ID}`]],
      ['storage.local.remove', [`image:${IMG}`]],
    ]);
    assert.deepEqual(sets(of), [{ imageOrphans: {} }]);
  });

  await t.test('the read before removing an image', async (t) => {
    // once runs fn on the first read only: the sweep's decision is made on it
    const once = (fn) => {
      let done = false;
      return () => {
        if (!done) fn();
        done = true;
      };
    };
    const expiredImage = (extra = {}) => ({ [`image:${IMG}`]: IMAGE, imageOrphans: { [IMG]: NOW - 30 * DAY_MS }, ...extra });

    await t.test('comes right before the remove and sees no image value', async () => {
      const { calls } = await runBackground({ storage: expiredImage() });
      assert.deepEqual(calls.map(([name]) => name), [
        'storage.local.getKeys', 'storage.local.get',
        'storage.local.getKeys', 'storage.local.get',
        'storage.local.remove', 'storage.local.set',
      ]);
      assert.deepEqual(calls[3], ['storage.local.get', ['imageOrphans']]);
    });

    await t.test('is skipped when nothing goes', async () => {
      const { of } = await runBackground({ storage: { [`image:${IMG}`]: IMAGE } });
      assert.equal(of('storage.local.get').length, 1);
    });

    const savers = [
      { name: 'an existing note', extra: { [`note:${ID}`]: note(null) } },
      { name: 'a note saved for the first time', extra: {} },
    ];
    for (const c of savers) {
      await t.test(`keeps an image ${c.name} now references`, async () => {
        const storage = expiredImage(c.extra);
        const { of, warnings } = await runBackground({
          storage,
          onRead: once(() => {
            storage[`note:${ID}`] = noteWith(IMG);
          }),
        });
        assert.ok(Object.hasOwn(storage, `image:${IMG}`));
        assert.deepEqual(of('storage.local.remove'), []);
        assert.deepEqual(storage.imageOrphans, {});
        assert.deepEqual(warnings, []);
      });
    }

    await t.test('removes the other images of the sweep', async () => {
      const storage = expiredImage({ [`image:${IMG2}`]: IMAGE, imageOrphans: { [IMG]: 1, [IMG2]: 1 } });
      const { of } = await runBackground({
        storage,
        onRead: once(() => {
          storage[`note:${ID}`] = noteWith(IMG);
        }),
      });
      assert.deepEqual(of('storage.local.remove'), [['storage.local.remove', [`image:${IMG2}`]]]);
      assert.deepEqual(storage.imageOrphans, {});
    });

    await t.test('an image kept in the map that gains a reference leaves it, so its grace starts over', async () => {
      const firstSeen = NOW - 7 * DAY_MS + 1;
      const storage = expiredImage({ [`image:${IMG2}`]: IMAGE, imageOrphans: { [IMG]: 1, [IMG2]: firstSeen } });
      const { of, sweepAt } = await runBackground({
        storage,
        onRead: once(() => {
          storage[`note:${ID}`] = noteWith(IMG2);
        }),
      });
      assert.deepEqual(of('storage.local.remove'), [['storage.local.remove', [`image:${IMG}`]]]);
      assert.deepEqual(storage.imageOrphans, {});

      delete storage[`note:${ID}`];
      await sweepAt(NOW + DAY_MS);
      assert.ok(Object.hasOwn(storage, `image:${IMG2}`));
      assert.deepEqual(storage.imageOrphans, { [IMG2]: NOW + DAY_MS });
    });

    await t.test('a failed remove does not bring back an id that gained a reference', async () => {
      const storage = expiredImage({ [`image:${IMG2}`]: IMAGE, imageOrphans: { [IMG]: 1, [IMG2]: 1 } });
      await runBackground({
        storage,
        reject: { 'storage.local.remove': true },
        onRead: once(() => {
          storage[`note:${ID}`] = noteWith(IMG);
        }),
      });
      assert.deepEqual(storage.imageOrphans, { [IMG2]: 1 });
    });

    for (const name of ['storage.local.get', 'storage.local.getKeys']) {
      await t.test(`a failed ${name} removes nothing and keeps the first sighting`, async () => {
        const reject = {};
        // the second image would enter the map if the first sweep were written
        const storage = expiredImage({ [`image:${IMG2}`]: IMAGE });
        const { of, warnings } = await runBackground({
          storage,
          reject,
          onRead: once(() => {
            reject[name] = true;
          }),
        });
        assert.deepEqual(of('storage.local.remove'), []);
        assert.deepEqual(storage.imageOrphans, { [IMG]: NOW - 30 * DAY_MS });
        assert.deepEqual(sets(of), []);
        const what = name === 'storage.local.get' ? 'load notes' : 'list keys';
        assert.deepEqual(warnings.map((w) => w[0]), [`tabnotes: ${what} for image sweep:`]);
      });
    }

    await t.test('the next sweep removes an image kept by a failed read', async () => {
      const reject = {};
      const storage = expiredImage();
      const { sweepAt } = await runBackground({
        storage,
        reject,
        onRead: once(() => {
          reject['storage.local.get'] = true;
        }),
      });
      reject['storage.local.get'] = false;
      await sweepAt(NOW + DAY_MS);
      assert.equal(Object.hasOwn(storage, `image:${IMG}`), false);
    });
  });

  await t.test('no images and no map writes nothing', async () => {
    const { of } = await runBackground({ storage: { [`note:${ID}`]: note(null) } });
    assert.deepEqual(sets(of), []);
  });

  await t.test('an id whose image is gone leaves the map', async () => {
    const { of } = await runBackground({ storage: { imageOrphans: { [IMG]: NOW - DAY_MS } } });
    assert.deepEqual(sets(of), [{ imageOrphans: {} }]);
    assert.deepEqual(of('storage.local.remove'), []);
  });

  await t.test('a failed map write is logged', async () => {
    const { warnings } = await runBackground({
      storage: { [`image:${IMG}`]: IMAGE },
      reject: { 'storage.local.set': true },
    });
    assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: save image orphans:']);
  });

  await t.test('image values are never requested', async () => {
    const { of, sweepAt } = await runBackground({
      storage: {
        [`note:${ID}`]: noteWith(IMG),
        [`image:${IMG}`]: IMAGE,
        [`image:${IMG2}`]: IMAGE,
        imageOrphans: { [IMG2]: NOW - 30 * DAY_MS },
      },
    });
    await sweepAt(NOW + DAY_MS);
    const requested = of('storage.local.get').flatMap(([, keys]) => keys);
    assert.ok(requested.includes('imageOrphans'));
    assert.deepEqual(requested.filter((k) => k.startsWith('image:')), []);
  });
});

test('close sweep', async (t) => {
  const STALE = NOW - 30 * DAY_MS;
  const temp = (extra = {}) => ({ ...note(null), temporary: true, ...extra });
  const tab = (id) => ({ id: 1, url: `moz-extension://uuid/note/note.html?id=${id}` });
  const due = (extra = {}) => ({ [`note:${ID}`]: temp(), closedNotes: { [ID]: STALE }, ...extra });
  const sets = (of) => of('storage.local.set').map(([, items]) => items);

  await t.test('does not run at startup', async () => {
    const storage = due();
    const { of } = await runBackground({ storage });
    assert.deepEqual(of('tabs.query'), []);
    assert.equal(of('storage.local.get').flatMap(([, keys]) => keys).includes('closedNotes'), false);
    assert.deepEqual(sets(of), []);
    assert.equal(storage[`note:${ID}`].deletedAt, null);
  });

  await t.test('a closed temporary note enters the map, a permanent or open one does not', async () => {
    const storage = {
      [`note:${ID}`]: temp(),
      [`note:${ID2}`]: note(null),
      [`note:${ID3}`]: temp(),
      [`image:${ID}`]: { dataUrl: 'data:image/png;base64,AAAA' },
    };
    const tabs = [tab(ID3), { id: 2, url: 'https://a/' }, { id: 3 }];
    const { of, closeSweepAt, warnings } = await runBackground({ storage, tabs });
    await closeSweepAt(NOW);
    assert.deepEqual(storage.closedNotes, { [ID]: NOW });
    assert.deepEqual(of('tabs.query'), [['tabs.query', {}]]);
    assert.deepEqual(warnings, []);
    const requested = of('storage.local.get').flatMap(([, keys]) => keys);
    assert.deepEqual(requested.filter((k) => k.startsWith('image:')), []);
  });

  await t.test('an open tab clears the entry', async () => {
    const storage = { [`note:${ID}`]: temp(), closedNotes: { [ID]: NOW - DAY_MS } };
    const { closeSweepAt } = await runBackground({ storage, tabs: [tab(ID)] });
    await closeSweepAt(NOW);
    assert.deepEqual(storage.closedNotes, {});
  });

  await t.test('a note closed for 30 days is binned for 7 and leaves the map', async () => {
    const storage = due();
    const { closeSweepAt, warnings } = await runBackground({ storage });
    await closeSweepAt(NOW);
    assert.deepEqual(storage[`note:${ID}`], { ...temp(), deletedAt: NOW, binDays: 7 });
    assert.deepEqual(storage.closedNotes, {});
    assert.deepEqual(warnings, []);
  });

  await t.test('reads only the due notes and the tabs again before the write', async () => {
    const { calls, closeSweepAt } = await runBackground({ storage: due({ [`note:${ID2}`]: temp() }) });
    calls.length = 0;
    await closeSweepAt(NOW);
    assert.deepEqual(calls.map(([name]) => name), [
      'storage.local.getKeys', 'storage.local.get', 'tabs.query',
      'storage.local.get', 'tabs.query',
      'storage.local.set', 'storage.local.set',
    ]);
    assert.deepEqual(calls[3], ['storage.local.get', [`note:${ID}`]]);
  });

  await t.test('an auto-expired note is purged after its 7 days', async () => {
    const storage = due();
    const { closeSweepAt, sweepAt } = await runBackground({ storage });
    await closeSweepAt(NOW);
    await sweepAt(NOW + 7 * DAY_MS - 1);
    assert.ok(Object.hasOwn(storage, `note:${ID}`));
    await sweepAt(NOW + 7 * DAY_MS);
    assert.equal(Object.hasOwn(storage, `note:${ID}`), false);
  });

  await t.test('a stored note with neither field never expires, whatever the map holds', async () => {
    const storage = { [`note:${ID}`]: note(null), closedNotes: { [ID]: STALE } };
    const { closeSweepAt, sweepAt } = await runBackground({ storage });
    await closeSweepAt(NOW);
    assert.deepEqual(storage.closedNotes, {});
    await closeSweepAt(NOW + 3650 * DAY_MS);
    await sweepAt(NOW + 3650 * DAY_MS);
    assert.deepEqual(storage[`note:${ID}`], note(null));
    assert.deepEqual(storage.closedNotes, {});
  });

  await t.test('an unchanged map is not written', async () => {
    const closedNotes = { [ID]: NOW - DAY_MS };
    const { of, closeSweepAt } = await runBackground({ storage: { [`note:${ID}`]: temp(), closedNotes } });
    await closeSweepAt(NOW);
    assert.deepEqual(sets(of), []);
  });

  await t.test('no temporary notes and no map writes nothing', async () => {
    const { of, closeSweepAt } = await runBackground({ storage: { [`note:${ID}`]: note(null) } });
    await closeSweepAt(NOW);
    assert.deepEqual(sets(of), []);
  });

  await t.test('the read before binning', async (t) => {
    // land runs once after the sweep's first get and tabs.query, so the sweep
    // decides from snapshots without the change and only its re-check can see it
    const sweepWith = async (storage, tabs, land) => {
      let armed = false;
      let reads = 0;
      const run = await runBackground({
        storage,
        tabs,
        onRead: () => {
          if (armed && ++reads === 2) land();
        },
      });
      armed = true;
      await run.closeSweepAt(NOW);
      return run;
    };

    const cases = [
      { name: 'a note opened meanwhile', land: (storage, tabs) => tabs.push(tab(ID)) },
      { name: 'a note made permanent', land: (storage) => { storage[`note:${ID}`] = note(null); } },
      { name: 'a note binned by hand', land: (storage) => { storage[`note:${ID}`] = { ...temp(), deletedAt: NOW - 1 }; } },
      { name: 'a removed note', land: (storage) => { delete storage[`note:${ID}`]; } },
      { name: 'an edited note', land: (storage) => { storage[`note:${ID}`] = temp({ updatedAt: NOW }); } },
    ];
    for (const c of cases) {
      await t.test(`does not bin ${c.name}`, async () => {
        const storage = due();
        const tabs = [];
        const { of, warnings } = await sweepWith(storage, tabs, () => c.land(storage, tabs));
        assert.deepEqual(sets(of), [{ closedNotes: {} }]);
        assert.deepEqual(warnings, []);
      });
    }

    await t.test('does not bin a note binned on the first read and restored', async () => {
      const storage = due();
      storage[`note:${ID}`] = { ...temp(), deletedAt: NOW - DAY_MS };
      const { of } = await sweepWith(storage, [], () => {
        storage[`note:${ID}`] = temp();
      });
      assert.deepEqual(sets(of), [{ closedNotes: {} }]);
      assert.deepEqual(storage[`note:${ID}`], temp());
    });

    await t.test('bins the other due notes', async () => {
      const storage = due({ [`note:${ID2}`]: temp(), closedNotes: { [ID]: STALE, [ID2]: STALE } });
      const tabs = [];
      await sweepWith(storage, tabs, () => tabs.push(tab(ID)));
      assert.equal(storage[`note:${ID}`].deletedAt, null);
      assert.equal(storage[`note:${ID2}`].binDays, 7);
      assert.deepEqual(storage.closedNotes, {});
    });
  });

  await t.test('failures', async (t) => {
    const reads = [
      { key: 'storage.local.getKeys', msg: 'list keys for close sweep' },
      { key: 'storage.local.get', msg: 'load notes for close sweep' },
      { key: 'tabs.query', msg: 'list tabs for close sweep' },
    ];
    for (const c of reads) {
      await t.test(`a rejected ${c.key} writes nothing`, async () => {
        const reject = {};
        const { of, closeSweepAt, warnings } = await runBackground({ storage: due({ [`note:${ID2}`]: temp() }), reject });
        reject[c.key] = true;
        await closeSweepAt(NOW);
        assert.deepEqual(sets(of), []);
        assert.deepEqual(warnings.map((w) => w[0]), [`tabnotes: ${c.msg}:`]);
      });
    }

    const rereads = [
      { key: 'storage.local.get', msg: 'load due notes' },
      { key: 'tabs.query', msg: 'list tabs for due notes' },
    ];
    for (const c of rereads) {
      await t.test(`a rejected second ${c.key} writes nothing`, async () => {
        const reject = {};
        const { of, closeSweepAt, warnings } = await runBackground({ storage: due({ [`note:${ID2}`]: temp() }), reject });
        let seen = 0;
        reject[c.key] = () => ++seen === 2;
        await closeSweepAt(NOW);
        assert.deepEqual(sets(of), []);
        assert.deepEqual(warnings.map((w) => w[0]), [`tabnotes: ${c.msg}:`]);
      });
    }

    await t.test('a failed note write keeps its id, and the next sweep retries it', async () => {
      const reject = {};
      const storage = due({ [`note:${ID2}`]: temp(), closedNotes: { [ID]: STALE, [ID2]: STALE } });
      const { closeSweepAt, warnings } = await runBackground({ storage, reject });
      reject['storage.local.set'] = (items) => Object.hasOwn(items, `note:${ID}`);
      await closeSweepAt(NOW);
      assert.equal(storage[`note:${ID}`].deletedAt, null);
      assert.equal(storage[`note:${ID2}`].binDays, 7);
      assert.deepEqual(storage.closedNotes, { [ID]: STALE });
      assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: bin closed note:']);

      reject['storage.local.set'] = false;
      await closeSweepAt(NOW + 1);
      assert.equal(storage[`note:${ID}`].binDays, 7);
      assert.deepEqual(storage.closedNotes, {});
    });

    await t.test('a failed map write is logged', async () => {
      const reject = {};
      const { closeSweepAt, warnings } = await runBackground({ storage: { [`note:${ID}`]: temp() }, reject });
      reject['storage.local.set'] = true;
      await closeSweepAt(NOW);
      assert.deepEqual(warnings.map((w) => w[0]), ['tabnotes: save closed notes:']);
    });
  });
});
