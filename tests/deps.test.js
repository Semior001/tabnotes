// Third-party dependencies: exact pins and the behaviour the note page relies
// on from them. require() here resolves the packages' CommonJS builds, while
// the bundle takes marked's ESM file: the note harness covers what ships.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');
const hljs = require('highlight.js/lib/common');

const root = path.join(__dirname, '..');
const json = (...p) => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8'));

const { dependencies, devDependencies } = json('package.json');

test('package.json, the lockfile and the install pin every dependency exactly', () => {
  const lock = json('package-lock.json').packages;
  assert.deepEqual(lock[''].dependencies, dependencies);
  assert.deepEqual(lock[''].devDependencies, devDependencies);
  for (const [name, version] of Object.entries({ ...dependencies, ...devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+$/, name);
    const entry = lock[`node_modules/${name}`];
    assert.equal(entry.version, version, name);
    assert.match(entry.integrity, /^sha512-/, name);
    assert.equal(json('node_modules', name, 'package.json').version, version, name);
  }
});

// mermaid's latest major is larger and untested with the CSP, and note.ts
// targets CodeMirror 5
test('mermaid and CodeMirror stay on their majors', () => {
  assert.match(dependencies.mermaid, /^11\./);
  assert.match(dependencies.codemirror, /^5\./);
});

test('marked renders markdown', () => {
  assert.match(marked.parse('# a'), /<h1/);
});

test('highlight.js has the common languages and escapes the code', () => {
  assert.equal(hljs.listLanguages().length, 36);
  assert.ok(hljs.getLanguage('js'));
  assert.ok(hljs.getLanguage('go'));
  assert.match(hljs.highlight('const a = "<b>"', { language: 'js' }).value, /hljs-keyword">const<.*&lt;b&gt;/);
});
