'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { marked, Marked } = require('marked');

const {
  canOpen, createDebouncer, storageKey, idFromStorageKey, noteIdFromUrl, noteUrl, notesFromStorage,
  newNote, edit, rename, trash, restore, daysLeft, daysLeftText, expired, classify, matches, escapeHTML, plainPreview, rowText, searchParts, selectRange, shortDate, DEFAULT_TITLE,
  codeBlockHTML, previewExtension, taskOffsets, toggleTask, previewBlocks, scrollMap, scrollAnchors, toggleWrap, linkText, fontSizeFrom, themeFrom, isDarkTheme,
  MAX_IMAGE_BYTES, imageKey, idFromImageKey, imageLabel, checkImageFiles, pasteIsText, STORAGE_FULL_HINT, imageMarkdown, imageRefs,
  imageIdFromHref, imageHTML, sweepImages, withoutReferenced, orphansAfterFailedRemove, sameFirstSeen,
  titleVars, expandTitle, TITLE_HINT,
  setTemporary, expire, temporaryFromUrl, sweepClosed, closedAfterFailedWrite, closedDaysLeft,
} = require('../src/lib/notes.ts');

test('canOpen', async (t) => {
  const cases = [
    ['http', 'http://a.com/', true],
    ['https', 'https://a.com/p?q#f', true],
    ['file', 'file:///tmp/x', false],
    ['about', 'about:newtab', false],
    ['data', 'data:text/html,hi', false],
    ['javascript', 'javascript:alert(1)', false],
    ['relative', '/foo/bar', false],
    ['garbage', 'not a url', false],
    ['empty', '', false],
    ['undefined', undefined, false],
  ];
  for (const [name, input, want] of cases) {
    await t.test(name, () => {
      assert.equal(canOpen(input), want);
    });
  }
});

test('createDebouncer', async (t) => {
  await t.test('debounce collapses bursts into one write', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let writes = 0;
    const saver = createDebouncer(() => writes++, 500);
    saver.schedule();
    t.mock.timers.tick(300);
    saver.schedule();
    t.mock.timers.tick(300);
    saver.schedule();
    t.mock.timers.tick(499);
    assert.equal(writes, 0);
    t.mock.timers.tick(1);
    assert.equal(writes, 1);
    t.mock.timers.tick(5000);
    assert.equal(writes, 1);
  });

  await t.test('flush writes immediately and cancels the timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let writes = 0;
    const saver = createDebouncer(() => writes++, 500);
    saver.schedule();
    saver.flush();
    assert.equal(writes, 1);
    t.mock.timers.tick(1000);
    assert.equal(writes, 1);
  });

  await t.test('flush with nothing pending is a no-op', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let writes = 0;
    const saver = createDebouncer(() => writes++, 500);
    saver.flush();
    assert.equal(writes, 0);
    saver.schedule();
    t.mock.timers.tick(500);
    assert.equal(writes, 1);
    saver.flush();
    assert.equal(writes, 1);
  });

  await t.test('schedule after flush works again', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let writes = 0;
    const saver = createDebouncer(() => writes++, 500);
    saver.schedule();
    saver.flush();
    saver.schedule();
    t.mock.timers.tick(500);
    assert.equal(writes, 2);
  });

  await t.test('pending tracks a scheduled write', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const saver = createDebouncer(() => {}, 500);
    assert.equal(saver.pending(), false);
    saver.schedule();
    assert.equal(saver.pending(), true);
    t.mock.timers.tick(500);
    assert.equal(saver.pending(), false);
    saver.schedule();
    saver.flush();
    assert.equal(saver.pending(), false);
  });

  await t.test('throwing write leaves the saver usable', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let writes = 0;
    const saver = createDebouncer(() => {
      writes++;
      if (writes === 1) throw new Error('boom');
    }, 500);
    saver.schedule();
    assert.throws(() => saver.flush(), /boom/);
    saver.flush();
    assert.equal(writes, 1);
    saver.schedule();
    t.mock.timers.tick(500);
    assert.equal(writes, 2);
  });
});

const ID1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ID3 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const ID4 = '886313e1-3b8a-4372-9b90-0c9aee199e5d';
const BASE = 'moz-extension://uuid/note/note.html';
const DAY = 86400000;

test('storageKey and idFromStorageKey', async (t) => {
  await t.test('round trip', () => {
    assert.equal(storageKey(ID1), 'note:' + ID1);
    assert.equal(idFromStorageKey(storageKey(ID1)), ID1);
  });
  const cases = [
    ['settings', 'settings'],
    ['legacy notes map', 'notes'],
    ['prefix only', 'note:'],
    ['bad id', 'note:abc'],
    ['uppercase id', 'note:' + ID1.toUpperCase()],
  ];
  for (const [name, key] of cases) {
    await t.test(name, () => {
      assert.equal(idFromStorageKey(key), null);
    });
  }
});

test('noteIdFromUrl', async (t) => {
  const cases = [
    ['valid', `${BASE}?id=${ID1}`, ID1],
    ['extra params', `${BASE}?x=1&id=${ID1}&y=2`, ID1],
    ['fragment', `${BASE}?id=${ID1}#top`, ID1],
    ['other extension page', `moz-extension://uuid/recovery/recovery.html?id=${ID1}`, null],
    ['other extension uuid', `moz-extension://other/note/note.html?id=${ID1}`, null],
    ['foreign url', `https://a.com/note/note.html?id=${ID1}`, null],
    ['no query', BASE, null],
    ['missing id', `${BASE}?x=1`, null],
    ['empty id', `${BASE}?id=`, null],
    ['bad id', `${BASE}?id=abc`, null],
    ['id too long', `${BASE}?id=${ID1}0`, null],
    ['path suffix', `${BASE}x?id=${ID1}`, null],
    ['undefined', undefined, null],
  ];
  for (const [name, url, want] of cases) {
    await t.test(name, () => {
      assert.equal(noteIdFromUrl(url, BASE), want);
    });
  }
});

test('noteUrl round-trips through noteIdFromUrl', () => {
  assert.equal(noteUrl(BASE, ID1), `${BASE}?id=${ID1}`);
  assert.equal(noteIdFromUrl(noteUrl(BASE, ID1), BASE), ID1);
});

test('notesFromStorage keeps only note keys, keyed by id', () => {
  const n = { title: 'T', content: 'x', updatedAt: 1, deletedAt: null };
  const stored = {
    [storageKey(ID1)]: n,
    [storageKey(ID2)]: { ...n, deletedAt: 2 },
    settings: { defaultTitle: 'X' },
    notes: {},
    'note:bad': n,
    fontSize: 16,
  };
  assert.deepEqual(notesFromStorage(stored), { [ID1]: n, [ID2]: { ...n, deletedAt: 2 } });
  assert.deepEqual(notesFromStorage({}), {});
});

test('newNote, edit, trash, restore', async (t) => {
  await t.test('newNote', () => {
    assert.deepEqual(newNote('Notes', 5), { title: 'Notes', content: '', updatedAt: 5, deletedAt: null });
  });

  await t.test('edit sets content and updatedAt', () => {
    const n = newNote('T', 1);
    assert.deepEqual(edit(n, 'hi', 2), { title: 'T', content: 'hi', updatedAt: 2, deletedAt: null });
  });

  await t.test('edit to blank removes a live note', () => {
    assert.equal(edit({ ...newNote('T', 1), content: 'x' }, ' \n\t', 2), null);
  });

  await t.test('edit to blank keeps a binned note', () => {
    const n = { title: 'T', content: 'x', updatedAt: 1, deletedAt: 1 };
    assert.deepEqual(edit(n, '', 2), { title: 'T', content: '', updatedAt: 2, deletedAt: 1 });
  });

  await t.test('rename sets the title and stamps now', () => {
    const n = { title: 'T', content: 'x', updatedAt: 1, deletedAt: null };
    assert.deepEqual(rename(n, 'U', 5), { title: 'U', content: 'x', updatedAt: 5, deletedAt: null });
  });

  await t.test('rename stamps above updatedAt on a repeated or lagging clock', () => {
    const n = newNote('T', 5);
    assert.equal(rename(n, 'U', 5).updatedAt, 6);
    assert.equal(rename(n, 'U', 3).updatedAt, 6);
  });

  await t.test('rename to an empty title returns null', () => {
    assert.equal(rename(newNote('T', 1), '', 2), null);
  });

  await t.test('rename keeps a binned note binned', () => {
    const n = { title: 'T', content: 'x', updatedAt: 1, deletedAt: 1 };
    assert.equal(rename(n, 'U', 2).deletedAt, 1);
  });

  await t.test('trash and restore', () => {
    const n = { title: 'T', content: 'x', updatedAt: 1, deletedAt: null };
    const binned = trash(n, 9);
    assert.deepEqual(binned, { ...n, deletedAt: 9 });
    assert.deepEqual(restore(binned), n);
  });

  await t.test('inputs not mutated', () => {
    const n = { title: 'T', content: 'x', updatedAt: 1, deletedAt: null };
    const snapshot = structuredClone(n);
    edit(n, 'y', 2);
    edit(n, '', 3);
    rename(n, 'U', 2);
    trash(n, 4);
    restore(trash(n, 4));
    assert.deepEqual(n, snapshot);
    const b = { ...n, deletedAt: 4 };
    restore(b);
    assert.equal(b.deletedAt, 4);
  });
});

test('daysLeft and expired', async (t) => {
  const deletedAt = 1000 * DAY;
  const n = { title: 'T', content: 'x', updatedAt: 1, deletedAt };
  const cases = [
    ['just binned', deletedAt, 30, false],
    ['one ms later rounds up', deletedAt + 1, 30, false],
    ['one day later', deletedAt + DAY, 29, false],
    ['one ms before expiry', deletedAt + 30 * DAY - 1, 1, false],
    ['exactly at expiry', deletedAt + 30 * DAY, 0, true],
    ['long past expiry clamps at 0', deletedAt + 100 * DAY, 0, true],
  ];
  for (const [name, now, days, exp] of cases) {
    await t.test(name, () => {
      assert.equal(daysLeft(n, now), days);
      assert.equal(expired(n, now), exp);
    });
  }
  await t.test('daysLeftText', () => {
    assert.equal(daysLeftText(n, deletedAt), '30 days left');
    assert.equal(daysLeftText(n, deletedAt + 30 * DAY - 1), '1 day left');
    assert.equal(daysLeftText(n, deletedAt + 30 * DAY), '0 days left');
  });
  await t.test('live note never expires', () => {
    assert.equal(expired({ ...n, deletedAt: null }, deletedAt + 100 * DAY), false);
  });
});

test('classify', async (t) => {
  const note = (updatedAt, deletedAt = null) => ({ title: 'T', content: 'c', updatedAt, deletedAt });
  const url = (id, extra = '') => `${BASE}?id=${id}${extra}`;

  await t.test('open note keeps all duplicate tabs', () => {
    const notes = { [ID1]: note(1) };
    const got = classify(
      notes,
      [{ id: 1, windowId: 1, url: url(ID1) }, { id: 2, windowId: 2, url: url(ID1, '#x') }],
      [{ tab: { url: url(ID1), sessionId: 's1' } }],
      BASE,
    );
    assert.deepEqual(got, {
      open: [{ id: ID1, note: notes[ID1], tabs: [{ tabId: 1, windowId: 1 }, { tabId: 2, windowId: 2 }] }],
      recent: [],
      other: [],
      bin: [],
    });
  });

  await t.test('recently closed tab and window sessions', () => {
    const notes = { [ID1]: note(1), [ID2]: note(2) };
    const got = classify(notes, [], [
      { tab: { url: url(ID1), sessionId: 's1' } },
      { window: { sessionId: 'w1', tabs: [{ url: url(ID2) }, { url: url(ID1) }, { url: 'https://a.com/' }] } },
    ], BASE);
    assert.deepEqual(got.recent, [
      { id: ID2, note: notes[ID2], tabs: [], sessionId: 'w1', fromWindow: true, windowTabCount: 3 },
      { id: ID1, note: notes[ID1], tabs: [], sessionId: 's1', fromWindow: false, windowTabCount: 1 },
    ]);
    assert.deepEqual(got.open, []);
    assert.deepEqual(got.other, []);
  });

  await t.test('remaining notes go to other; unknown and foreign urls ignored', () => {
    const notes = { [ID1]: note(1) };
    const got = classify(
      notes,
      [{ id: 1, windowId: 1, url: url(ID2) }, { id: 2, windowId: 1, url: `https://a.com/?id=${ID1}` }, { id: 3, windowId: 1 }],
      [{ tab: { url: url(ID3), sessionId: 's1' } }, {}],
      BASE,
    );
    assert.deepEqual(got, { open: [], recent: [], other: [{ id: ID1, note: notes[ID1], tabs: [] }], bin: [] });
  });

  await t.test('closed window without tabs recovers nothing', () => {
    const notes = { [ID1]: note(1) };
    const got = classify(notes, [], [{ window: { sessionId: 'w1' } }], BASE);
    assert.deepEqual(got, { open: [], recent: [], other: [{ id: ID1, note: notes[ID1], tabs: [] }], bin: [] });
  });

  await t.test('closed session without an id is not offered for restore', async (t) => {
    const notes = { [ID1]: note(1) };
    await t.test('note goes to other', () => {
      const got = classify(notes, [], [{ tab: { url: url(ID1) } }, { window: { tabs: [{ url: url(ID1) }] } }], BASE);
      assert.deepEqual(got, { open: [], recent: [], other: [{ id: ID1, note: notes[ID1], tabs: [] }], bin: [] });
    });
    await t.test('a later session with an id is used', () => {
      const got = classify(notes, [], [{ tab: { url: url(ID1) } }, { tab: { url: url(ID1), sessionId: 's1' } }], BASE);
      assert.deepEqual(got.recent, [{ id: ID1, note: notes[ID1], tabs: [], sessionId: 's1', fromWindow: false, windowTabCount: 1 }]);
    });
  });

  await t.test('binned notes go to bin with their open tabs', () => {
    const notes = { [ID1]: note(1, 5), [ID2]: note(2, 6) };
    const got = classify(
      notes,
      [{ id: 1, windowId: 1, url: url(ID1) }, { id: 2, windowId: 3, url: url(ID1) }],
      [{ tab: { url: url(ID2), sessionId: 's1' } }],
      BASE,
    );
    assert.deepEqual(got, {
      open: [],
      recent: [],
      other: [],
      bin: [
        { id: ID2, note: notes[ID2], tabs: [] },
        { id: ID1, note: notes[ID1], tabs: [{ tabId: 1, windowId: 1 }, { tabId: 2, windowId: 3 }] },
      ],
    });
  });

  await t.test('sorting: updatedAt desc, bin by deletedAt desc', () => {
    const notes = {
      [ID1]: note(1),
      [ID2]: note(3),
      [ID3]: note(9, 2),
      [ID4]: note(1, 7),
    };
    const got = classify(notes, [{ id: 1, windowId: 1, url: url(ID1) }, { id: 2, windowId: 1, url: url(ID2) }], [], BASE);
    assert.deepEqual(got.open.map((e) => e.id), [ID2, ID1]);
    assert.deepEqual(got.bin.map((e) => e.id), [ID4, ID3]);

    const others = classify({ [ID1]: note(1), [ID2]: note(3) }, [], [], BASE);
    assert.deepEqual(others.other.map((e) => e.id), [ID2, ID1]);
    const recents = classify({ [ID1]: note(1), [ID2]: note(3) }, [], [
      { tab: { url: url(ID1), sessionId: 's1' } },
      { tab: { url: url(ID2), sessionId: 's2' } },
    ], BASE);
    assert.deepEqual(recents.recent.map((e) => e.id), [ID2, ID1]);
  });
});

test('plainPreview', async (t) => {
  const cases = [
    ['heading and text', '# Title\n\ntext', 'Title text'],
    ['closing hashes', '## Title ##', 'Title'],
    ['lists', '- one\n* two\n+ three\n1. four\n2) five', 'one two three four five'],
    ['tasks', '- [ ] open\n- [x] done', 'open done'],
    ['quotes', '> quoted\n> > nested', 'quoted nested'],
    ['quoted list', '> - item', 'item'],
    ['links', 'see [the docs](https://a.com/x)', 'see the docs'],
    ['image reference', '![shot.png](tabnotes-image:abc) after', 'shot.png after'],
    ['emphasis and code', '**bold** *it* `code` ~~gone~~ _under_', 'bold it code gone under'],
    ['snake_case stays', 'a snake_case_name', 'a snake_case_name'],
    ['thematic break', 'a\n---\nb', 'a b'],
    ['fence body dropped', 'before\n```go\nfunc main() {}\n```\nafter', 'before after'],
    ['mermaid dropped', '```mermaid\nsequenceDiagram\n```\ntext', 'text'],
    ['tilde fence', '~~~\ncode\n~~~\ntext', 'text'],
    ['a shorter fence does not close', '````\n```\ncode\n````\ntext', 'text'],
    ['a fence with info does not close', '```\na\n```sad\nb\n```\ntext', 'text'],
    ['code-only note previews its code', '```go\nfoo()\nbar()\n```', 'foo() bar()'],
    ['unclosed fence runs to the end', '# test\nasd\n\n```mermaid\nsequenceDiagram\n\n```sad\n\n\n\nsss\n\n\nasdasdfasdf', 'test asd'],
    ['nothing but markers', '- [ ]', '- [ ]'],
    ['blank', ' \n ', ''],
  ];
  for (const [name, input, want] of cases) {
    await t.test(name, () => {
      assert.equal(plainPreview(input), want);
    });
  }
});

test('rowText', async (t) => {
  const row = (content, title = DEFAULT_TITLE, def = DEFAULT_TITLE) =>
    rowText({ title, content, updatedAt: 1, deletedAt: null }, def);
  const cases = [
    ['first heading names a default title', row('# Plan\nbody'), 'Plan', 'body'],
    ['a heading wins over earlier text', row('intro\n## Plan\nbody'), 'Plan', 'intro body'],
    ['first line without a heading', row('groceries\nmilk'), 'groceries', 'milk'],
    ['a one-line note has no preview', row('groceries'), 'groceries', ''],
    ['custom default', row('# Plan', 'Scratch', 'Scratch'), 'Plan', ''],
    ['the stock default after a settings change', row('# Plan', DEFAULT_TITLE, 'Scratch'), 'Plan', ''],
    ['custom title kept', row('# Plan\nbody', 'Sprint'), 'Sprint', 'Plan body'],
    ['blank note keeps its title', row('  \n'), DEFAULT_TITLE, ''],
    ['a # line in a fence is not a heading', row('```sh\n# install deps\nnpm ci\n```\nafter'), 'after', '# install deps npm ci'],
    ['skips a fence opening a note', row('```go\nfoo()\n```\n# Plan'), 'Plan', 'foo()'],
    ['code-only note', row('```go\nfoo()\nbar()\n```'), 'foo()', 'bar()'],
    ['skips a bare image', row('![](tabnotes-image:abc)\ntext'), 'text', ''],
    ['skips a thematic break', row('---\ntext'), 'text', ''],
    ['skips an empty task', row('- [ ]\ntext'), 'text', ''],
    ['skips an empty quote', row('>\ntext'), 'text', ''],
    ['only an empty image', row('![](tabnotes-image:abc)'), DEFAULT_TITLE, ''],
    ['screenshot note', row('# test\nasd\n\n```mermaid\nsequenceDiagram\n\n```sad\n\n\n\nsss\n\n\nasdasdfasdf'), 'test', 'asd'],
  ];
  for (const [name, got, wantName, wantPreview] of cases) {
    await t.test(name, () => {
      assert.deepEqual(got, { name: wantName, preview: wantPreview });
    });
  }
});

test('selectRange', async (t) => {
  const ids = ['a', 'b', 'c', 'd'];
  const cases = [
    ['forward', 'a', 'c', ['a', 'b', 'c']],
    ['backward', 'd', 'b', ['b', 'c', 'd']],
    ['one row', 'b', 'b', ['b']],
    ['anchor left the list', 'gone', 'c', ['c']],
    ['target not listed', 'a', 'gone', ['gone']],
  ];
  for (const [name, anchor, id, want] of cases) {
    await t.test(name, () => {
      assert.deepEqual(selectRange(ids, anchor, id), want);
    });
  }
});

test('shortDate', async (t) => {
  const now = new Date(2026, 9, 30, 12).getTime();
  const minute = 60 * 1000;
  const cases = [
    ['just now', now, 'now'],
    ['under a minute', now - minute + 1, 'now'],
    ['a minute', now - minute, '1m'],
    ['under an hour', now - 60 * minute + 1, '59m'],
    ['an hour', now - 60 * minute, '1h'],
    ['under a day', now - DAY + 1, '23h'],
    ['a day', now - DAY, '1d'],
    ['under a week', now - 7 * DAY + 1, '6d'],
    ['a week', now - 7 * DAY, 'Oct 23'],
    ['another year', new Date(2025, 11, 31).getTime(), 'Dec 31, 2025'],
    ['ahead of the clock', now + DAY, 'now'],
  ];
  for (const [name, ts, want] of cases) {
    await t.test(name, () => {
      assert.equal(shortDate(ts, now), want);
    });
  }
});

test('matches', async (t) => {
  const entry = { id: ID1, note: { title: 'Sprint Notes', content: 'Fix the Login bug', updatedAt: 1, deletedAt: null } };
  const cases = [
    ['title hit', entry, 'sprint', true],
    ['content hit', entry, 'login BUG', true],
    ['id not searched', entry, ID1.slice(0, 8), false],
    ['miss', entry, 'nothing', false],
    ['empty query', entry, '', true],
    ['whitespace query', entry, '   ', true],
    ['query trimmed', entry, '  sprint ', true],
  ];
  for (const [name, e, query, want] of cases) {
    await t.test(name, () => {
      assert.equal(matches(e, query, DEFAULT_TITLE), want);
    });
  }

  const titled = (title) => ({ id: ID1, note: { title, content: 'body', updatedAt: 1, deletedAt: null } });
  await t.test('a default title is not searched', () => {
    assert.equal(matches(titled('Notes'), 'notes', 'Scratch'), false);
    assert.equal(matches(titled('Scratch'), 'scratch', 'Scratch'), false);
    assert.equal(matches(titled('Sprint'), 'sprint', 'Scratch'), true);
  });
});

test('searchParts', async (t) => {
  const hit = (text) => ({ text, hit: true });
  const plain = (text) => ({ text, hit: false });
  const cases = [
    ['no query', 'abcdef', '', 3, [plain('abc')]],
    ['no hit', 'abc', 'z', 10, [plain('abc')]],
    ['several hits', 'a x a', 'a', 10, [hit('a'), plain(' x '), hit('a')]],
    ['case kept', 'an Apple', 'apple', 10, [plain('an '), hit('Apple')]],
    ['query trimmed', 'a b', '  b ', 10, [plain('a '), hit('b')]],
    ['regex characters are literal', 'a.b (c)', '.b (', 10, [plain('a'), hit('.b ('), plain('c)')]],
    ['a late hit moves the window', `${'x'.repeat(50)}hit`, 'hit', 30, [plain('...'), plain('x'.repeat(20)), hit('hit')]],
    ['the cap applies after the window', `${'x'.repeat(50)}hit${'y'.repeat(50)}`, 'hit', 25, [plain('...'), plain('x'.repeat(20)), hit('hit'), plain('yy')]],
    ['characters that change length when lowered', 'İİ apple', 'apple', 20, [plain('İİ '), hit('apple')]],
  ];
  for (const [name, text, query, max, want] of cases) {
    await t.test(name, () => {
      assert.deepEqual(searchParts(text, query, max), want);
    });
  }
});

test('escapeHTML', () => {
  assert.equal(escapeHTML(`<img src="x" alt='y'> & co`), '&lt;img src=&quot;x&quot; alt=&#39;y&#39;&gt; &amp; co');
  assert.equal(escapeHTML('plain'), 'plain');
});

test('codeBlockHTML', async (t) => {
  // fake highlight knows js only and marks what it was given, escaping like highlight.js
  const seen = [];
  const highlight = (code, lang) => {
    seen.push(lang);
    return lang === 'js' ? `<span class="hljs-keyword">${escapeHTML(code)}</span>` : null;
  };
  // block is the wrapper every code block but a diagram gets
  const block = (pre) => `<div class="code-block">${pre}<button class="copy" type="button">Copy</button></div>\n`;
  const cases = [
    { name: 'known language is highlighted', text: 'let a', lang: 'js', want: block('<pre><code class="hljs"><span class="hljs-keyword">let a</span></code></pre>') },
    { name: 'unknown language stays plain', text: 'x', lang: 'cobol', want: block('<pre><code>x</code></pre>') },
    { name: 'absent language stays plain', text: 'x', lang: undefined, want: block('<pre><code>x</code></pre>') },
    { name: 'empty language stays plain', text: 'x', lang: '', want: block('<pre><code>x</code></pre>') },
    { name: 'extra info string words are ignored', text: 'let a', lang: 'js title="x"', want: block('<pre><code class="hljs"><span class="hljs-keyword">let a</span></code></pre>') },
    { name: 'raw HTML inside highlighted code is escaped', text: '<img src=x>', lang: 'js', want: block('<pre><code class="hljs"><span class="hljs-keyword">&lt;img src=x&gt;</span></code></pre>') },
    { name: 'raw HTML inside unknown-language code is escaped', text: '<img src=x>&', lang: 'cobol', want: block('<pre><code>&lt;img src=x&gt;&amp;</code></pre>') },
    { name: 'raw HTML inside code with no language is escaped', text: '<img src=x>&', lang: undefined, want: block('<pre><code>&lt;img src=x&gt;&amp;</code></pre>') },
    { name: 'mermaid is escaped into pre.mermaid', text: 'a-->b<script>&', lang: 'mermaid', want: '<pre class="mermaid">a--&gt;b&lt;script&gt;&amp;</pre>\n' },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.equal(codeBlockHTML(c.text, c.lang, highlight), c.want);
    });
  }

  await t.test('the language never reaches the output', () => {
    const lang = 'x"><img src=y>';
    const out = codeBlockHTML('a', lang, (code) => code);
    assert.equal(out, block('<pre><code class="hljs">a</code></pre>'));
    assert.doesNotMatch(out, /img|x"/);
  });

  await t.test('highlight gets only the first word', () => {
    seen.length = 0;
    codeBlockHTML('a', '  py  linenos', highlight);
    assert.deepEqual(seen, ['py']);
  });

  await t.test('mermaid and absent languages skip highlight', () => {
    seen.length = 0;
    codeBlockHTML('a', 'mermaid', highlight);
    codeBlockHTML('a', '', highlight);
    assert.deepEqual(seen, []);
  });
});

test('previewExtension', async (t) => {
  const md = new Marked(previewExtension(() => null));

  await t.test('image', () => {
    const cases = [
      { name: 'plain', src: '![a](x)', want: '<img src="x" alt="a">' },
      { name: 'title', src: '![a](x "t\\"<b>")', want: '<img src="x" alt="a" title="t&quot;&lt;b&gt;">' },
      { name: 'quote in alt', src: '![a" style="position:fixed" b="c](x)', want: '<img src="x" alt="a&quot; style=&quot;position:fixed&quot; b=&quot;c">' },
      {
        name: 'inline tag in alt',
        src: '![<a b="><input type=checkbox>">](x)',
        want: '<img src="x" alt="&lt;a b=&quot;&gt;&lt;input type=checkbox&gt;&quot;&gt;">',
      },
      { name: 'formatting in alt stays plain text', src: '![**a** `b`](x)', want: '<img src="x" alt="a b">' },
      { name: 'quote and ampersand in href', src: '![a](<x" y=".png?a=1&b=2>)', want: '<img src="x%22%20y=%22.png?a=1&amp;b=2" alt="a">' },
      { name: 'percent in href is kept', src: '![a](x%20y)', want: '<img src="x%20y" alt="a">' },
      { name: 'href that cannot be encoded', src: '![<b>](\uD800)', want: '&lt;b&gt;' },
    ];
    for (const c of cases) assert.equal(md.parseInline(c.src), c.want, c.name);
  });

  await t.test('no inline tag turns escaping off for later text', () => {
    for (const tag of ['pre', 'code', 'kbd', 'script', 'PRE']) {
      const cases = [
        `a <${tag}> <input type=checkbox\n\nb <img src=x onerror=y z=\n`,
        `# a <${tag}> <input type=checkbox\n`,
        `**a <${tag}> <input type=checkbox**\n`,
        `- a <${tag}> <input type=checkbox\n`,
        `| a <${tag}> <input type=checkbox |\n|---|\n`,
        `[a <${tag}> <input type=checkbox](x)\n`,
      ];
      for (const src of cases) assert.doesNotMatch(md.parse(src), /<(input|img)/, src);
    }
  });

  await t.test('a closed raw tag still leaves its text escaped', () => {
    assert.equal(md.parseInline('<pre>a & b</pre> c'), '&lt;pre&gt;a &amp; b&lt;/pre&gt; c');
  });

  await t.test('values marked places itself stay inside their attributes', () => {
    const cases = [
      { name: 'link href', src: '[a](<x" onclick="y>)', want: /^<a href="x%22%20onclick=%22y">a<\/a>$/ },
      { name: 'link title', src: '[a](x "t\\"<b>")', want: /^<a href="x" title="t&quot;&lt;b&gt;">a<\/a>$/ },
      { name: 'autolink', src: '<https://x.y/"a>', want: /^<a href="https:\/\/x\.y\/%22a">https:\/\/x\.y\/&quot;a<\/a>$/ },
      { name: 'codespan', src: '`<b>"`', want: /^<code>&lt;b&gt;&quot;<\/code>$/ },
      { name: 'inline html in strong', src: '**<i>s</i>**', want: /^<strong>&lt;i&gt;s&lt;\/i&gt;<\/strong>$/ },
    ];
    for (const c of cases) assert.match(md.parseInline(c.src), c.want, c.name);
    assert.match(md.parse('# h <b>x</b>'), /^<h1>h &lt;b&gt;x&lt;\/b&gt;<\/h1>/);
    assert.match(md.parse('|a|\n|:-|\n|1|\n'), /<th align="left">a<\/th>/);
  });
});

test('toggleWrap', () => {
  const cases = [
    { name: 'wraps a selection', selected: 'word', marker: '**', want: '**word**' },
    { name: 'unwraps a wrapped selection', selected: '**word**', marker: '**', want: 'word' },
    { name: 'unwraps italic', selected: '_a b_', marker: '_', want: 'a b' },
    { name: 'empty selection inserts the markers', selected: '', marker: '**', want: '****' },
    { name: 'bare markers unwrap to nothing', selected: '****', marker: '**', want: '' },
    { name: 'a lone marker is wrapped, not unwrapped', selected: '**', marker: '**', want: '******' },
    { name: 'wrapped by the other marker is wrapped', selected: '**b**', marker: '_', want: '_**b**_' },
    { name: 'marker on one side only is wrapped', selected: '**a', marker: '**', want: '****a**' },
    { name: 'multi-line selection', selected: 'a\nb', marker: '_', want: '_a\nb_' },
  ];
  for (const c of cases) assert.equal(toggleWrap(c.selected, c.marker), c.want, c.name);
});

test('linkText', async (t) => {
  await t.test('selection becomes the link text with url selected', () => {
    const got = linkText('docs');
    assert.deepEqual(got, { text: '[docs](url)', cursor: { from: 7, to: 10 } });
    assert.equal(got.text.slice(got.cursor.from, got.cursor.to), 'url');
  });
  await t.test('no selection puts the cursor inside the brackets', () => {
    const got = linkText('');
    assert.deepEqual(got, { text: '[](url)', cursor: { from: 1, to: 1 } });
  });
  await t.test('multi-line selection keeps offsets into the text', () => {
    const got = linkText('a\nb');
    assert.equal(got.text.slice(got.cursor.from, got.cursor.to), 'url');
  });
});

test('fontSizeFrom', () => {
  const cases = [
    { name: 'absent', value: undefined, want: 14 },
    { name: 'null', value: null, want: 14 },
    { name: 'string', value: '16', want: 14 },
    { name: 'NaN', value: NaN, want: 14 },
    { name: 'infinity', value: Infinity, want: 14 },
    { name: 'below range', value: 3, want: 10 },
    { name: 'above range', value: 100, want: 32 },
    { name: 'lower bound', value: 10, want: 10 },
    { name: 'upper bound', value: 32, want: 32 },
    { name: 'valid', value: 18, want: 18 },
    { name: 'fraction is rounded', value: 15.6, want: 16 },
  ];
  for (const c of cases) assert.equal(fontSizeFrom(c.value), c.want, c.name);
});

test('themeFrom', () => {
  const cases = [
    { name: 'system', value: 'system', want: 'system' },
    { name: 'light', value: 'light', want: 'light' },
    { name: 'dark', value: 'dark', want: 'dark' },
    { name: 'undefined', value: undefined, want: 'system' },
    { name: 'null', value: null, want: 'system' },
    { name: 'empty string', value: '', want: 'system' },
    { name: 'unknown string', value: 'solarized', want: 'system' },
    { name: 'wrong case', value: 'Dark', want: 'system' },
    { name: 'number', value: 1, want: 'system' },
    { name: 'boolean', value: true, want: 'system' },
    { name: 'object', value: { mode: 'dark' }, want: 'system' },
    { name: 'array', value: ['dark'], want: 'system' },
  ];
  for (const c of cases) assert.equal(themeFrom(c.value), c.want, c.name);
});

test('isDarkTheme', () => {
  const cases = [
    { mode: 'system', systemDark: true, want: true },
    { mode: 'system', systemDark: false, want: false },
    { mode: 'light', systemDark: true, want: false },
    { mode: 'light', systemDark: false, want: false },
    { mode: 'dark', systemDark: true, want: true },
    { mode: 'dark', systemDark: false, want: true },
  ];
  for (const c of cases) assert.equal(isDarkTheme(c.mode, c.systemDark), c.want, `${c.mode}, systemDark ${c.systemDark}`);
});

test('previewBlocks', async (t) => {
  const blocks = (source) => previewBlocks(source, marked.lexer(source));
  const lines = (source) => blocks(source).map((b) => b.line);

  await t.test('lines per block', () => {
    assert.deepEqual(lines('# a\n\npara\nmore\n\n- b\n- c\n\n```\nd\n```\n'), [0, 2, 5, 8]);
    assert.deepEqual(lines(''), []);
  });

  await t.test('skips space tokens and keeps the rest in order', () => {
    const source = '\n\na\n\n\n\nb\n';
    assert.ok(marked.lexer(source).some((token) => token.type === 'space'));
    assert.deepEqual(blocks(source).map((b) => [b.line, b.token.type]), [[2, 'paragraph'], [6, 'paragraph']]);
  });

  await t.test('a link definition leaves a gap', () => {
    assert.deepEqual(lines('a\n\n[r]: http://x\n\nb'), [0, 4]);
  });

  await t.test('repeated identical blocks get their own lines', () => {
    assert.deepEqual(lines('x\n\nx\n\nx'), [0, 2, 4]);
  });

  await t.test('a block whose raw is not in the source lands on the next text', async (t) => {
    const cases = [
      ['lazy line in a nested blockquote', 'intro\n\n\n> > a\n> b\nc\n\nend', [0, 3, 7]],
      ['lazy line in a blockquoted list ending the note', 'intro\n\n> - a\nlazy', [0, 2]],
      ['first block', '> > a\n> b\nc\n\nend', [0, 4]],
      // the search did not move, so the second one cannot get past the first
      ['two in a row share a line', '> > a\n> b\nc\n\n> > d\n> e\nf\n\nend', [0, 0, 8]],
    ];
    for (const [name, source, want] of cases) {
      await t.test(name, () => {
        const tokens = marked.lexer(source);
        assert.ok(tokens.some((token) => !source.includes(token.raw)), 'no raw differs from the source');
        const got = previewBlocks(source, tokens).map((b) => b.line);
        assert.deepEqual(got, want);
        assert.deepEqual(got, got.toSorted((a, b) => a - b));
      });
    }
  });
});

test('taskOffsets', async (t) => {
  const lex = (src) => marked.lexer(src);
  // lines are the task lines by their text; each offset must point at that line's `[`
  const offsetsOf = (source, ...lines) => lines.map((l) => source.indexOf(l) + l.indexOf('['));

  await t.test('maps tasks', () => {
    const cases = [
      { name: 'plain', source: '- [ ] a\n- [ ] b\n', lines: ['- [ ] a', '- [ ] b'] },
      { name: 'checked', source: '- [x] a\n- [X] b\n', lines: ['- [x] a', '- [X] b'] },
      { name: 'star', source: '* [ ] a\n', lines: ['* [ ] a'] },
      { name: 'plus', source: '+ [ ] a\n', lines: ['+ [ ] a'] },
      { name: 'ordered dot', source: '1. [ ] a\n2. [x] b\n', lines: ['1. [ ] a', '2. [x] b'] },
      { name: 'ordered paren', source: '1) [ ] a\n', lines: ['1) [ ] a'] },
      { name: 'nested', source: '- [ ] a\n  - [ ] b\n    - [x] c\n- [ ] d\n', lines: ['- [ ] a', '- [ ] b', '- [x] c', '- [ ] d'] },
      { name: 'nested under a plain item', source: '- a\n  - [ ] b\n', lines: ['- [ ] b'] },
      { name: 'blockquote', source: '> - [ ] a\n> - [x] b\n', lines: ['- [ ] a', '- [x] b'] },
      { name: 'nested blockquote', source: '> > - [ ] a\n', lines: ['- [ ] a'] },
      { name: 'wide gap after the box', source: '- [ ]   a\n', lines: ['- [ ]   a'] },
      { name: 'loose list', source: '- [ ] a\n\n- [ ] b\n', lines: ['- [ ] a', '- [ ] b'] },
      { name: 'empty item', source: '- [ ] a\n- [ ] \n- [ ] c', lines: ['- [ ] a', '- [ ] \n', '- [ ] c'] },
      { name: 'empty item ending the note', source: '- [ ] a\n- [ ] ', lines: ['- [ ] a', '\n- [ ] '] },
      { name: 'only an empty item', source: '- [ ] ', lines: ['- [ ] '] },
      { name: 'empty item in a blockquote', source: '> - [ ] \n> - [ ] b', lines: ['- [ ] ', '- [ ] b'] },
      { name: 'task followed by a paragraph', source: '- [ ] \n  para\n', lines: ['- [ ] '] },
      { name: 'marker before the marker', source: '- - [ ] a\n- [ ] b', lines: ['- - [ ] a', '\n- [ ] b'] },
      { name: 'ordered marker before the marker', source: '1. - [ ] a\n- [ ] b', lines: ['1. - [ ] a', '\n- [ ] b'] },
      { name: 'tab-indented nested item', source: '- [ ] a\n\t- [ ] b', lines: ['- [ ] a', '- [ ] b'] },
      { name: 'ordered item in a blockquote', source: '> 1. [ ] a', lines: ['1. [ ] a'] },
      { name: 'non-ASCII text before, in UTF-16 units', source: 'é 😀\n\n- [ ] a', lines: ['- [ ] a'] },
    ];
    for (const c of cases) {
      assert.deepEqual(taskOffsets(c.source, lex), offsetsOf(c.source, ...c.lines), c.name);
      assert.equal(taskOffsets(c.source, lex).length, marked.parse(c.source).split('<input').length - 1, c.name);
    }
  });

  await t.test('skips text that only looks like a task', () => {
    const cases = [
      { name: 'fenced code', source: '```\n- [ ] no\n```\n\n- [ ] yes\n' },
      { name: 'code nested in a list', source: '- a\n\n  ```\n  - [ ] no\n  ```\n\n- [ ] yes\n' },
      { name: 'code in a blockquote', source: '> ```\n> - [ ] no\n> ```\n\n- [ ] yes\n' },
      { name: 'indented code', source: 'para\n\n    - [ ] no\n\n- [ ] yes\n' },
      { name: 'html block', source: '<div>\n- [ ] no\n</div>\n\n- [ ] yes\n' },
      { name: 'after a link definition', source: '[r]: /a\n\n- [ ] yes\n' },
      { name: 'in a paragraph', source: 'text [ ] no\n\n- [ ] yes\n' },
      { name: 'a tab after the box', source: '- [ ]\tno\n\n- [ ] yes\n' },
    ];
    for (const c of cases) {
      assert.deepEqual(taskOffsets(c.source, lex), offsetsOf(c.source, '- [ ] yes'), c.name);
    }
  });

  await t.test('refuses what does not map', () => {
    const cases = [
      { name: 'markers lose a task: count differs', source: '- [ ] - [ ] x\n- [ ] y\n', want: null },
      { name: 'task with no candidate line', source: '- > - [ ] a\n', want: [null] },
      { name: 'no tasks', source: '# title\n\ntext\n', want: [] },
      { name: 'empty', source: '', want: [] },
      { name: 'opening sentinel in the source', source: '- [ ] a\uE000\n', want: null },
      { name: 'closing sentinel in the source', source: '- [ ] a\uE001\n', want: null },
      { name: 'typed marker forging a mapping', source: '- [ ] \uE0001\uE001a\n- [ ] b\n', want: null },
    ];
    for (const c of cases) assert.deepEqual(taskOffsets(c.source, lex), c.want, c.name);
  });

  await t.test('balanced counts are still compared per index', () => {
    const source = '- [ ] - [ ] x\n- [ ] ```\n  - [ ] b\n  ```\n- [ ] z\n';
    assert.deepEqual(taskOffsets(source, lex), [2, null, null, source.indexOf('- [ ] z') + 2]);
  });

  await t.test('identical task text cannot hide a shifted index', () => {
    const cases = [
      {
        name: 'offset would tick the neighbouring duplicate',
        source: '- [ ] ```\n    - [ ] e\n- [ ] a\n  ```\n* [X] h\n- [ ] # t\n- [ ] # t\n- [ ] > x\n- [ ] - [ ] f\n',
      },
      {
        name: 'offset would land inside a fence',
        source: '- [ ] ```\n  - [ ] z\n  ```\n- [ ] z\n- [ ] - [ ] x\n',
      },
    ];
    for (const c of cases) assert.equal(taskOffsets(c.source, lex), null, c.name);
  });
});

// Seeded, so a failure reproduces. After a marked update, raise the count and
// try other seeds in a local run: chosen cases do not hold what marked changed.
// A wrong mapping is rare: this seed and count are enough to fail without the
// flip check in taskOffsets, at the 4,773rd note.
const PROPERTY_SEED = 20261030;
const PROPERTY_NOTES = 6000;

test('preview mapping properties', async (t) => {
  // the note page's renderers, which decide what per-token output must equal
  const md = new Marked(previewExtension(() => null));
  const lex = (src) => md.lexer(src);
  const tasks = (tokens) => tokens.flatMap((token) => {
    if (token.type === 'blockquote') return tasks(token.tokens);
    if (token.type !== 'list') return [];
    return token.items.flatMap((item) => [...(item.task ? [item] : []), ...tasks(item.tokens)]);
  });

  // mulberry32; the lines favour what breaks a mapping: repeats, fences that a
  // sentinel can open or close, and items that are tasks only at first sight
  let seed = PROPERTY_SEED;
  const random = (n) => {
    seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) % n;
  };
  const LINES = [
    '- [ ] a', '- [ ] a', '- [x] b', '* [X] c', '1. [ ] d', '- [ ] ', '- [ ]', '  - [ ] a', '    - [ ] e', '\t- [ ] f',
    '> - [ ] a', '> > - [x] g', '- - [ ] a', '1. - [ ] h', '- [ ] - [ ] x', '- > - [ ] i', '- [ ]\ta',
    '```', '  ```', '> ```', '- [ ] ```', '~~~', '', '', 'text', '  para', 'lazy', '# t', '- [ ] # t', '- [ ] > x',
    '---', '[r]: /u', '<div>', '</div>', '    code', '- a', '> b', '> > a',
  ];
  const notes = Array.from({ length: PROPERTY_NOTES }, () => {
    const count = 2 + random(9);
    return Array.from({ length: count }, () => LINES[random(LINES.length)]).join('\n') + (random(2) ? '\n' : '');
  });

  await t.test('a mapped box flips that task and no other', () => {
    let mapped = 0;
    for (const source of notes) {
      const real = tasks(lex(source));
      const offsets = taskOffsets(source, lex);
      if (offsets === null) continue;
      assert.equal(offsets.length, real.length, source);
      offsets.forEach((at, index) => {
        if (at === null) return;
        mapped++;
        const flipped = source.slice(0, at + 1) + toggleTask(source[at + 1]) + source.slice(at + 2);
        const after = tasks(lex(flipped));
        assert.equal(after.length, real.length, source);
        assert.deepEqual(after.flatMap((item, i) => (item.checked === real[i].checked ? [] : [i])), [index], source);
      });
    }
    assert.ok(mapped > PROPERTY_NOTES / 2, `only ${mapped} boxes mapped`);
  });

  await t.test('per-token output equals the whole note, box for box', () => {
    for (const source of notes) {
      const html = previewBlocks(source, lex(source)).map(({ token }) => md.parser([token])).join('');
      assert.equal(html, md.parse(source), source);
      assert.equal(html.split('<input').length - 1, tasks(lex(source)).length, source);
    }
  });

  await t.test('block lines stay in the note and never go backwards', () => {
    for (const source of notes) {
      const lines = previewBlocks(source, lex(source)).map((b) => b.line);
      assert.deepEqual(lines, lines.toSorted((a, b) => a - b), source);
      assert.ok(lines.every((line) => line < source.split('\n').length), source);
    }
  });
});

test('toggleTask', () => {
  const cases = [
    { mark: ' ', want: 'x' },
    { mark: 'x', want: ' ' },
    { mark: 'X', want: ' ' },
  ];
  for (const c of cases) assert.equal(toggleTask(c.mark), c.want, JSON.stringify(c.mark));
});

test('scrollMap', async (t) => {
  const anchors = [{ from: 10, to: 100 }, { from: 20, to: 300 }, { from: 40, to: 400 }];

  await t.test('maps points on and between anchors', () => {
    const cases = [
      { value: 10, want: 100 },
      { value: 20, want: 300 },
      { value: 40, want: 400 },
      { value: 15, want: 200 },
      { value: 30, want: 350 },
    ];
    for (const c of cases) assert.equal(scrollMap(anchors, c.value), c.want, String(c.value));
  });

  await t.test('holds at the ends', () => {
    assert.equal(scrollMap(anchors, 0), 100);
    assert.equal(scrollMap(anchors, 50), 400);
  });

  await t.test('duplicate from values do not divide by zero', () => {
    const dup = [{ from: 0, to: 0 }, { from: 10, to: 100 }, { from: 10, to: 200 }, { from: 20, to: 400 }];
    assert.equal(scrollMap(dup, 5), 50);
    assert.equal(scrollMap(dup, 10), 100);
    assert.equal(scrollMap(dup, 15), 300);
  });

  await t.test('a block at the very top does not move the start', () => {
    assert.equal(scrollMap([{ from: 0, to: 0 }, { from: 0, to: 12 }, { from: 100, to: 112 }], 0), 0);
  });
});

test('scrollAnchors', async (t) => {
  await t.test('adds both end points', () => {
    assert.deepEqual(scrollAnchors([{ from: 10, to: 20 }], 100, 200), [
      { from: 0, to: 0 }, { from: 10, to: 20 }, { from: 100, to: 200 },
    ]);
    assert.deepEqual(scrollAnchors([], 100, 200), [{ from: 0, to: 0 }, { from: 100, to: 200 }]);
  });

  await t.test('drops anchors at or past either maximum', () => {
    const pairs = [{ from: 10, to: 20 }, { from: 100, to: 30 }, { from: 40, to: 200 }, { from: 150, to: 300 }];
    assert.deepEqual(scrollAnchors(pairs, 100, 200), [
      { from: 0, to: 0 }, { from: 10, to: 20 }, { from: 100, to: 200 },
    ]);
  });

  await t.test('keeps document order, also for blocks sharing a line', () => {
    const got = scrollAnchors([{ from: 10, to: 15 }, { from: 10, to: 20 }, { from: 30, to: 60 }], 100, 200);
    assert.deepEqual(got.map((a) => [a.from, a.to]), [[0, 0], [10, 15], [10, 20], [30, 60], [100, 200]]);
  });

  await t.test('panes with nothing to scroll stay finite', () => {
    const pairs = [{ from: 0, to: 0 }, { from: 40, to: 80 }];
    const cases = [
      { name: 'source pane', maxFrom: 0, maxTo: 300, value: 0, want: 0 },
      { name: 'target pane', maxFrom: 300, maxTo: 0, value: 100, want: 0 },
      { name: 'both', maxFrom: 0, maxTo: 0, value: 0, want: 0 },
      { name: 'value past an empty range', maxFrom: 0, maxTo: 300, value: 5, want: 300 },
    ];
    for (const c of cases) {
      assert.equal(scrollMap(scrollAnchors(pairs, c.maxFrom, c.maxTo), c.value), c.want, c.name);
    }
  });

  await t.test('both pane ends stay reachable when blocks fit in the last screen', () => {
    // the last blocks start past the maximum of the short pane
    const pairs = [{ from: 100, to: 50 }, { from: 500, to: 250 }, { from: 900, to: 450 }, { from: 950, to: 480 }];
    const anchors = scrollAnchors(pairs, 800, 300);
    assert.equal(scrollMap(anchors, 0), 0);
    assert.equal(scrollMap(anchors, 800), 300);
    const back = scrollAnchors(pairs.map(({ from, to }) => ({ from: to, to: from })), 300, 800);
    assert.equal(scrollMap(back, 0), 0);
    assert.equal(scrollMap(back, 300), 800);
  });
});

const IMG_A = '11111111-1111-4111-8111-111111111111';
const IMG_B = '22222222-2222-4222-8222-222222222222';
const IMG_C = '33333333-3333-4333-8333-333333333333';

test('MAX_IMAGE_BYTES is 25 MB', () => {
  assert.equal(MAX_IMAGE_BYTES, 25 * 1024 * 1024);
});

test('imageKey and idFromImageKey', async (t) => {
  await t.test('round trip', () => {
    assert.equal(imageKey(IMG_A), `image:${IMG_A}`);
    assert.equal(idFromImageKey(imageKey(IMG_A)), IMG_A);
  });
  const cases = [
    ['note key', `note:${IMG_A}`],
    ['orphans map', 'imageOrphans'],
    ['settings', 'settings'],
    ['bare prefix', 'image:'],
    ['short id', 'image:abc'],
    ['upper case id', `image:${'A'.repeat(36)}`],
  ];
  for (const [name, key] of cases) {
    await t.test(name, () => {
      assert.equal(idFromImageKey(key), null);
    });
  }
});

test('imageMarkdown', async (t) => {
  const ref = `(tabnotes-image:${IMG_A})`;
  const cases = [
    ['plain name', 'shot.png', '![shot.png]' + ref],
    ['brackets', 'a[1].png', '![a\\[1\\].png]' + ref],
    ['backticks', 'a`b.png', '![a\\`b.png]' + ref],
    ['backslash', 'a\\b.png', '![a\\\\b.png]' + ref],
    ['newlines', 'a\nb\r\nc.png', '![abc.png]' + ref],
    ['empty name', '', '![image]' + ref],
    ['blank name', ' \n ', '![image]' + ref],
  ];
  for (const [name, input, want] of cases) {
    await t.test(name, () => {
      assert.equal(imageMarkdown(input, IMG_A), want);
    });
  }
  await t.test('a hostile name still parses as one image', () => {
    const [p] = marked.lexer(imageMarkdown('a](x) [b\n`c\\', IMG_A));
    assert.equal(p.tokens.length, 1);
    assert.equal(p.tokens[0].type, 'image');
    assert.equal(p.tokens[0].href, `tabnotes-image:${IMG_A}`);
  });
});

test('imageRefs', async (t) => {
  await t.test('no references', () => {
    assert.deepEqual(imageRefs('plain ![x](http://a.com/b.png)'), new Set());
  });
  await t.test('several images', () => {
    const got = imageRefs(`${imageMarkdown('a', IMG_A)}\ntext ${imageMarkdown('b', IMG_B)}`);
    assert.deepEqual(got, new Set([IMG_A, IMG_B]));
  });
  await t.test('several references to one image', () => {
    const got = imageRefs(`${imageMarkdown('a', IMG_A)} ${imageMarkdown('again', IMG_A)}`);
    assert.deepEqual(got, new Set([IMG_A]));
  });
  await t.test('an id too short is no reference', () => {
    assert.deepEqual(imageRefs('tabnotes-image:abc'), new Set());
  });
  await t.test('a reference in a fenced code block counts', () => {
    assert.deepEqual(imageRefs(`\`\`\`\n${imageMarkdown('a', IMG_A)}\n\`\`\``), new Set([IMG_A]));
  });
});

test('withoutReferenced keeps the ids no note references, a binned note counting', () => {
  const notes = {
    [IMG_A]: { title: '', content: imageMarkdown('a', IMG_A), updatedAt: 1, deletedAt: null },
    [IMG_B]: { title: '', content: imageMarkdown('b', IMG_B), updatedAt: 1, deletedAt: 1 },
  };
  const remove = { remove: [IMG_A, IMG_B, IMG_C], orphans: {} };
  assert.deepEqual(withoutReferenced(remove, notes), { remove: [IMG_C], orphans: {} });
  const orphans = { remove: [], orphans: { [IMG_A]: 1, [IMG_B]: 2, [IMG_C]: 3 } };
  assert.deepEqual(withoutReferenced(orphans, notes), { remove: [], orphans: { [IMG_C]: 3 } });
  assert.deepEqual(withoutReferenced({ remove: [IMG_C], orphans: { [IMG_A]: 1 } }, {}), { remove: [IMG_C], orphans: { [IMG_A]: 1 } });
});

test('orphansAfterFailedRemove keeps first sightings and leaves the sweep alone', () => {
  const sweep = { remove: [IMG_A], orphans: { [IMG_B]: 5 } };
  assert.deepEqual(orphansAfterFailedRemove(sweep, { [IMG_A]: 1, [IMG_B]: 5 }), { [IMG_A]: 1, [IMG_B]: 5 });
  assert.deepEqual(sweep.orphans, { [IMG_B]: 5 });
});

test('sameFirstSeen', async (t) => {
  const cases = [
    ['both empty', {}, {}, true],
    ['key order', { [IMG_A]: 1, [IMG_B]: 2 }, { [IMG_B]: 2, [IMG_A]: 1 }, true],
    ['other time', { [IMG_A]: 1 }, { [IMG_A]: 2 }, false],
    ['other id, same size', { [IMG_A]: 1 }, { [IMG_B]: 1 }, false],
    ['one more', { [IMG_A]: 1 }, { [IMG_A]: 1, [IMG_B]: 2 }, false],
    ['one less', { [IMG_A]: 1, [IMG_B]: 2 }, { [IMG_A]: 1 }, false],
  ];
  for (const [name, a, b, want] of cases) {
    await t.test(name, () => assert.equal(sameFirstSeen(a, b), want));
  }
});

test('imageIdFromHref', async (t) => {
  await t.test('reference', () => {
    assert.equal(imageIdFromHref(`tabnotes-image:${IMG_A}`), IMG_A);
  });
  const cases = [
    ['remote', 'https://a.com/b.png'],
    ['data', 'data:image/png;base64,AAAA'],
    ['empty', ''],
    ['bare scheme', 'tabnotes-image:'],
    ['short id', 'tabnotes-image:abc'],
    ['markup in id', 'tabnotes-image:"><script>alert(1)</script>-----------'],
    ['trailing text', `tabnotes-image:${IMG_A}x`],
    ['scheme not at start', `x-tabnotes-image:${IMG_A}`],
  ];
  for (const [name, href] of cases) {
    await t.test(name, () => {
      assert.equal(imageIdFromHref(href), null);
    });
  }
});

test('imageHTML', async (t) => {
  await t.test('plain alt', () => {
    assert.equal(imageHTML(IMG_A, 'shot'), `<img data-image="${IMG_A}" alt="shot" draggable="false">`);
  });
  await t.test('alt with HTML is escaped', () => {
    assert.equal(
      imageHTML(IMG_A, `"><script>'&`),
      `<img data-image="${IMG_A}" alt="&quot;&gt;&lt;script&gt;&#39;&amp;" draggable="false">`,
    );
  });
});

test('pasteIsText', async (t) => {
  const cases = [
    { name: 'nothing', text: '', want: false },
    { name: 'http URL', text: 'http://example.com/a.png', want: false },
    { name: 'https URL with a newline around it', text: '\nhttps://example.com/a.png?x=1\n', want: false },
    { name: 'file URL', text: 'file:///home/me/a.png', want: false },
    { name: 'data URL', text: 'data:image/png;base64,AAAA', want: false },
    { name: 'absolute path', text: '/home/me/a.png', want: false },
    { name: 'path with a space', text: '/home/me/my shots/a.png', want: false },
    { name: 'windows path', text: 'C:\\Users\\me\\a.png', want: false },
    { name: 'cell', text: 'cell', want: true },
    { name: 'cells', text: 'a\tb\n1\t2', want: true },
    { name: 'number', text: '42', want: true },
    { name: 'blank', text: ' ', want: true },
    { name: 'URL in a sentence', text: 'see https://example.com', want: true },
    { name: 'URL with more text', text: 'https://example.com is down', want: true },
    { name: 'two URLs', text: 'https://a.example\nhttps://b.example', want: true },
    { name: 'other scheme', text: 'ftp://example.com/a.png', want: true },
    { name: 'data URL of no image', text: 'data:text/plain,a', want: true },
    { name: 'slash and a space', text: '/ total', want: true },
    { name: 'relative path', text: 'shots/a.png', want: true },
  ];
  for (const c of cases) {
    await t.test(c.name, () => assert.equal(pasteIsText(c.text), c.want));
  }
});

test('imageLabel', () => {
  assert.equal(imageLabel('a.png'), 'a.png');
  assert.equal(imageLabel(' a.png '), 'a.png');
  assert.equal(imageLabel(''), 'image');
  assert.equal(imageLabel('  '), 'image');
});

test('checkImageFiles', async (t) => {
  const file = (name, type, size = 1) => ({ name, type, size });
  const png = file('a.png', 'image/png');
  const atLimit = file('b.png', 'image/png', MAX_IMAGE_BYTES);

  await t.test('null without an image', () => {
    assert.equal(checkImageFiles([]), null);
    assert.equal(checkImageFiles([file('a.txt', 'text/plain')]), null);
  });
  await t.test('keeps images up to the limit, the same objects in order', () => {
    const got = checkImageFiles([png, atLimit]);
    assert.deepEqual(got, { fitting: [png, atLimit], problems: [] });
    assert.equal(got.fitting[0], png);
  });
  await t.test('reports an image over the limit', () => {
    const got = checkImageFiles([png, file('big.png', 'image/png', MAX_IMAGE_BYTES + 1)]);
    assert.deepEqual(got, { fitting: [png], problems: ['big.png is over the 25 MB limit.'] });
  });
  await t.test('all images over the limit still counts as images', () => {
    const got = checkImageFiles([file('big.png', 'image/png', MAX_IMAGE_BYTES + 1)]);
    assert.deepEqual(got, { fitting: [], problems: ['big.png is over the 25 MB limit.'] });
  });
  await t.test('reports other files next to an image', () => {
    const got = checkImageFiles([file('a.txt', 'text/plain'), png]);
    assert.deepEqual(got, { fitting: [png], problems: ['a.txt was skipped: it is not an image.'] });
  });
  await t.test('names an unnamed file', () => {
    const got = checkImageFiles([file('', 'image/png', MAX_IMAGE_BYTES + 1)]);
    assert.deepEqual(got.problems, ['image is over the 25 MB limit.']);
  });
});

test('STORAGE_FULL_HINT states the grace sweepImages applies', () => {
  assert.match(STORAGE_FULL_HINT, /after 7 days\.$/);
});

test('sweepImages', async (t) => {
  const NOW = 100 * DAY;
  const live = (content) => ({ ...newNote('t', 0), content });
  const keys = (...ids) => ids.map(imageKey);

  await t.test('no images', () => {
    assert.deepEqual(sweepImages([], { [IMG_C]: live('x') }, {}, NOW), { remove: [], orphans: {} });
  });
  await t.test('a new unreferenced image enters the map with now', () => {
    assert.deepEqual(sweepImages(keys(IMG_A), {}, {}, NOW), { remove: [], orphans: { [IMG_A]: NOW } });
  });
  await t.test('a known orphan keeps its first sighting', () => {
    const got = sweepImages(keys(IMG_A), {}, { [IMG_A]: NOW - DAY }, NOW);
    assert.deepEqual(got, { remove: [], orphans: { [IMG_A]: NOW - DAY } });
  });
  await t.test('a referenced image stays out of the map', () => {
    const notes = { [IMG_C]: live(imageMarkdown('a', IMG_A)) };
    assert.deepEqual(sweepImages(keys(IMG_A), notes, {}, NOW), { remove: [], orphans: {} });
  });
  await t.test('an orphan referenced again leaves the map', () => {
    const notes = { [IMG_C]: live(imageMarkdown('a', IMG_A)) };
    const got = sweepImages(keys(IMG_A), notes, { [IMG_A]: NOW - 30 * DAY }, NOW);
    assert.deepEqual(got, { remove: [], orphans: {} });
  });
  await t.test('a reference in a binned note keeps the image', () => {
    const notes = { [IMG_C]: trash(live(imageMarkdown('a', IMG_A)), 0) };
    const got = sweepImages(keys(IMG_A), notes, { [IMG_A]: NOW - 30 * DAY }, NOW);
    assert.deepEqual(got, { remove: [], orphans: {} });
  });
  await t.test('grace boundary', () => {
    const just = sweepImages(keys(IMG_A), {}, { [IMG_A]: NOW - 7 * DAY + 1 }, NOW);
    assert.deepEqual(just, { remove: [], orphans: { [IMG_A]: NOW - 7 * DAY + 1 } });
    const over = sweepImages(keys(IMG_A), {}, { [IMG_A]: NOW - 7 * DAY }, NOW);
    assert.deepEqual(over, { remove: [IMG_A], orphans: {} });
  });
  await t.test('an old image gets the grace from its first sighting, not its age', () => {
    const first = sweepImages(keys(IMG_A), {}, {}, NOW);
    assert.deepEqual(first.remove, []);
    assert.deepEqual(sweepImages(keys(IMG_A), {}, first.orphans, NOW + 7 * DAY).remove, [IMG_A]);
  });
  await t.test('an orphan whose key is gone leaves the map', () => {
    assert.deepEqual(sweepImages([], {}, { [IMG_A]: NOW - DAY }, NOW), { remove: [], orphans: {} });
  });
  await t.test('other keys are ignored', () => {
    assert.deepEqual(sweepImages(['image:bad', 'settings'], {}, {}, NOW), { remove: [], orphans: {} });
  });
  await t.test('images are decided one by one', () => {
    const notes = { [IMG_C]: live(imageMarkdown('b', IMG_B)) };
    const got = sweepImages(keys(IMG_A, IMG_B, IMG_C), notes, { [IMG_A]: NOW - 8 * DAY }, NOW);
    assert.deepEqual(got, { remove: [IMG_A], orphans: { [IMG_C]: NOW } });
  });
});

test('expandTitle', async (t) => {
  const vars = { date: '2026-11-01', time: '14:05', weekday: 'Sunday', tab: 'My Page', host: 'github.com' };
  const expands = async (name, cases) => {
    await t.test(name, async (t) => {
      for (const [template, want, over] of cases) {
        await t.test(template || '(empty)', () => {
          assert.equal(expandTitle(template, { ...vars, ...over }), want);
        });
      }
    });
  };

  await expands('variables', [
    ['{date}', '2026-11-01'],
    ['{time}', '14:05'],
    ['{weekday}', 'Sunday'],
    ['{tab}', 'My Page'],
    ['{host}', 'github.com'],
  ]);
  await expands('functions', [
    ['{tab | lower}', 'my page'],
    ['{tab | upper}', 'MY PAGE'],
    ['{tab | trunc 4}', 'My …'],
  ]);
  await expands('chains run left to right', [
    ['{tab | upper | trunc 4}', 'MY …'],
    ['{tab | trunc 4 | lower | upper}', 'MY …'],
    ['{host | upper | lower}', 'github.com'],
  ]);
  await expands('whitespace is optional', [
    ['{ date }', '2026-11-01'],
    ['{tab|lower}', 'my page'],
    ['{tab|trunc 4|upper}', 'MY …'],
    ['{  tab  |  trunc   4  }', 'My …'],
  ]);
  await expands('several placeholders', [
    ['{date} - {tab | trunc 30}', '2026-11-01 - My Page'],
    ['{date}{time}', '2026-11-0114:05'],
    ['{date} {date}', '2026-11-01 2026-11-01'],
    ['{bad} {date}', '{bad} 2026-11-01'],
  ]);
  await expands('text with no braces', [
    ['Notes', 'Notes'],
    ['date | lower', 'date | lower'],
    ['', ''],
  ]);
  await expands('the result is trimmed', [
    ['  Notes  ', 'Notes'],
    ['{tab} - {host}', '-', { tab: '', host: '' }],
    ['{tab}', '', { tab: '' }],
    ['  {tab}  ', '', { tab: '' }],
  ]);
  await expands('an empty value is a value, not a failure', [
    ['{tab | upper}', '', { tab: '' }],
    ['{host | trunc 3}', '', { host: '' }],
  ]);
  await expands('unknown names stay literal', [
    ['{nope}', '{nope}'],
    ['{date | nope}', '{date | nope}'],
    ['{nope | lower}', '{nope | lower}'],
    ['{tab | upper | nope}', '{tab | upper | nope}'],
    ['{tab | nope | upper}', '{tab | nope | upper}'],
    ['{date lower}', '{date lower}'],
    ['{DATE}', '{DATE}'],
    ['{tab | LOWER}', '{tab | LOWER}'],
  ]);
  await expands('names inherited from Object are not variables', [
    ['{constructor}', '{constructor}'],
    ['{toString}', '{toString}'],
    ['{__proto__}', '{__proto__}'],
    ['{tab | constructor}', '{tab | constructor}'],
  ]);
  await expands('empty placeholders and pipes stay literal', [
    ['{}', '{}'],
    ['{ }', '{ }'],
    ['{ | lower }', '{ | lower }'],
    ['{date |}', '{date |}'],
    ['{date | | lower}', '{date | | lower}'],
  ]);
  await expands('wrong arguments stay literal', [
    ['{tab | lower 5}', '{tab | lower 5}'],
    ['{tab | upper 5}', '{tab | upper 5}'],
    ['{tab | trunc}', '{tab | trunc}'],
    ['{tab | trunc 0}', '{tab | trunc 0}'],
    ['{tab | trunc -1}', '{tab | trunc -1}'],
    ['{tab | trunc 1.5}', '{tab | trunc 1.5}'],
    ['{tab | trunc 3 4}', '{tab | trunc 3 4}'],
    ['{tab | trunc x}', '{tab | trunc x}'],
    ['{tab | trunc 1e2}', '{tab | trunc 1e2}'],
    ['{tab | trunc 05}', '{tab | trunc 05}'],
  ]);
  await expands('unbalanced braces', [
    ['{date', '{date'],
    ['date}', 'date}'],
    ['{date} {tab', '2026-11-01 {tab'],
    ['{{date}}', '{2026-11-01}'],
    ['{{date}', '{2026-11-01'],
  ]);
  await expands('trunc', [
    ['{tab | trunc 8}', 'My Page'],
    ['{tab | trunc 7}', 'My Page'],
    ['{tab | trunc 6}', 'My Pa…'],
    ['{tab | trunc 1}', '…'],
    ['{tab | trunc 99999999999999999999999}', 'My Page'],
    ['{tab | trunc 3}', 'a😀b', { tab: 'a😀b' }],
    ['{tab | trunc 2}', 'a…', { tab: 'a😀b' }],
    ['{tab | trunc 3}', 'a😀…', { tab: 'a😀bc' }],
    ['{tab | trunc 2}', '😀…', { tab: '😀😀😀' }],
  ]);
  await expands('values are not templates', [
    ['{tab}', '{date}', { tab: '{date}' }],
    ['{tab} {date}', '{date} 2026-11-01', { tab: '{date}' }],
    ['{tab | upper}', '$&', { tab: '$&' }],
    ['{tab}', "$' $` $1", { tab: "$' $` $1" }],
    ['{tab | lower}', 'a | upper', { tab: 'A | upper' }],
  ]);
});

test('titleVars', async (t) => {
  const NOW = new Date(2026, 10, 1, 14, 5);

  await t.test('date and time are zero padded', () => {
    const vars = titleVars(new Date(2026, 0, 2, 3, 4), null);
    assert.equal(vars.date, '2026-01-02');
    assert.equal(vars.time, '03:04');
  });
  await t.test('date and time are local near midnight', (t) => {
    const tz = process.env.TZ;
    t.after(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });
    // Both ends of the day, so a UTC getter fails in a zone on either side of UTC.
    for (const zone of ['Asia/Almaty', 'America/New_York']) {
      process.env.TZ = zone;
      const late = titleVars(new Date(2026, 10, 1, 23, 59), null);
      assert.deepEqual([late.date, late.time, late.weekday], ['2026-11-01', '23:59', 'Sunday']);
      const early = titleVars(new Date(2026, 10, 1, 0, 5), null);
      assert.deepEqual([early.date, early.time, early.weekday], ['2026-11-01', '00:05', 'Sunday']);
    }
  });
  await t.test('weekday is the en-US name', () => {
    assert.equal(titleVars(NOW, null).weekday, 'Sunday');
    assert.equal(titleVars(new Date(2026, 10, 4, 12), null).weekday, 'Wednesday');
  });
  await t.test('no source', () => {
    const vars = titleVars(NOW, null);
    assert.equal(vars.tab, '');
    assert.equal(vars.host, '');
  });
  await t.test('source with no url keeps its title', () => {
    const vars = titleVars(NOW, { title: 'A page' });
    assert.equal(vars.tab, 'A page');
    assert.equal(vars.host, '');
  });
  await t.test('source with no title keeps its host', () => {
    const vars = titleVars(NOW, { url: 'https://github.com/a' });
    assert.equal(vars.tab, '');
    assert.equal(vars.host, 'github.com');
  });
  const hosts = [
    ['https', 'https://github.com/a?b#c', 'github.com'],
    ['http with port', 'http://localhost:8080/', 'localhost'],
    ['about:blank', 'about:blank', ''],
    ['moz-extension', 'moz-extension://0f1e2d3c-aaaa-4bbb-8ccc-000011112222/note/note.html?id=x', ''],
    ['file', 'file:///tmp/x', ''],
    ['unparseable', 'not a url', ''],
  ];
  for (const [name, url, want] of hosts) {
    await t.test(`host: ${name}`, () => {
      const vars = titleVars(NOW, { title: 'T', url });
      assert.equal(vars.host, want);
      assert.equal(vars.tab, 'T');
    });
  }
});

test('TITLE_HINT names every variable and function, and no URL', () => {
  for (const name of ['{date}', '{time}', '{weekday}', '{tab}', '{host}', 'trunc N', 'lower', 'upper']) {
    assert.ok(TITLE_HINT.includes(name), name);
  }
  assert.doesNotMatch(TITLE_HINT, /https?:\/\//);
});

test('noteUrl with a kind', async (t) => {
  const cases = [
    ['no kind', undefined, `${BASE}?id=${ID1}`, null],
    ['temporary', true, `${BASE}?id=${ID1}&temporary=1`, true],
    ['permanent', false, `${BASE}?id=${ID1}&temporary=0`, false],
  ];
  for (const [name, kind, url, parsed] of cases) {
    await t.test(name, () => {
      assert.equal(noteUrl(BASE, ID1, kind), url);
      assert.equal(noteIdFromUrl(url, BASE), ID1);
      assert.equal(temporaryFromUrl(url), parsed);
    });
  }
});

test('temporaryFromUrl ignores an invalid parameter', async (t) => {
  for (const value of ['', '2', 'true', 'false', '01', 'TRUE']) {
    await t.test(`temporary=${value}`, () => {
      assert.equal(temporaryFromUrl(`${BASE}?id=${ID1}&temporary=${value}`), null);
    });
  }
});

test('note kind', async (t) => {
  await t.test('newNote adds the key only when temporary', () => {
    assert.deepEqual(newNote('T', 5, true), { title: 'T', content: '', updatedAt: 5, deletedAt: null, temporary: true });
    assert.equal(Object.hasOwn(newNote('T', 5, false), 'temporary'), false);
    assert.equal(Object.hasOwn(newNote('T', 5), 'temporary'), false);
  });

  await t.test('setTemporary sets and removes the key', () => {
    const note = { ...newNote('T', 5), content: 'x' };
    const made = setTemporary(note, true, 9);
    assert.deepEqual(made, { ...note, updatedAt: 9, temporary: true });
    const back = setTemporary(made, false, 12);
    assert.deepEqual(back, { ...note, updatedAt: 12 });
    assert.equal(Object.hasOwn(back, 'temporary'), false);
  });

  await t.test('setTemporary keeps the stamp above updatedAt', () => {
    assert.equal(setTemporary(newNote('T', 5), true, 5).updatedAt, 6);
    assert.equal(setTemporary(newNote('T', 5), true, 3).updatedAt, 6);
  });

  await t.test('setTemporary does not mutate the note', () => {
    const note = Object.freeze(newNote('T', 5, true));
    setTemporary(note, false, 9);
    assert.equal(note.temporary, true);
  });

  await t.test('edit, rename and trash keep the kind', () => {
    const note = newNote('T', 1, true);
    assert.equal(edit(note, 'x', 2).temporary, true);
    assert.equal(rename(note, 'U', 2).temporary, true);
    assert.equal(trash(note, 2).temporary, true);
  });
});

test('expire', async (t) => {
  const now = 1000 * DAY;
  const note = { ...newNote('T', 1, true), content: 'x' };

  await t.test('bins the note for 7 days', () => {
    assert.deepEqual(expire(note, now), { ...note, deletedAt: now, binDays: 7 });
  });

  await t.test('daysLeft honours binDays', () => {
    const binned = expire(note, now);
    assert.equal(daysLeft(binned, now), 7);
    assert.equal(daysLeft(binned, now + 7 * DAY - 1), 1);
    assert.equal(daysLeft(binned, now + 7 * DAY), 0);
    assert.equal(expired(binned, now + 7 * DAY - 1), false);
    assert.equal(expired(binned, now + 7 * DAY), true);
    assert.equal(daysLeftText(binned, now), '7 days left');
  });

  await t.test('a note binned by hand stays 30 days, for both kinds', () => {
    for (const binned of [trash(note, now), trash(newNote('T', 1), now)]) {
      assert.equal(Object.hasOwn(binned, 'binDays'), false);
      assert.equal(daysLeft(binned, now), 30);
      assert.equal(expired(binned, now + 7 * DAY), false);
    }
  });

  await t.test('restore drops binDays and keeps the kind', () => {
    const restored = restore(expire(note, now));
    assert.deepEqual(restored, note);
    assert.equal(Object.hasOwn(restored, 'binDays'), false);
  });

  await t.test('a restored note binned by hand gets the full stay', () => {
    assert.equal(daysLeft(trash(restore(expire(note, now)), now), now), 30);
  });
});

test('sweepClosed', async (t) => {
  const now = 1000 * DAY;
  const temp = (updatedAt = now - 100 * DAY) => ({ ...newNote('T', updatedAt, true), content: 'x' });
  const none = new Set();

  await t.test('a closed temporary note enters with the time of the sweep', () => {
    assert.deepEqual(sweepClosed({ [ID1]: temp() }, none, {}, now), { closed: { [ID1]: now }, expire: [] });
  });

  await t.test('a known note keeps its first sighting', () => {
    const closed = { [ID1]: now - DAY };
    assert.deepEqual(sweepClosed({ [ID1]: temp() }, none, closed, now), { closed, expire: [] });
  });

  await t.test('an old note with no entry is not due on its first sighting', () => {
    assert.deepEqual(sweepClosed({ [ID1]: temp(0) }, none, {}, now).expire, []);
  });

  const { temporary: _, ...stored } = temp();
  const leaves = [
    ['a note with no temporary field', stored, none],
    ['a permanent note', { ...newNote('T', 0), content: 'x' }, none],
    ['a binned note', trash(temp(), now - 40 * DAY), none],
    ['a reopened note', temp(), new Set([ID1])],
  ];
  for (const [name, note, open] of leaves) {
    await t.test(`${name} leaves the map and is not due`, () => {
      assert.deepEqual(sweepClosed({ [ID1]: note }, open, { [ID1]: now - 40 * DAY }, now), { closed: {}, expire: [] });
    });
  }

  await t.test('a removed note leaves the map', () => {
    assert.deepEqual(sweepClosed({}, none, { [ID1]: now - 40 * DAY }, now), { closed: {}, expire: [] });
  });

  await t.test('the note is due exactly at 30 days', () => {
    const before = { [ID1]: now - 30 * DAY + 1 };
    assert.deepEqual(sweepClosed({ [ID1]: temp() }, none, before, now), { closed: before, expire: [] });
    assert.deepEqual(sweepClosed({ [ID1]: temp() }, none, { [ID1]: now - 30 * DAY }, now), { closed: {}, expire: [ID1] });
  });

  await t.test('updatedAt postpones expiry and keeps the first sighting', () => {
    const closed = { [ID1]: now - 40 * DAY };
    assert.deepEqual(sweepClosed({ [ID1]: temp(now - DAY) }, none, closed, now), { closed, expire: [] });
    assert.deepEqual(sweepClosed({ [ID1]: temp(now - 30 * DAY) }, none, closed, now), { closed: {}, expire: [ID1] });
  });

  await t.test('each note is decided on its own', () => {
    const notes = { [ID1]: temp(), [ID2]: temp(), [ID3]: temp(), [ID4]: newNote('T', 0) };
    const closed = { [ID1]: now - 31 * DAY, [ID2]: now - 31 * DAY };
    assert.deepEqual(sweepClosed(notes, new Set([ID2]), closed, now), { closed: { [ID3]: now }, expire: [ID1] });
  });
});

test('closedAfterFailedWrite keeps a failed id with its first sighting', () => {
  const closed = { [ID1]: 10, [ID2]: 20, [ID3]: 30 };
  const sweep = { closed: { [ID3]: 30 }, expire: [ID1, ID2] };
  assert.deepEqual(closedAfterFailedWrite(sweep, [ID2], closed), { [ID2]: 20, [ID3]: 30 });
  assert.deepEqual(closedAfterFailedWrite(sweep, [], closed), { [ID3]: 30 });
  assert.deepEqual(sweep.closed, { [ID3]: 30 });
});

test('closedDaysLeft', async (t) => {
  const now = 1000 * DAY;
  const note = newNote('T', now - 100 * DAY, true);
  const cases = [
    ['no sighting yet', undefined, note, 30],
    ['just seen', now, note, 30],
    ['one day in', now - DAY, note, 29],
    ['a moment before the end', now - 30 * DAY + 1, note, 1],
    ['at the end', now - 30 * DAY, note, 0],
    ['past the end', now - 40 * DAY, note, 0],
    ['an edit after the sighting counts', now - 20 * DAY, { ...note, updatedAt: now - 5 * DAY }, 25],
    ['an edit does not add days past a full clock', undefined, { ...note, updatedAt: now - 5 * DAY }, 30],
  ];
  for (const [name, firstSeen, n, want] of cases) {
    await t.test(name, () => assert.equal(closedDaysLeft(firstSeen, n, now), want));
  }
});
