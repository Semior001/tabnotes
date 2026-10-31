'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, bundleOptions, pages, thirdPartyNotices } = require('../scripts/build.js');
const { tempBuild } = require('./bundle.js');

const root = path.join(__dirname, '..');
const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabnotes-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
};
// one build for the tests that only read it
const dist = tempBuild();
const notices = fs.readFileSync(path.join(dist, 'THIRD_PARTY_LICENSES.txt'), 'utf8');
const mermaidList = fs.readFileSync(path.join(root, 'scripts/mermaid-bundled-licenses.txt'), 'utf8');
const installedVersion = (name) => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

test('build writes the unpacked extension into a new outdir', (t) => {
  const outdir = path.join(tempDir(t), 'nested', 'dist');
  build(outdir);
  const files = ['manifest.json', 'background.js', 'theme.js', 'icons/icon-48.png', 'vendor/mermaid.min.js'];
  for (const page of pages) files.push(page, page.replace('.html', '.js'), page.replace('.html', '.css'));
  for (const rel of files) assert.ok(fs.existsSync(path.join(outdir, rel)), rel);
  assert.equal(fs.existsSync(path.join(outdir, 'lib')), false);
});

test('the build has every file the manifest and pages name, all local', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  const files = [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.browser_action.default_icon),
    ...manifest.background.scripts,
    manifest.options_ui.page,
    'note/note.html', // opened by URL from the scripts, not named in the manifest
    'recovery/recovery.html',
  ];
  for (const rel of files.filter((f) => f.endsWith('.html'))) {
    const refs = [...fs.readFileSync(path.join(dist, rel), 'utf8').matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, rel);
    for (const ref of refs) assert.doesNotMatch(ref, /^[a-z]+:/i, `${rel}: ${ref}`);
    files.push(...refs.map((ref) => path.join(path.dirname(rel), ref)));
  }
  for (const rel of files) assert.ok(fs.statSync(path.join(dist, rel)).isFile(), rel);
});

// a list of what may ship, so anything new at the top level has to be added here
test('the build holds only the package files', () => {
  assert.deepEqual(fs.readdirSync(dist).sort(),
    ['THIRD_PARTY_LICENSES.txt', 'background.js', 'icons', 'manifest.json', 'note', 'options', 'recovery', 'theme.js', 'vendor']);
  const names = fs.readdirSync(dist, { recursive: true }).flatMap((rel) => rel.split(path.sep));
  for (const name of ['tests', 'docs', 'src', '.env', 'node_modules']) assert.ok(!names.includes(name), name);
});

test('build bundles the pure logic into each strict script, not as a global', () => {
  assert.equal(bundleOptions.format, 'iife');
  for (const rel of ['background.js', 'theme.js', ...pages.map((page) => page.replace('.html', '.js'))]) {
    const js = fs.readFileSync(path.join(dist, rel), 'utf8');
    assert.match(js, /^"use strict";/, rel);
    assert.doesNotMatch(js, /\bTabNotes\b/, rel);
  }
});

test('the esbuild target matches the minimum Firefox of the manifest', () => {
  const { strict_min_version: min } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
    .browser_specific_settings.gecko;
  assert.equal(bundleOptions.target, `firefox${parseInt(min, 10)}`);
});

test('build copies mermaid unbundled, as the only file under vendor', () => {
  assert.deepEqual(fs.readdirSync(path.join(dist, 'vendor')), ['mermaid.min.js']);
  const copied = fs.readFileSync(path.join(dist, 'vendor', 'mermaid.min.js'));
  assert.ok(copied.equals(fs.readFileSync(path.join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'))));
  assert.doesNotMatch(fs.readFileSync(path.join(dist, 'note', 'note.js'), 'utf8'), /mermaidAPI/);
});

test('package.json and the lockfile root declare the MIT license', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).license, 'MIT');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages[''].license, 'MIT');
});

test('the notices name the bundled packages with their license text', () => {
  const packages = [
    ['marked', 'Copyright (c) 2018+, MarkedJS'],
    ['highlight.js', 'BSD 3-Clause License'],
    ['codemirror', 'Copyright (C) 2017 by Marijn Haverbeke'],
    ['mermaid', 'Copyright (c) 2014 - 2022 Knut Sveidqvist'],
    ['fastdom', 'Copyright (c) 2016 Wilson Page'],
    ['strictdom', 'Copyright (c) 2013 Wilson Page'],
  ];
  for (const [name, text] of packages) {
    assert.ok(notices.includes(`\n${name} ${installedVersion(name)}\n`), name);
    assert.ok(notices.includes(text), text);
  }
});

test('the notices cover what mermaid.min.js holds beyond the lockfile', () => {
  assert.ok(notices.endsWith(mermaidList));
  for (const text of ['\njs-yaml 4.3.0\n', 'Copyright (C) 2011-2015 by Vitaly Puzrin', 'chevrotain 11.1.2', 'Copyright 2021 TypeFox GmbH']) {
    assert.ok(mermaidList.includes(text), text);
  }
});

// a mermaid update has to re-survey the list (docs/DEVELOPMENT.md, Updating dependencies)
test('the mermaid list names the installed mermaid', () => {
  const version = installedVersion('mermaid');
  assert.ok(mermaidList.includes(`(mermaid ${version})`), version);
});

test('the notices have every license file of cytoscape and dompurify, and no script', () => {
  assert.ok(notices.includes('Mozilla Public License Version 2.0'));
  assert.ok(notices.includes('The Cytoscape Consortium'));
  assert.ok(!notices.includes(fs.readFileSync(path.join(root, 'node_modules/cytoscape/license-update.mjs'), 'utf8').trim()));
});

// without the mermaid list, which has an es-toolkit section of its own
test('the notices have the NOTICE file of es-toolkit', () => {
  const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.ok(thirdPartyNotices(lockfile, root).includes('Lodash copyright notice and MIT permission notice:'));
});

test('thirdPartyNotices', async (t) => {
  const fixture = (packages) => {
    const dir = tempDir(t);
    for (const [key, files] of Object.entries(packages)) {
      fs.mkdirSync(path.join(dir, key), { recursive: true });
      for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, key, file), text);
    }
    return dir;
  };
  const manifest = (name, version) => JSON.stringify({ name, version });
  const key = 'node_modules/a';

  await t.test('takes every license file and labels the installed version', () => {
    const dir = fixture({ [key]: { 'package.json': manifest('a', '2.0.0'), LICENSE: 'text one', 'LICENSE-MPL': 'text two', 'license-update.mjs': 'script' } });
    const notices = thirdPartyNotices({ packages: { [key]: { version: '1.0.0' } } }, dir);
    assert.match(notices, /\na 2\.0\.0\n/);
    assert.ok(notices.includes('text one\n\ntext two'));
    assert.ok(!notices.includes('script'));
  });

  await t.test('tells license files from other files by name', () => {
    const accepted = ['COPYING', 'LICENCE', 'license.txt', 'LICENSE.md', 'NOTICE', 'LICENSE-MIT.txt'];
    const rejected = ['license-update.mjs', 'license.js', 'licensed.txt'];
    const files = Object.fromEntries([...accepted, ...rejected].map((file) => [file, `text of ${file}`]));
    const dir = fixture({ [key]: { 'package.json': manifest('a', '1.0.0'), ...files } });
    const notices = thirdPartyNotices({ packages: { [key]: {} } }, dir);
    for (const file of accepted) assert.ok(notices.includes(`text of ${file}`), file);
    for (const file of rejected) assert.ok(!notices.includes(`text of ${file}`), file);
  });

  await t.test('keeps a nested package apart from the top-level one', () => {
    const nested = 'node_modules/b/node_modules/a';
    const dir = fixture({
      [key]: { 'package.json': manifest('a', '1.0.0'), LICENSE: 'top' },
      [nested]: { 'package.json': manifest('a', '2.0.0'), LICENSE: 'nested' },
    });
    const notices = thirdPartyNotices({ packages: { [key]: {}, [nested]: {} } }, dir);
    assert.match(notices, /\na 1\.0\.0\n[^]*top[^]*\na 2\.0\.0\n[^]*nested/);
  });

  await t.test('skips the root and dev entries', () => {
    const notices = thirdPartyNotices({ packages: { '': { name: 'root' }, [key]: { dev: true } } }, fixture({}));
    assert.equal(notices, '');
  });

  await t.test('skips an optional package that is not installed', () => {
    assert.equal(thirdPartyNotices({ packages: { [key]: { optional: true } } }, fixture({})), '');
  });

  await t.test('takes an optional package that is installed', () => {
    const dir = fixture({ [key]: { 'package.json': manifest('a', '1.0.0'), LICENSE: 'text' } });
    assert.match(thirdPartyNotices({ packages: { [key]: { optional: true } } }, dir), /\na 1\.0\.0\n/);
  });

  // devOptional means a non-dev package may depend on it, so it counts as required
  await t.test('takes a devOptional package like a required one', () => {
    const dir = fixture({ [key]: { 'package.json': manifest('a', '1.0.0'), LICENSE: 'text' } });
    assert.match(thirdPartyNotices({ packages: { [key]: { devOptional: true } } }, dir), /\na 1\.0\.0\n/);
    assert.throws(() => thirdPartyNotices({ packages: { [key]: { devOptional: true } } }, fixture({})), /ENOENT/);
  });

  await t.test('refuses a required package that is not installed', () => {
    assert.throws(() => thirdPartyNotices({ packages: { [key]: {} } }, fixture({})), /ENOENT/);
  });

  await t.test('refuses a package with no license file', () => {
    const dir = fixture({ [key]: { 'package.json': manifest('a', '1.0.0'), 'README.md': '## License\n\nMIT' } });
    assert.throws(() => thirdPartyNotices({ packages: { [key]: {} } }, dir), /no license file in a/);
  });

  await t.test('takes the README section of fastdom to the end of the file', () => {
    const dir = fixture({ [key]: { 'package.json': manifest('fastdom', '1.0.0'), 'README.md': 'intro\n\n## License\n\nthe text' } });
    const notices = thirdPartyNotices({ packages: { [key]: {} } }, dir);
    assert.ok(notices.includes('## License\n\nthe text'));
    assert.ok(!notices.includes('intro'));
  });

  await t.test('refuses a fastdom whose README lost the section', () => {
    const dir = fixture({ [key]: { 'package.json': manifest('fastdom', '1.0.0'), 'README.md': 'intro\n\n### License\n\nthe text' } });
    assert.throws(() => thirdPartyNotices({ packages: { [key]: {} } }, dir), /no license section in the README of fastdom/);
  });
});

// note.css overrides the editor's colours and fixed height, so at equal
// specificity it has to come last
test('the built note.css has third-party rules before note rules', () => {
  const css = fs.readFileSync(path.join(dist, 'note', 'note.css'), 'utf8');
  assert.doesNotMatch(css, /@import/);
  // the highlight.js theme is light only and paints code blocks itself
  assert.doesNotMatch(css, /code\.hljs/);
  const positions = ['height: 300px;', '.CodeMirror-dialog {', '--note-font-size: 14px;']
    .map((rule) => css.indexOf(rule));
  assert.ok(positions.every((p) => p !== -1), String(positions));
  assert.deepEqual(positions, positions.toSorted((a, b) => a - b));
});

test('build removes stale files from outdir', (t) => {
  const outdir = tempDir(t);
  fs.writeFileSync(path.join(outdir, 'stale.js'), '');
  fs.mkdirSync(path.join(outdir, 'old'));
  fs.writeFileSync(path.join(outdir, 'old', 'page.html'), '');
  fs.mkdirSync(path.join(outdir, 'note'));
  fs.writeFileSync(path.join(outdir, 'note', 'stale.css'), '');
  build(outdir);
  for (const rel of ['stale.js', 'old', 'note/stale.css']) {
    assert.equal(fs.existsSync(path.join(outdir, rel)), false, rel);
  }
});

// web-ext sign finds an interrupted upload by this file
test('build keeps .amo-upload-uuid', (t) => {
  const outdir = tempDir(t);
  fs.writeFileSync(path.join(outdir, '.amo-upload-uuid'), 'uuid');
  build(outdir);
  assert.equal(fs.readFileSync(path.join(outdir, '.amo-upload-uuid'), 'utf8'), 'uuid');
});

test('the root manifest holds the placeholder version', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version, '0.0.0');
});

test('build stamps the version into dist/manifest.json only', (t) => {
  const outdir = tempDir(t);
  const text = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  build(outdir, '1.2.3');
  const stamped = JSON.parse(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8'));
  assert.deepEqual(stamped, { ...JSON.parse(text), version: '1.2.3' });
  assert.equal(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), text);
});

test('build leaves the manifest alone with no version or an empty one', (t) => {
  const text = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  assert.equal(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'), text);
  const outdir = tempDir(t);
  build(outdir, '');
  assert.equal(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8'), text);
});

test('build refuses a version that is not X.Y.Z, before it touches outdir', async (t) => {
  for (const version of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.3-rc.1', '01.2.3', '1.2.3\n', ' 1.2.3', '$(id)']) {
    await t.test(JSON.stringify(version), (t) => {
      const outdir = tempDir(t);
      fs.writeFileSync(path.join(outdir, 'kept'), '');
      assert.throws(() => build(outdir, version), /invalid version/);
      assert.ok(fs.existsSync(path.join(outdir, 'kept')));
    });
  }
});

// a copy of the sources, as scripts/build.js always writes to the dist/ next to it
test('scripts/build.js takes the version from RELEASE_VERSION', async (t) => {
  const source = tempDir(t);
  for (const rel of ['scripts', 'src', 'icons', 'manifest.json', 'package-lock.json']) {
    fs.cpSync(path.join(root, rel), path.join(source, rel), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(source, 'node_modules'));
  const { RELEASE_VERSION: _, ...unset } = process.env;
  const run = (env) => spawnSync(process.execPath, ['scripts/build.js'], { cwd: source, env, encoding: 'utf8' });
  const version = () => JSON.parse(fs.readFileSync(path.join(source, 'dist', 'manifest.json'), 'utf8')).version;

  await t.test('set', () => {
    assert.equal(run({ ...unset, RELEASE_VERSION: '1.2.3' }).status, 0);
    assert.equal(version(), '1.2.3');
  });
  await t.test('empty', () => {
    assert.equal(run({ ...unset, RELEASE_VERSION: '' }).status, 0);
    assert.equal(version(), '0.0.0');
  });
  await t.test('unset', () => {
    assert.equal(run(unset).status, 0);
    assert.equal(version(), '0.0.0');
  });
  await t.test('invalid', () => {
    const r = run({ ...unset, RELEASE_VERSION: 'v1.2.3' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid version: v1\.2\.3/);
  });
});

// sign uploads git archive HEAD as the source, so a file the build needs has
// to be committed. Runs on a clean tree only, which is what task sign has.
test('the committed source rebuilds the package', (t) => {
  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  } catch {
    t.skip('not a git checkout');
    return;
  }
  if (status !== '') {
    t.skip('uncommitted changes');
    return;
  }
  const source = tempDir(t);
  const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, maxBuffer: Infinity });
  execFileSync('tar', ['-x', '-C', source], { input: archive });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(source, 'node_modules'));
  // the suite also runs inside task sign, and dist here is unstamped
  execFileSync(process.execPath, ['scripts/build.js'], { cwd: source, env: { ...process.env, RELEASE_VERSION: '' } });

  // esbuild's module paths under node_modules follow the link, nothing else differs
  const content = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true })
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
    .map((rel) => [rel, fs.readFileSync(path.join(dir, rel), 'latin1').replace(/\S*node_modules\//g, 'node_modules/')]));
  assert.deepEqual(content(path.join(source, 'dist')), content(dist));
});
