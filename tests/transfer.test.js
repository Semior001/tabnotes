'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { deflateSync, unzipSync, zipSync } = require('fflate');
const { DEFAULT_TITLE, MAX_IMAGE_BYTES, MAX_IMPORT_BYTES, MAX_NOTE_BYTES, MAX_ZIP_ENTRIES, noteFile, zipEntries } = require('../src/lib/notes.ts');
const { bundle } = require('./bundle.js');

const script = bundle('src/transfer.ts', { globalName: 'transfer' });

// well in the past, as an import clamps times to the real clock
const NOW = Date.UTC(2020, 0, 1);
const ID1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ID3 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const ID4 = '9a1f4b7e-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const IMG1 = '886313e1-3b8a-4372-9b90-0c9aee199e5d';
const IMG2 = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const IMG3 = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
const IMG4 = 'e902893a-9d22-3c7e-a7b8-d6e313b71d9f';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
const TIFF = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0xff]);
const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const ref = (id) => `![x](tabnotes-image:${id})`;

// notes holds one note of each folder: a permanent one with a png, a
// temporary one with a tiff, and a binned one with no image
function notes() {
  return {
    [ID1]: { title: 'Shopping list', content: `milk\n${ref(IMG1)}\n`, updatedAt: NOW, deletedAt: null },
    [ID2]: { title: 'Scratch', content: `${ref(IMG2)}`, updatedAt: NOW - 1, deletedAt: null, temporary: true },
    [ID3]: { title: 'Old draft', content: 'gone', updatedAt: NOW - 2, deletedAt: NOW - 1, binDays: 7 },
  };
}

// fullStorage is notes plus their images, an unreferenced image and settings
function fullStorage() {
  const storage = { settings: { defaultTitle: 'Notes' } };
  for (const [id, note] of Object.entries(notes())) storage[`note:${id}`] = note;
  storage[`image:${IMG1}`] = { dataUrl: dataUrl('image/png', PNG) };
  storage[`image:${IMG2}`] = { dataUrl: dataUrl('image/tiff', TIFF) };
  storage[`image:${IMG3}`] = { dataUrl: dataUrl('image/png', PNG) };
  return storage;
}

// runTransfer evaluates the transfer bundle in a vm context with a browser
// stub, a fake document and recorded (never real) timers. A function in
// reject decides by the call's arguments.
function runTransfer({ storage = {}, reject = {}, tabs = [], onCall = () => {} } = {}) {
  const calls = [];
  const timers = [];
  const urls = { created: [], revoked: [] };
  const elements = [];
  const body = { children: [], append(...nodes) { this.children.push(...nodes); } };
  const call = async (name, ...args) => {
    calls.push(structuredClone([name, ...args]));
    onCall(name, ...args);
    const fails = typeof reject[name] === 'function' ? reject[name](...args) : reject[name];
    if (fails) throw new Error(`${name} rejected`);
  };
  const ctx = vm.createContext({
    Blob,
    crypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    URL: class extends URL {
      static createObjectURL(blob) {
        urls.created.push(blob);
        return `blob:moz-extension://uuid/${urls.created.length}`;
      }

      static revokeObjectURL(url) {
        urls.revoked.push(url);
      }
    },
    document: {
      body,
      createElement: (tag) => {
        const el = {
          tagName: tag.toUpperCase(),
          clicks: [],
          click() {
            this.clicks.push({ href: this.href, download: this.download, attached: body.children.includes(this) });
          },
          remove() {
            body.children = body.children.filter((c) => c !== this);
          },
        };
        elements.push(el);
        return el;
      },
    },
    browser: {
      storage: {
        local: {
          getKeys: async () => {
            await call('storage.local.getKeys');
            return Object.keys(storage);
          },
          get: async (keys) => {
            await call('storage.local.get', keys);
            return structuredClone(Object.fromEntries(keys.filter((k) => Object.hasOwn(storage, k)).map((k) => [k, storage[k]])));
          },
          set: async (items) => {
            await call('storage.local.set', items);
            Object.assign(storage, structuredClone(items));
          },
        },
      },
      tabs: {
        query: async (query) => {
          await call('tabs.query', query);
          return structuredClone(tabs);
        },
      },
      runtime: { getURL: (path) => `moz-extension://uuid/${path}` },
    },
  });
  script.runInContext(ctx);
  return { transfer: ctx.transfer, calls, timers, urls, body, elements };
}

const entries = async (blob) => unzipSync(new Uint8Array(await blob.arrayBuffer()));
const text = (bytes) => new TextDecoder().decode(bytes);
const pngLink = (id) => `![x](../images/${id}.png)`;

test('exportZip', async (t) => {
  await t.test('all notes go to their folders by file name, with each referenced image once and links rewritten', async () => {
    const { transfer } = runTransfer({ storage: fullStorage() });
    const before = new Date();
    const got = await transfer.exportZip(null);
    const files = await entries(got.blob);
    assert.deepEqual(Object.keys(files), [
      'bin/Old draft.md',
      `images/${IMG1}.png`,
      `images/${IMG2}.tiff`,
      'permanent/Shopping list.md',
      'temporary/Scratch.md',
    ]);
    const n = notes();
    assert.equal(text(files['permanent/Shopping list.md']), noteFile(ID1, n[ID1], `milk\n${pngLink(IMG1)}\n`));
    assert.equal(text(files['temporary/Scratch.md']), noteFile(ID2, n[ID2], `![x](../images/${IMG2}.tiff)`));
    assert.equal(text(files['bin/Old draft.md']), noteFile(ID3, n[ID3], 'gone'));
    assert.deepEqual(files[`images/${IMG1}.png`], PNG);
    assert.deepEqual(files[`images/${IMG2}.tiff`], TIFF);
    assert.equal(got.notes, 3);
    assert.deepEqual([...got.broken], []);
    assert.equal(got.blob.type, 'application/zip');
    const pad = (v) => String(v).padStart(2, '0');
    const name = (d) => `tabnotes-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;
    assert.ok([name(before), name(new Date())].includes(got.name), got.name);
  });

  await t.test('a selection exports only those notes and their images, a binned one included', async () => {
    const { transfer } = runTransfer({ storage: fullStorage() });
    const files = await entries((await transfer.exportZip([ID2, ID3])).blob);
    assert.deepEqual(Object.keys(files), ['bin/Old draft.md', `images/${IMG2}.tiff`, 'temporary/Scratch.md']);
  });

  await t.test('the same storage gives the same zip bytes', async () => {
    const a = await runTransfer({ storage: fullStorage() }).transfer.exportZip(null);
    const b = await runTransfer({ storage: fullStorage() }).transfer.exportZip(null);
    assert.deepEqual(new Uint8Array(await a.blob.arrayBuffer()), new Uint8Array(await b.blob.arrayBuffer()));
  });

  await t.test('reads keys first, never all of storage, and each referenced image alone', async () => {
    const { transfer, calls } = runTransfer({ storage: fullStorage() });
    await transfer.exportZip(null);
    assert.deepEqual(calls, [
      ['storage.local.getKeys'],
      ['storage.local.get', [`note:${ID1}`, `note:${ID2}`, `note:${ID3}`, 'settings']],
      ['storage.local.get', [`image:${IMG1}`]],
      ['storage.local.get', [`image:${IMG2}`]],
    ]);
  });

  await t.test('a referenced image that is not stored is left out and its reference kept', async () => {
    const storage = { [`note:${ID1}`]: { title: 'A', content: `${ref(IMG4)} ${ref(IMG1)}`, updatedAt: NOW, deletedAt: null } };
    storage[`image:${IMG1}`] = { dataUrl: dataUrl('image/png', PNG) };
    const { transfer, calls } = runTransfer({ storage });
    const got = await transfer.exportZip(null);
    const files = await entries(got.blob);
    assert.deepEqual(Object.keys(files), [`images/${IMG1}.png`, 'permanent/A.md']);
    assert.match(text(files['permanent/A.md']), new RegExp(`\\(tabnotes-image:${IMG4}\\) !\\[x\\]\\(\\.\\./images/${IMG1}\\.png\\)`));
    assert.ok(!calls.some(([name, keys]) => name === 'storage.local.get' && keys.includes(`image:${IMG4}`)));
    assert.deepEqual([...got.broken], []);
  });

  await t.test('an image whose data URL does not decode is left out and named', async () => {
    const storage = fullStorage();
    storage[`image:${IMG1}`] = { dataUrl: 'data:image/png;base64,%%%' };
    storage[`image:${IMG2}`] = { dataUrl: 'data:text/plain;base64,AAAA' };
    const { transfer } = runTransfer({ storage });
    const got = await transfer.exportZip(null);
    const files = await entries(got.blob);
    assert.deepEqual(Object.keys(files), ['bin/Old draft.md', 'permanent/Shopping list.md', 'temporary/Scratch.md']);
    assert.match(text(files['permanent/Shopping list.md']), new RegExp(`\\(tabnotes-image:${IMG1}\\)`));
    assert.deepEqual([...got.broken], [IMG1, IMG2]);
  });

  await t.test('a note titled the default of settings is named by its content', async () => {
    const storage = {
      settings: { defaultTitle: 'Inbox' },
      [`note:${ID1}`]: { title: 'Inbox', content: '# Heading\ntext', updatedAt: NOW, deletedAt: null },
      [`note:${ID2}`]: { title: DEFAULT_TITLE, content: 'first line', updatedAt: NOW - 1, deletedAt: null },
    };
    const files = await entries((await runTransfer({ storage }).transfer.exportZip(null)).blob);
    assert.deepEqual(Object.keys(files), ['permanent/Heading.md', 'permanent/first line.md']);
  });

  await t.test('with no settings key only the built-in default title is a default', async () => {
    const storage = {
      [`note:${ID1}`]: { title: 'Inbox', content: '# Heading', updatedAt: NOW, deletedAt: null },
      [`note:${ID2}`]: { title: DEFAULT_TITLE, content: 'first line', updatedAt: NOW - 1, deletedAt: null },
    };
    const files = await entries((await runTransfer({ storage }).transfer.exportZip(null)).blob);
    assert.deepEqual(Object.keys(files), ['permanent/Inbox.md', 'permanent/first line.md']);
  });

  await t.test('an image removed between the key list and its read is left out, not named', async () => {
    const storage = fullStorage();
    const onCall = (name, keys) => {
      if (name === 'storage.local.get' && keys.includes('settings')) delete storage[`image:${IMG1}`];
    };
    const got = await runTransfer({ storage, onCall }).transfer.exportZip(null);
    const files = await entries(got.blob);
    assert.ok(!Object.hasOwn(files, `images/${IMG1}.png`));
    assert.match(text(files['permanent/Shopping list.md']), new RegExp(`\\(tabnotes-image:${IMG1}\\)`));
    assert.deepEqual([...got.broken], []);
  });

  await t.test('a stored image whose dataUrl is no string is named', async () => {
    const storage = fullStorage();
    storage[`image:${IMG1}`] = { dataUrl: 5 };
    const got = await runTransfer({ storage }).transfer.exportZip(null);
    assert.deepEqual([...got.broken], [IMG1]);
  });

  await t.test('a selected id with no stored note is not counted', async () => {
    const got = await runTransfer({ storage: fullStorage() }).transfer.exportZip([ID1, ID4]);
    assert.equal(got.notes, 1);
    assert.deepEqual(Object.keys(await entries(got.blob)), [`images/${IMG1}.png`, 'permanent/Shopping list.md']);
  });

  const failures = {
    'the key list': { 'storage.local.getKeys': true },
    'the notes': { 'storage.local.get': (keys) => keys.includes('settings') },
    'an image': { 'storage.local.get': (keys) => keys.includes(`image:${IMG2}`) },
  };
  for (const [what, reject] of Object.entries(failures)) {
    await t.test(`a failed read of ${what} rejects with no zip`, async () => {
      const { transfer, urls } = runTransfer({ storage: fullStorage(), reject });
      await assert.rejects(transfer.exportZip(null), (err) => err.cause instanceof Error && /rejected/.test(err.cause.message));
      assert.deepEqual(urls.created, []);
    });
  }
});

test('saveBlob clicks an attached <a download> and revokes its URL only after a delay', () => {
  const { transfer, timers, urls, body, elements } = runTransfer();
  const blob = new Blob(['zip']);
  transfer.saveBlob(blob, 'tabnotes-2026-11-02.zip');
  assert.equal(urls.created.length, 1);
  assert.equal(urls.created[0], blob);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].tagName, 'A');
  assert.deepEqual(elements[0].clicks, [{ href: 'blob:moz-extension://uuid/1', download: 'tabnotes-2026-11-02.zip', attached: true }]);
  assert.deepEqual(body.children, []);
  assert.deepEqual(urls.revoked, []);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay >= 60000);
  timers[0].fn();
  assert.deepEqual(urls.revoked, ['blob:moz-extension://uuid/1']);
});

const enc = (s) => new TextEncoder().encode(s);
const plain = (value) => JSON.parse(JSON.stringify(value));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// zipOf zips entries of path to text, bytes or [data, fflate options],
// stored unless an entry asks for deflate
function zipOf(entries) {
  const files = {};
  for (const [path, v] of Object.entries(entries)) {
    const [data, opts] = Array.isArray(v) ? v : [v, {}];
    files[path] = [typeof data === 'string' ? enc(data) : data, opts];
  }
  return zipSync(files, { level: 0 });
}

// rawZip zips deflate entries of { name, data, originalSize } with data the
// raw stream as given; with shared, every central entry points at the local
// header of the first
function rawZip(files, { shared = false } = {}) {
  const locals = shared ? files.slice(0, 1) : files;
  const names = files.map((f) => enc(f.name));
  const localSize = locals.reduce((sum, f, i) => sum + 30 + names[i].length + f.data.length, 0);
  const centralSize = names.reduce((sum, name) => sum + 46 + name.length, 0);
  const zip = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(zip.buffer);
  const offsets = [];
  let o = 0;
  locals.forEach((f, i) => {
    offsets.push(o);
    view.setUint32(o, 0x04034b50, true);
    view.setUint16(o + 8, 8, true);
    view.setUint32(o + 18, f.data.length, true);
    view.setUint32(o + 22, f.originalSize, true);
    view.setUint16(o + 26, names[i].length, true);
    zip.set(names[i], o + 30);
    zip.set(f.data, o + 30 + names[i].length);
    o += 30 + names[i].length + f.data.length;
  });
  files.forEach((f, i) => {
    view.setUint32(o, 0x02014b50, true);
    view.setUint16(o + 10, 8, true);
    view.setUint32(o + 20, f.data.length, true);
    view.setUint32(o + 24, f.originalSize, true);
    view.setUint16(o + 28, names[i].length, true);
    view.setUint32(o + 42, offsets[shared ? 0 : i], true);
    zip.set(names[i], o + 46);
    o += 46 + names[i].length;
  });
  view.setUint32(o, 0x06054b50, true);
  view.setUint16(o + 8, files.length, true);
  view.setUint16(o + 10, files.length, true);
  view.setUint32(o + 12, centralSize, true);
  view.setUint32(o + 16, localSize, true);
  return zip;
}

// emptyBlocks is a deflate stream of n empty stored blocks and a final one,
// which inflates to nothing however long it is
function emptyBlocks(n) {
  const out = new Uint8Array(5 * (n + 1));
  for (let i = 0; i <= n; i++) out.set([i === n ? 1 : 0, 0, 0, 0xff, 0xff], 5 * i);
  return out;
}

// centralHeaders returns the offsets of the central directory headers of zip,
// where fflate reads names and declared sizes
function centralHeaders(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const out = [];
  let o = view.getUint32(end + 16, true);
  for (let i = view.getUint16(end + 10, true); i > 0; i--) {
    out.push(o);
    o += 46 + view.getUint16(o + 28, true) + view.getUint16(o + 30, true) + view.getUint16(o + 32, true);
  }
  return out;
}

// declare overwrites what the central directory says of entry index
function declare(zip, index, { size, originalSize, name }) {
  const o = centralHeaders(zip)[index];
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (size !== undefined) view.setUint32(o + 20, size, true);
  if (originalSize !== undefined) view.setUint32(o + 24, originalSize, true);
  if (name !== undefined) zip.set(enc(name), o + 46);
  return zip;
}

// corrupt makes the deflate data of entry index an invalid block type
function corrupt(zip, index) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const local = view.getUint32(centralHeaders(zip)[index] + 42, true);
  zip[local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)] = 0xff;
  return zip;
}

// zip64 rewrites the end of zip as a zip64 writer does: a zip64 end record
// and locator claiming count entries (the real count by default), and for the
// entries in wide, sizes and local header offset of 0xffffffff in the central
// header with the real values in a zip64 extra field
function zip64(zip, { count, wide = [] } = {}) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const heads = centralHeaders(zip);
  const cdStart = heads[0];
  const parts = [zip.subarray(0, cdStart)];
  for (const [i, o] of heads.entries()) {
    const n = view.getUint16(o + 28, true);
    const m = view.getUint16(o + 30, true);
    const k = view.getUint16(o + 32, true);
    const head = zip.slice(o, o + 46 + n + m + k);
    if (!wide.includes(i)) {
      parts.push(head);
      continue;
    }
    const extra = new DataView(new ArrayBuffer(28));
    extra.setUint16(0, 1, true);
    extra.setUint16(2, 24, true);
    extra.setBigUint64(4, BigInt(view.getUint32(o + 24, true)), true);
    extra.setBigUint64(12, BigInt(view.getUint32(o + 20, true)), true);
    extra.setBigUint64(20, BigInt(view.getUint32(o + 42, true)), true);
    const hv = new DataView(head.buffer);
    for (const at of [20, 24, 42]) hv.setUint32(at, 0xffffffff, true);
    hv.setUint16(30, m + 28, true);
    parts.push(head.subarray(0, 46 + n + m), new Uint8Array(extra.buffer), head.subarray(46 + n + m));
  }
  const cdEnd = cdStart + parts.slice(1).reduce((sum, p) => sum + p.length, 0);
  const tail = new DataView(new ArrayBuffer(56 + 20 + 22));
  tail.setUint32(0, 0x06064b50, true);
  tail.setBigUint64(4, 44n, true);
  tail.setBigUint64(24, BigInt(count ?? heads.length), true);
  tail.setBigUint64(32, BigInt(count ?? heads.length), true);
  tail.setBigUint64(40, BigInt(cdEnd - cdStart), true);
  tail.setBigUint64(48, BigInt(cdStart), true);
  tail.setUint32(56, 0x07064b50, true);
  tail.setBigUint64(64, BigInt(cdEnd), true);
  tail.setUint32(72, 1, true);
  tail.setUint32(76, 0x06054b50, true);
  tail.setUint16(84, 0xffff, true);
  tail.setUint16(86, 0xffff, true);
  tail.setUint32(88, 0xffffffff, true);
  tail.setUint32(92, 0xffffffff, true);
  parts.push(new Uint8Array(tail.buffer));
  return new Uint8Array(Buffer.concat(parts));
}

// fflateEntries is what fflate's unzipSync reads of the central directory
function fflateEntries(zip) {
  const out = [];
  unzipSync(zip, {
    filter: ({ name, compression, size, originalSize }) => (out.push({ name, compression, size, originalSize }), false),
  });
  return out;
}

test('zipEntries', async (t) => {
  const files = { 'a.md': 'stored', 'b/\u00e9.md': ['x'.repeat(100), { level: 6 }], [`images/${IMG1}.png`]: PNG };
  const fields = (entries) => entries.map(({ name, compression, size, originalSize }) => ({ name, compression, size, originalSize }));

  await t.test('reads the central directory as fflate does', () => {
    const zip = zipOf(files);
    const got = zipEntries(zip);
    assert.deepEqual(fields(got), fflateEntries(zip));
    assert.equal(got[1].name, 'b/\u00e9.md');
    assert.deepEqual([...got[0].data], [...enc('stored')]);
    assert.deepEqual([...got[2].data], [...PNG]);
  });

  await t.test('a name without the UTF-8 flag is read as latin1, as fflate does', () => {
    const zip = zipOf(files);
    const o = centralHeaders(zip)[1];
    zip[o + 9] &= ~0x08;
    assert.equal(zipEntries(zip)[1].name, 'b/\u00c3\u00a9.md');
    assert.deepEqual(fields(zipEntries(zip)), fflateEntries(zip));
  });

  await t.test('a zip64 end record and zip64 extra fields', () => {
    const zip = zip64(zipOf(files), { wide: [0, 2] });
    assert.deepEqual(unzipSync(zip), unzipSync(zipOf(files)));
    const got = zipEntries(zip);
    assert.deepEqual(fields(got), fflateEntries(zip));
    assert.deepEqual([...got[0].data], [...enc('stored')]);
    assert.deepEqual([...got[2].data], [...PNG]);
  });

  await t.test('a zip64 entry with no zip64 extra field is not a zip', () => {
    const plainZip = zipOf(files);
    new DataView(plainZip.buffer).setUint32(centralHeaders(plainZip)[0] + 20, 0xffffffff, true);
    const zip = zip64(plainZip);
    assert.throws(() => fflateEntries(zip));
    assert.equal(zipEntries(zip), 'not a zip');
  });

  await t.test('a zip64 record claiming more entries than the limit, checked before the walk', () => {
    for (const count of [MAX_ZIP_ENTRIES + 1, 50_000_000, 2 ** 32 - 1, 2 ** 40]) {
      const started = Date.now();
      assert.equal(zipEntries(zip64(zipOf({ 'a.md': 'a' }), { count })), 'too many files', String(count));
      assert.ok(Date.now() - started < 1000);
    }
  });

  await t.test('a count past the entries the zip holds is not a zip', () => {
    assert.equal(zipEntries(zip64(zipOf({ 'a.md': 'a' }), { count: MAX_ZIP_ENTRIES })), 'not a zip');
    const zip = zipOf({ 'a.md': 'a' });
    new DataView(zip.buffer).setUint16(zip.length - 12, 2, true);
    assert.equal(zipEntries(zip), 'not a zip');
  });

  await t.test('no end record is not a zip', () => {
    assert.equal(zipEntries(enc('hello')), 'not a zip');
    assert.equal(zipEntries(new Uint8Array(0)), 'not a zip');
    assert.equal(zipEntries(new Uint8Array(70_000)), 'not a zip');
  });

  await t.test('entries whose local header and data overlap are not a zip', () => {
    const shared = zipOf({ 'a.md': 'a', 'b.md': 'b' });
    new DataView(shared.buffer).setUint32(centralHeaders(shared)[1] + 42, 0, true);
    assert.equal(zipEntries(shared), 'not a zip');
    // data of the first reaching one byte into the local header of the second
    const reaching = zipOf({ 'a.md': 'a', 'b.md': 'b' });
    assert.notEqual(zipEntries(reaching), 'not a zip');
    new DataView(reaching.buffer).setUint32(centralHeaders(reaching)[0] + 20, 2, true);
    assert.equal(zipEntries(reaching), 'not a zip');
  });

  await t.test('an entry whose local header or data lies past the end has no data', () => {
    const zip = zipOf({ 'a.md': 'a', 'b.md': 'b' });
    const view = new DataView(zip.buffer);
    view.setUint32(centralHeaders(zip)[0] + 42, zip.length - 10, true);
    view.setUint32(centralHeaders(zip)[1] + 20, zip.length, true);
    const got = zipEntries(zip);
    assert.equal(got[0].data, null);
    assert.equal(got[1].data, null);
  });
});

const backup = async (storage) => {
  const got = await runTransfer({ storage }).transfer.exportZip(null);
  return new File([await got.blob.arrayBuffer()], got.name);
};
const storedNotes = (storage) => Object.fromEntries(Object.entries(storage).filter(([k]) => k.startsWith('note:')));
const sets = (calls) => calls.filter(([name]) => name === 'storage.local.set').map(([, items]) => Object.keys(items));
const goodNote = { title: 'Good', content: 'good', updatedAt: NOW, deletedAt: null };
const good = noteFile(ID1, goodNote, 'good');
const restorable = () => {
  const want = fullStorage();
  delete want.settings;
  delete want[`image:${IMG3}`];
  return want;
};

test('importFiles round trip', async (t) => {
  await t.test('an export imported into empty storage gives the same notes, ids and images', async () => {
    const source = fullStorage();
    const header = noteFile(ID4, { title: 'Big', content: '', updatedAt: NOW, deletedAt: null }, '').length;
    source[`note:${ID4}`] = { title: 'Big', content: 'a'.repeat(MAX_NOTE_BYTES - header), updatedAt: NOW, deletedAt: null };
    const zip = await backup(source);
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([zip]));
    assert.deepEqual(got, { imported: 4, images: 2, identical: 0, copies: 0, rejected: {} });
    assert.deepEqual(storage, { ...restorable(), [`note:${ID4}`]: source[`note:${ID4}`] });
  });

  await t.test('the same zip imported twice writes nothing the second time', async () => {
    const zip = await backup(fullStorage());
    const storage = {};
    await runTransfer({ storage }).transfer.importFiles([zip]);
    const again = runTransfer({ storage });
    const got = plain(await again.transfer.importFiles([zip]));
    assert.deepEqual(got, { imported: 0, images: 0, identical: 3, copies: 0, rejected: {} });
    assert.deepEqual(sets(again.calls), []);
  });

  await t.test('after a local edit, importing the same zip twice creates one copy', async () => {
    const zip = await backup(fullStorage());
    const storage = {};
    await runTransfer({ storage }).transfer.importFiles([zip]);
    storage[`note:${ID1}`] = { ...storage[`note:${ID1}`], content: 'edited' };
    const first = plain(await runTransfer({ storage }).transfer.importFiles([zip]));
    assert.deepEqual(first, { imported: 1, images: 0, identical: 2, copies: 1, rejected: {} });
    const second = plain(await runTransfer({ storage }).transfer.importFiles([zip]));
    assert.deepEqual(second, { imported: 0, images: 0, identical: 3, copies: 0, rejected: {} });
    assert.equal(Object.keys(storedNotes(storage)).length, 4);
    assert.equal(storage[`note:${ID1}`].content, 'edited');
  });

  await t.test('a file moved to another folder keeps the state of its front matter', async () => {
    const binned = notes()[ID3];
    const storage = {};
    const file = new File([zipOf({ 'permanent/Old draft.md': noteFile(ID3, binned, 'gone') })], 'b.zip');
    await runTransfer({ storage }).transfer.importFiles([file]);
    assert.deepEqual(storage, { [`note:${ID3}`]: binned });
  });

  await t.test('a backup with CRLF line endings imports as the same notes', async () => {
    const files = unzipSync(new Uint8Array(await (await backup(fullStorage())).arrayBuffer()));
    for (const path of Object.keys(files)) {
      if (path.endsWith('.md')) files[path] = enc(new TextDecoder().decode(files[path]).replace(/\n/g, '\r\n'));
    }
    const storage = {};
    await runTransfer({ storage }).transfer.importFiles([new File([zipOf(files)], 'crlf.zip')]);
    assert.deepEqual(storage, restorable());
  });
});

test('importFiles collisions', async (t) => {
  const zip = () => new File([zipOf({ 'permanent/Good.md': good })], 'b.zip');
  const copyOnly = (storage) => {
    const keys = Object.keys(storedNotes(storage)).filter((k) => k !== `note:${ID1}`);
    assert.equal(keys.length, 1);
    assert.deepEqual(storage[keys[0]], { ...goodNote, title: 'Good (imported)' });
  };

  await t.test('changed content becomes a copy and the local note stays as it is', async () => {
    const local = { title: 'Mine', content: 'mine', updatedAt: NOW + 5, deletedAt: null };
    const storage = { [`note:${ID1}`]: local };
    const got = plain(await runTransfer({ storage }).transfer.importFiles([zip()]));
    assert.deepEqual(got, { imported: 1, images: 0, identical: 0, copies: 1, rejected: {} });
    assert.deepEqual(storage[`note:${ID1}`], local);
    copyOnly(storage);
  });

  await t.test('an id with no key but an open note tab becomes a copy', async () => {
    const storage = {};
    const tabs = [{ id: 1, url: `moz-extension://uuid/note/note.html?id=${ID1}` }];
    await runTransfer({ storage, tabs }).transfer.importFiles([zip()]);
    assert.equal(storage[`note:${ID1}`], undefined);
    copyOnly(storage);
  });

  await t.test('an id stored between the first read and the note write becomes a copy', async () => {
    const storage = {};
    const local = { title: 'Mine', content: 'typed meanwhile', updatedAt: NOW, deletedAt: null };
    let lists = 0;
    const onCall = (name) => {
      if (name === 'storage.local.getKeys' && ++lists === 2) storage[`note:${ID1}`] = local;
    };
    const got = plain(await runTransfer({ storage, onCall }).transfer.importFiles([zip()]));
    assert.equal(lists, 2);
    assert.deepEqual(got, { imported: 1, images: 0, identical: 0, copies: 1, rejected: {} });
    assert.deepEqual(storage[`note:${ID1}`], local);
    copyOnly(storage);
  });

  await t.test('a key stored meanwhile with the same content counts as present, not as a copy', async () => {
    const storage = {};
    let lists = 0;
    const onCall = (name) => {
      if (name === 'storage.local.getKeys' && ++lists === 2) storage[`note:${ID1}`] = goodNote;
    };
    const { transfer, calls } = runTransfer({ storage, onCall });
    const got = plain(await transfer.importFiles([zip()]));
    assert.deepEqual(got, { imported: 0, images: 0, identical: 1, copies: 0, rejected: {} });
    assert.deepEqual(sets(calls), []);
    assert.deepEqual(storedNotes(storage), { [`note:${ID1}`]: goodNote });
  });

  await t.test('an image already stored is not written again', async () => {
    const local = { dataUrl: dataUrl('image/png', Uint8Array.from([1, 2, 3])) };
    const storage = { [`image:${IMG1}`]: local };
    const file = new File([zipOf({
      'permanent/Shopping list.md': noteFile(ID1, notes()[ID1], `milk\n${pngLink(IMG1)}\n`),
      [`images/${IMG1}.png`]: PNG,
    })], 'b.zip');
    const { transfer, calls } = runTransfer({ storage });
    const got = plain(await transfer.importFiles([file]));
    assert.deepEqual(got, { imported: 1, images: 0, identical: 0, copies: 0, rejected: {} });
    assert.deepEqual(sets(calls), [[`note:${ID1}`]]);
    assert.deepEqual(storage[`image:${IMG1}`], local);
  });

  await t.test('an image referenced only by a note already present is restored if missing', async () => {
    const storage = { [`note:${ID2}`]: notes()[ID1] };
    const file = new File([zipOf({
      'permanent/Shopping list.md': noteFile(ID1, notes()[ID1], `milk\n${pngLink(IMG1)}\n`),
      [`images/${IMG1}.png`]: PNG,
    })], 'b.zip');
    const { transfer, calls } = runTransfer({ storage });
    const got = plain(await transfer.importFiles([file]));
    assert.deepEqual(got, { imported: 0, images: 1, identical: 1, copies: 0, rejected: {} });
    assert.deepEqual(sets(calls), [[`image:${IMG1}`]]);
    assert.deepEqual(storage[`image:${IMG1}`], { dataUrl: dataUrl('image/png', PNG) });
  });
});

test('importFiles duplicates', async (t) => {
  const other = { ...goodNote, content: 'other' };

  await t.test('one id under two paths of a zip: the first path wins, whatever the entry order', async () => {
    const storage = {};
    const file = new File([zipOf({ 'b/X.md': noteFile(ID1, other, 'other'), 'a/X.md': good })], 'b.zip');
    const got = plain(await runTransfer({ storage }).transfer.importFiles([file]));
    assert.deepEqual(got, { imported: 1, images: 0, identical: 0, copies: 0, rejected: { 'duplicate id': 1 } });
    assert.deepEqual(storage, { [`note:${ID1}`]: goodNote });
  });

  await t.test('one id in two picked files: the first file wins', async () => {
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([
      new File([noteFile(ID1, other, 'other')], 'B.md'),
      new File([good], 'A.md'),
    ]));
    assert.deepEqual(got.rejected, { 'duplicate id': 1 });
    assert.deepEqual(storage, { [`note:${ID1}`]: other });
  });

  await t.test('one image id under two names: the first is stored', async () => {
    const storage = {};
    const file = new File([zipOf({
      'permanent/Pic.md': noteFile(ID1, goodNote, `![x](../images/${IMG1}.png)`),
      [`images/${IMG1}.png`]: PNG,
      [`images/${IMG1}.tiff`]: TIFF,
    })], 'b.zip');
    const got = plain(await runTransfer({ storage }).transfer.importFiles([file]));
    assert.deepEqual(got, { imported: 1, images: 1, identical: 0, copies: 0, rejected: { 'duplicate image': 1 } });
    assert.deepEqual(storage[`image:${IMG1}`], { dataUrl: dataUrl('image/png', PNG) });
  });
});

test('importFiles re-zipped exports', async (t) => {
  await t.test('an export zipped again under one folder keeps its images', async () => {
    const files = unzipSync(new Uint8Array(await (await backup(fullStorage())).arrayBuffer()));
    const nested = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [`tabnotes-2026-11-02/${path}`, bytes]));
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zipOf(nested)], 'again.zip')]));
    assert.deepEqual(got, { imported: 3, images: 2, identical: 0, copies: 0, rejected: {} });
    assert.deepEqual(storage, restorable());
  });

  await t.test('an export zipped again by bsdtar from inside its folder keeps its images', async () => {
    // bsdtar -a -cf again.zip . names every entry ./ first, the folder too
    const files = unzipSync(new Uint8Array(await (await backup(fullStorage())).arrayBuffer()));
    const dotted = { './': new Uint8Array(0), './images/': new Uint8Array(0) };
    for (const [path, bytes] of Object.entries(files)) dotted[`./${path}`] = bytes;
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zipOf(dotted)], 'again.zip')]));
    assert.deepEqual(got, { imported: 3, images: 2, identical: 0, copies: 0, rejected: {} });
    assert.deepEqual(storage, restorable());
  });

  await t.test('an export zipped again by Compress-Archive with \\ separators keeps its images', async () => {
    // Windows PowerShell 5.1 writes permanent\Note.md
    const files = unzipSync(new Uint8Array(await (await backup(fullStorage())).arrayBuffer()));
    const backslashed = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path.replaceAll('/', '\\'), bytes]));
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zipOf(backslashed)], 'again.zip')]));
    assert.deepEqual(got, { imported: 3, images: 2, identical: 0, copies: 0, rejected: {} });
    assert.deepEqual(storage, restorable());
  });

  await t.test('a note under a name with and without ./ is one note by its id', async () => {
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([
      new File([zipOf({ 'permanent/Good.md': good, '././permanent/Good.md': good })], 'b.zip'),
    ]));
    assert.deepEqual(got, { imported: 1, images: 0, identical: 0, copies: 0, rejected: { 'duplicate id': 1 } });
    assert.deepEqual(storage, { [`note:${ID1}`]: goodNote });
  });

  await t.test('two notes under one entry name both import', async () => {
    // a tool writing names in a code page turns 日本.md and 中文.md into ??.md
    const two = { title: 'Two', content: 'two', updatedAt: NOW, deletedAt: null };
    const zip = zipOf({ 'permanent/a.md': good, 'permanent/b.md': noteFile(ID2, two, 'two'), 'c.md': 'first', 'd.md': 'second' });
    declare(declare(zip, 0, { name: 'permanent/?.md' }), 1, { name: 'permanent/?.md' });
    declare(declare(zip, 2, { name: '?.md' }), 3, { name: '?.md' });
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zip], 'b.zip')]));
    assert.deepEqual(got, { imported: 4, images: 0, identical: 0, copies: 0, rejected: {} });
    assert.deepEqual(storage[`note:${ID1}`], goodNote);
    assert.deepEqual(storage[`note:${ID2}`], two);
    const loose = Object.entries(storage).filter(([k]) => k !== `note:${ID1}` && k !== `note:${ID2}`).map(([, v]) => v);
    assert.deepEqual(loose.map(({ title, content }) => ({ title, content })).sort((a, b) => (a.content < b.content ? -1 : 1)),
      [{ title: '?', content: 'first' }, { title: '?', content: 'second' }]);
  });

  await t.test('directory entries and macOS metadata entries are skipped', async () => {
    const storage = {};
    const appleDouble = Uint8Array.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, 0x4d, 0x61, 0x63]);
    const file = new File([zipOf({
      'permanent/': new Uint8Array(0),
      'permanent/Good.md': good,
      '__MACOSX/': new Uint8Array(0),
      '__MACOSX/permanent/._Good.md': appleDouble,
      'permanent/._Other.md': appleDouble,
    })], 'b.zip');
    const got = plain(await runTransfer({ storage }).transfer.importFiles([file]));
    assert.deepEqual(got, { imported: 1, images: 0, identical: 0, copies: 0, rejected: {} });
    assert.deepEqual(storage, { [`note:${ID1}`]: goodNote });
  });

  await t.test('an upper-case .MD entry is a note', async () => {
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zipOf({ 'permanent/Good.MD': good })], 'b.zip')]));
    assert.equal(got.imported, 1);
    assert.deepEqual(storage, { [`note:${ID1}`]: goodNote });
  });

  await t.test('a front matter whose id Obsidian unquoted is refused, not imported as a new note', async () => {
    const storage = {};
    const edited = good.replace(`id: "${ID1}"`, `id: ${ID1}`);
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([edited], 'Good.md')]));
    assert.deepEqual(got.rejected, { 'bad note file': 1 });
    assert.deepEqual(storage, {});
  });
});

test('importFiles hostile input', async (t) => {
  const deflate = (data) => [data, { level: 6 }];
  // every zip holds Good.md as entry 0, which shows that nothing else was
  // affected; extra is the one other note expected
  const cases = {
    'zip slip names': {
      entries: {
        '../x.md': good, '/abs.md': good, 'images/../../x.png': PNG, 'a\\..\\b.md': good, 'a//b.md': good, 'a/./b.md': good,
        './../y.md': good, './/abs2.md': good, [`a\\..\\images/${IMG1}.png`]: PNG,
      },
      rejected: { 'unsupported file': 9 },
    },
    'invalid image ids': {
      entries: { 'images/not-an-id.png': PNG, [`images/${IMG1.toUpperCase()}.png`]: PNG },
      rejected: { 'unsupported file': 2 },
    },
    'an entry too large by its compressed size': {
      entries: { 'Big.md': 'x' },
      patch: (zip) => declare(zip, 1, { size: MAX_NOTE_BYTES + 1 }),
      rejected: { 'too large': 1 },
    },
    'entries too large by their original size': {
      entries: { 'Big.md': 'x', [`images/${IMG1}.png`]: PNG },
      patch: (zip) => declare(declare(zip, 1, { originalSize: MAX_NOTE_BYTES + 1 }), 2, { originalSize: MAX_IMAGE_BYTES + 1 }),
      rejected: { 'too large': 2 },
    },
    'a deflate entry declaring fewer bytes than it holds': {
      entries: { 'Short.md': deflate('x'.repeat(1000)) },
      patch: (zip) => declare(zip, 1, { originalSize: 10 }),
      rejected: { 'bad note file': 1 },
    },
    'a deflate image declaring fewer bytes than it holds': {
      entries: {
        'Pic.md': noteFile(ID2, { ...goodNote, title: 'Pic' }, `![x](../images/${IMG1}.png)`),
        [`images/${IMG1}.png`]: deflate(new Uint8Array(1_000_000)),
      },
      patch: (zip) => declare(zip, 2, { originalSize: 10 }),
      rejected: { 'bad image': 1 },
      extra: { title: 'Pic', content: `![x](tabnotes-image:${IMG1})` },
    },
    'a stored entry declaring fewer bytes than it holds': {
      entries: { 'Short.md': 'xxxx' },
      patch: (zip) => declare(zip, 1, { originalSize: 2 }),
      rejected: { 'bad note file': 1 },
    },
    'a deflate entry declaring more bytes than it holds': {
      entries: { 'Long.md': deflate('x'.repeat(1000)) },
      patch: (zip) => declare(zip, 1, { originalSize: 1010 }),
      rejected: { 'bad note file': 1 },
    },
    'a stored entry declaring more bytes than it holds': {
      entries: { 'Long.md': 'xxxx' },
      patch: (zip) => declare(zip, 1, { originalSize: 10 }),
      rejected: { 'bad note file': 1 },
    },
    'a corrupt entry among good ones': {
      entries: { 'Bad.md': deflate('x'.repeat(100)), 'Fine.md': deflate('fine') },
      patch: (zip) => corrupt(zip, 1),
      rejected: { 'bad note file': 1 },
      extra: { title: 'Fine', content: 'fine' },
    },
    'declared sizes over the import limit': {
      entries: Object.fromEntries([...Array.from({ length: 41 }, (_, i) => [`images/${uuid(i)}.png`, PNG]), ['Late.md', 'late']]),
      patch: (zip) => {
        for (let i = 1; i <= 41; i++) declare(zip, i, { originalSize: MAX_IMAGE_BYTES });
        return zip;
      },
      rejected: { 'unreferenced image': 40, 'over the import limit': 2 },
    },
    'declared sizes exactly at the import limit': {
      entries: Object.fromEntries([...Array.from({ length: 41 }, (_, i) => [`images/${uuid(i)}.png`, PNG]), ['Late.md', 'late']]),
      patch: (zip) => {
        for (let i = 1; i <= 40; i++) declare(zip, i, { originalSize: MAX_IMAGE_BYTES });
        return declare(zip, 41, { originalSize: MAX_IMPORT_BYTES - 40 * MAX_IMAGE_BYTES - enc(good).length - 4 });
      },
      rejected: { 'unreferenced image': 41 },
      extra: { title: 'Late', content: 'late' },
    },
    'declared sizes one byte over the import limit': {
      entries: Object.fromEntries([...Array.from({ length: 41 }, (_, i) => [`images/${uuid(i)}.png`, PNG]), ['Late.md', 'late']]),
      patch: (zip) => {
        for (let i = 1; i <= 40; i++) declare(zip, i, { originalSize: MAX_IMAGE_BYTES });
        return declare(zip, 41, { originalSize: MAX_IMPORT_BYTES - 40 * MAX_IMAGE_BYTES - enc(good).length - 3 });
      },
      rejected: { 'unreferenced image': 41, 'over the import limit': 1 },
    },
    'a bad front matter': {
      entries: { 'Bad.md': `---\nid: "${ID2}"\nfoo: 1\n---\nx` },
      rejected: { 'bad note file': 1 },
    },
    'an unreferenced image, never inflated': {
      entries: { [`images/${IMG1}.png`]: deflate(PNG) },
      patch: (zip) => corrupt(zip, 1),
      rejected: { 'unreferenced image': 1 },
    },
    'a referenced image that does not inflate': {
      entries: {
        'Pic.md': noteFile(ID2, { ...goodNote, title: 'Pic' }, `![x](../images/${IMG1}.png)`),
        [`images/${IMG1}.png`]: deflate(PNG),
      },
      patch: (zip) => corrupt(zip, 2),
      rejected: { 'bad image': 1 },
      extra: { title: 'Pic', content: `![x](tabnotes-image:${IMG1})` },
    },
  };
  for (const [what, { entries, patch = (z) => z, rejected, extra }] of Object.entries(cases)) {
    await t.test(what, async () => {
      const storage = {};
      const zip = patch(zipOf({ 'permanent/Good.md': good, ...entries }));
      const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zip], 'b.zip')]));
      assert.deepEqual(got.rejected, rejected);
      assert.deepEqual(storage[`note:${ID1}`], goodNote);
      const others = Object.entries(storage).filter(([k]) => k !== `note:${ID1}`).map(([, v]) => v);
      const want = extra === undefined ? [] : [{ ...extra, deletedAt: null }];
      assert.deepEqual(others.map(({ updatedAt: _, ...rest }) => rest), want);
    });
  }

  await t.test('the import limit applies to each zip on its own', async () => {
    const over = zipOf(Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`images/${uuid(i)}.png`, PNG])));
    for (let i = 0; i < 41; i++) declare(over, i, { originalSize: MAX_IMAGE_BYTES });
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([
      new File([over], 'a.zip'),
      new File([zipOf({ 'permanent/Good.md': good })], 'b.zip'),
    ]));
    assert.deepEqual(got.rejected, { 'unreferenced image': 40, 'over the import limit': 1 });
    assert.deepEqual(storage, { [`note:${ID1}`]: goodNote });
  });

  await t.test('many entries declaring 0 bytes over one 16 KB bomb inflate little', async () => {
    // 16 MB of zeros deflated into 16 KB, each entry with its own copy;
    // pushing the whole 16 KB per entry took about 35 ms each, 7 s for these
    // 200
    const bomb = deflateSync(new Uint8Array(16 * 1024 * 1024), { level: 9 });
    const n = 200;
    const zip = rawZip(Array.from({ length: n }, (_, i) => ({ name: `n${i}.md`, data: bomb, originalSize: 0 })));
    const storage = {};
    const started = Date.now();
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zip], 'bomb.zip')]));
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
    assert.deepEqual(got.rejected, { 'bad note file': n });
    assert.deepEqual(storage, {});
  });

  await t.test('central entries sharing one stream are not a zip', async () => {
    // inflated once per entry, 100 entries over 1 MB of empty stored blocks
    // took 5 s, all of them counted as empty files
    const zip = rawZip(
      Array.from({ length: 100 }, (_, i) => ({ name: `n${i}.md`, data: emptyBlocks(200_000), originalSize: 0 })),
      { shared: true },
    );
    const storage = {};
    const started = Date.now();
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zip], 'shared.zip')]));
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
    assert.deepEqual(got.rejected, { 'not a zip': 1 });
    assert.deepEqual(storage, {});
  });

  await t.test('a deflate entry longer than any compressor writes is refused uninflated', async () => {
    // 25 MB of empty stored blocks inflate to nothing in about 1.3 s; before
    // the bound the first was an empty file and the second imported
    const padding = emptyBlocks(Math.floor(MAX_NOTE_BYTES / 5) - 2);
    const hello = new Uint8Array(padding.length + 5);
    hello.set(padding.subarray(0, -5));
    hello.set([1, 5, 0, 0xfa, 0xff, ...enc('hello')], padding.length - 5);
    const zip = rawZip([
      { name: 'Empty.md', data: padding, originalSize: 0 },
      { name: 'Hello.md', data: hello, originalSize: 5 },
    ]);
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zip], 'padded.zip')]));
    assert.deepEqual(got.rejected, { 'bad note file': 2 });
    assert.deepEqual(storage, {});
  });

  await t.test('padding after the last byte of a large entry inflates fast', async () => {
    // a valid stream: the text, then empty stored blocks up to the bound;
    // pushes shrinking with the room left took about 8 s for this one entry
    const zlib = require('node:zlib');
    // the largest size whose bound stays within the limit on compressed size
    const size = Math.floor(MAX_NOTE_BYTES / 1.15);
    const text = new Uint8Array(size).fill(0x78);
    const body = zlib.deflateRawSync(text, { level: 9, finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const bound = size + Math.ceil(size / 8) + Math.ceil(size / 64) + 64;
    const padding = emptyBlocks(Math.floor((bound - body.length) / 5) - 1);
    const data = new Uint8Array(body.length + padding.length);
    data.set(body);
    data.set(padding, body.length);
    assert.ok(data.length <= bound && data.length > bound - 10);
    const zip = rawZip([{ name: 'Long.md', data, originalSize: size }]);
    const storage = {};
    const started = Date.now();
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zip], 'padded.zip')]));
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
    assert.deepEqual(got.rejected, {});
    assert.equal(got.imported, 1);
  });

  await t.test('incompressible deflate entries inflate fast', async () => {
    // fflate's Inflate fed in pushes small enough to bound the overrun took
    // about 9 ms per 64 KB stored-block entry and per 1 MB image, so these
    // took about 10 s
    const zlib = require('node:zlib');
    const random = (n) => {
      const bytes = new Uint8Array(n);
      for (let i = 0, x = 1; i < n; i++) bytes[i] = (x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 24;
      return bytes;
    };
    const stored = new Uint8Array(zlib.deflateRawSync(random(65536), { level: 0 }));
    const image = random(1 << 20);
    const content = `![x](../images/${IMG1}.png)`;
    const note = enc(noteFile(ID2, { title: 'Pic', updatedAt: NOW, deletedAt: null }, content));
    const n = 1000;
    const zip = rawZip([
      { name: 'Pic.md', data: new Uint8Array(zlib.deflateRawSync(note)), originalSize: note.length },
      { name: `images/${IMG1}.png`, data: new Uint8Array(zlib.deflateRawSync(image)), originalSize: image.length },
      // one byte short, so each is inflated whole and then refused
      ...Array.from({ length: n }, (_, i) => ({ name: `n${i}.md`, data: stored, originalSize: 65535 })),
    ]);
    const storage = {};
    const started = Date.now();
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zip], 'z.zip')]));
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
    assert.deepEqual(got.rejected, { 'bad note file': n });
    assert.equal(got.images, 1);
    assert.deepEqual(storage[`image:${IMG1}`], { dataUrl: dataUrl('image/png', image) });
  });

  await t.test('deflate streams of zlib at its most expanding settings import', async () => {
    const zlib = require('node:zlib');
    // bytes from a fixed seed, as random ones expand the most
    const bytes = new Uint8Array(200_000);
    for (let i = 0, x = 1; i < bytes.length; i++) bytes[i] = (x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 24;
    const content = `![x](../images/${IMG1}.png)`;
    const note = noteFile(ID2, { title: 'Pic', updatedAt: NOW, deletedAt: null }, content);
    const settings = [
      { level: 0, memLevel: 1 },
      { level: 1, memLevel: 1, strategy: zlib.constants.Z_FIXED },
      { level: 9, memLevel: 1, strategy: zlib.constants.Z_HUFFMAN_ONLY },
    ];
    for (const options of settings) {
      const raw = (data) => new Uint8Array(zlib.deflateRawSync(data, options));
      const zip = rawZip([
        { name: 'Pic.md', data: raw(enc(note)), originalSize: enc(note).length },
        { name: `images/${IMG1}.png`, data: raw(bytes), originalSize: bytes.length },
        { name: 'Empty.md', data: raw(new Uint8Array(0)), originalSize: 0 },
      ]);
      assert.ok(raw(bytes).length > bytes.length, JSON.stringify(options));
      const storage = {};
      const got = plain(await runTransfer({ storage }).transfer.importFiles([new File([zip], 'z.zip')]));
      assert.deepEqual(got.rejected, { 'empty file': 1 }, JSON.stringify(options));
      assert.equal(got.images, 1);
      assert.deepEqual(storage[`image:${IMG1}`], { dataUrl: dataUrl('image/png', bytes) });
    }
  });

  await t.test('a zip file over the import limit is not read', async () => {
    let reads = 0;
    const big = { name: 'big.zip', size: MAX_IMPORT_BYTES + 1, arrayBuffer: async () => (reads++, new ArrayBuffer(0)) };
    const got = plain(await runTransfer({ storage: {} }).transfer.importFiles([big]));
    assert.deepEqual(got.rejected, { 'too large': 1 });
    assert.equal(reads, 0);
  });

  await t.test('a zip of more entries than the limit is skipped whole', async () => {
    const at = {};
    const many = zipOf({
      'permanent/Good.md': good,
      ...Object.fromEntries(Array.from({ length: MAX_ZIP_ENTRIES - 1 }, (_, i) => [`x/${i}.txt`, ''])),
    });
    const gotAt = plain(await runTransfer({ storage: at }).transfer.importFiles([new File([many], 'a.zip')]));
    assert.deepEqual(gotAt.rejected, { 'unsupported file': MAX_ZIP_ENTRIES - 1 });
    assert.deepEqual(at, { [`note:${ID1}`]: goodNote });
    // a zip64 record can claim billions of entries in a few bytes
    const over = {};
    const claims = zip64(zipOf({ 'permanent/Good.md': good }), { count: 2 ** 32 - 1 });
    const gotOver = plain(await runTransfer({ storage: over }).transfer.importFiles([new File([claims], 'a.zip')]));
    assert.deepEqual(gotOver.rejected, { 'too many files': 1 });
    assert.deepEqual(over, {});
  });

  await t.test('a file named .zip that is not one', async () => {
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([new File(['hello'], 'x.zip'), new File([good], 'Good.md')]));
    assert.deepEqual(got.rejected, { 'not a zip': 1 });
    assert.deepEqual(storage, { [`note:${ID1}`]: goodNote });
  });
});

test('importFiles markdown without a tabnotes front matter', async (t) => {
  const obsidian = '---\ntags: [a, b]\naliases: [x]\n---\n# Recipe\r\nflour\n';
  const cases = {
    'a loose file': { files: [new File(['milk\neggs'], 'Shopping.md')], title: 'Shopping', content: 'milk\neggs' },
    'a loose file with an Obsidian front matter': {
      files: [new File([obsidian], 'Recipe.MD')], title: 'Recipe', content: obsidian.replace('\r\n', '\n'),
    },
    'a file in a zip': { files: [new File([zipOf({ 'notes/deep/Shopping.md': 'milk' })], 'b.zip')], title: 'Shopping', content: 'milk' },
    'a file with an Obsidian front matter in a zip': {
      files: [new File([zipOf({ 'Recipe.md': obsidian })], 'b.zip')], title: 'Recipe', content: obsidian.replace('\r\n', '\n'),
    },
  };
  for (const [what, { files, title, content }] of Object.entries(cases)) {
    await t.test(`${what} is one new permanent note titled by its name`, async () => {
      const storage = {};
      const before = Date.now();
      const got = plain(await runTransfer({ storage }).transfer.importFiles(files));
      assert.deepEqual(got, { imported: 1, images: 0, identical: 0, copies: 0, rejected: {} });
      const [[key, note]] = Object.entries(storage);
      assert.match(key, /^note:[0-9a-f-]{36}$/);
      assert.deepEqual({ ...note, updatedAt: 0 }, { title, content, updatedAt: 0, deletedAt: null });
      assert.ok(note.updatedAt >= before && note.updatedAt <= Date.now());
    });
  }

  await t.test('empty, oversized and other files are rejected', async () => {
    const storage = {};
    const got = plain(await runTransfer({ storage }).transfer.importFiles([
      new File([''], 'Empty.md'),
      new File([' \n'], 'Blank.md'),
      new File([new Uint8Array(MAX_NOTE_BYTES + 1)], 'Big.md'),
      new File(['x'], 'notes.txt'),
      new File([zipOf({ 'Empty.md': '', 'notes.txt': 'x' })], 'b.zip'),
    ]));
    assert.deepEqual(got.rejected, { 'empty file': 3, 'too large': 1, 'unsupported file': 2 });
    assert.deepEqual(storage, {});
  });
});

test('importFiles write order and failures', async (t) => {
  await t.test('every image lands before the one note write', async () => {
    const { transfer, calls } = runTransfer({ storage: {} });
    await transfer.importFiles([await backup(fullStorage())]);
    const notesWritten = [`note:${ID3}`, `note:${ID1}`, `note:${ID2}`];
    assert.deepEqual(sets(calls), [[`image:${IMG1}`], [`image:${IMG2}`], notesWritten]);
  });

  await t.test('a failed image write stops the import with no note written', async () => {
    const storage = {};
    const reject = { 'storage.local.set': (items) => Object.hasOwn(items, `image:${IMG2}`) };
    const { transfer, calls } = runTransfer({ storage, reject });
    const { stopped, ...got } = await transfer.importFiles([await backup(fullStorage())]);
    assert.equal(String(stopped), 'Error: storage.local.set rejected');
    assert.deepEqual(plain(got), { imported: 0, images: 1, identical: 0, copies: 0, rejected: {} });
    assert.deepEqual(sets(calls), [[`image:${IMG1}`], [`image:${IMG2}`]]);
    assert.deepEqual(Object.keys(storage), [`image:${IMG1}`]);
  });

  await t.test('a failed note write reports the images in and no notes', async () => {
    const storage = {};
    const reject = { 'storage.local.set': (items) => Object.hasOwn(items, `note:${ID1}`) };
    const { stopped, ...got } = await runTransfer({ storage, reject }).transfer.importFiles([await backup(fullStorage())]);
    assert.equal(String(stopped), 'Error: storage.local.set rejected');
    assert.deepEqual(plain(got), { imported: 0, images: 2, identical: 0, copies: 0, rejected: {} });
    assert.deepEqual(Object.keys(storage).sort(), [`image:${IMG1}`, `image:${IMG2}`]);
  });

  await t.test('a file that cannot be read rejects before any write', async () => {
    const cause = new Error('gone');
    const file = { name: 'Lost.md', size: 1, arrayBuffer: () => Promise.reject(cause) };
    const { transfer, calls } = runTransfer({ storage: {} });
    await assert.rejects(transfer.importFiles([file]), (err) => err.message === 'read file Lost.md' && err.cause === cause);
    assert.deepEqual(calls, []);
  });

  const late = {
    'the second key list': ['list keys before writing notes', (counts) => ({
      'storage.local.getKeys': () => ++counts.lists === 2,
    })],
    'the notes stored meanwhile': ['read notes before writing notes', (counts) => ({
      'storage.local.get': () => ++counts.gets === 2,
    })],
  };
  for (const [what, [message, reject]] of Object.entries(late)) {
    await t.test(`a failed read of ${what} rejects after the images, with no note written`, async () => {
      const storage = {};
      const zip = await backup(fullStorage());
      const { transfer, calls } = runTransfer({ storage, reject: reject({ lists: 0, gets: 0 }) });
      await assert.rejects(transfer.importFiles([zip]), (err) => err.message === message && /rejected/.test(err.cause.message));
      assert.deepEqual(sets(calls), [[`image:${IMG1}`], [`image:${IMG2}`]]);
      assert.deepEqual(Object.keys(storage).sort(), [`image:${IMG1}`, `image:${IMG2}`]);
    });
  }

  const failures = {
    'the key list': { 'storage.local.getKeys': true },
    'the notes': { 'storage.local.get': true },
    'the tabs': { 'tabs.query': true },
  };
  for (const [what, reject] of Object.entries(failures)) {
    await t.test(`a failed read of ${what} rejects before any write`, async () => {
      const storage = {};
      const zip = await backup(fullStorage());
      const { transfer, calls } = runTransfer({ storage, reject });
      await assert.rejects(transfer.importFiles([zip]), (err) => err.cause instanceof Error && /rejected/.test(err.cause.message));
      assert.deepEqual(sets(calls), []);
      assert.deepEqual(storage, {});
    });
  }
});
