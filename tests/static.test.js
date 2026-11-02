// Static acceptance checks over the extension sources: offline-only code,
// minimal permissions and no dangling file references.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pages } = require('../scripts/build.js');
const { tempBuild } = require('./bundle.js');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const walk = (dir) => fs.readdirSync(dir, { recursive: true })
  .filter((rel) => fs.statSync(path.join(dir, rel)).isFile());
const sources = ['manifest.json', ...walk(path.join(root, 'src')).map((rel) => path.join('src', rel))];
const pageStyles = pages.map((page) => page.replace('.html', '.css'));
// checks that follow a path from a page or the manifest run on what ships
const dist = tempBuild();
const built = (...p) => fs.readFileSync(path.join(dist, ...p), 'utf8');
// fetch only as a bare or global call: mermaid bundles KaTeX, whose parser has
// its own fetch() method, called as .fetch() and defined as fetch(){
const fetchCall = /(?<![\w$.])fetch\s*\((?!\)\s*\{)|(?:window|globalThis|self)\.fetch\s*\(/.source;
const networkAPIs = `${fetchCall}|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts`;

test('the Taskfile packages dist, builds it once and uploads the source', () => {
  const taskfile = read('Taskfile.yml');
  assert.match(taskfile, /^ {2}SOURCE: --source-dir dist$/m);
  assert.doesNotMatch(taskfile, /--ignore-files/);
  // task deps run in parallel, so a second dep on it would be a second build:
  // the two uses are the definition and the dep of lint
  assert.equal(taskfile.replace(/^\s*#.*\n/gm, '').match(/build:dist/g).length, 2);
  assert.match(taskfile, /^ {2}lint:\n(?: {4}.*\n)*? {4}deps: \['build:dist'\]$/m);
  assert.match(taskfile, /^ {2}test:\n(?: {4}.*\n)*? {6}- npx --no-install tsc --noEmit\n {6}- node --test$/m);
  // an .xpi here would pass for the signed build in web-ext-artifacts/
  assert.match(taskfile, /^ {2}SOURCE_ZIP: '\{\{\.ARTIFACTS\}\}\/source-\{\{\.RELEASE_VERSION\}\}\.zip'$/m);
  assert.match(taskfile, /^ {2}sign:\n(?: {4}.*\n)*? {4}cmds:\n {6}- 'test -z "\$\(git status --porcelain\)" \|\| /m);
  assert.match(taskfile, /^ {6}- git archive --format=zip HEAD -o \{\{\.SOURCE_ZIP\}\}$/m);
  assert.match(taskfile, / sign .*--upload-source-code \{\{\.SOURCE_ZIP\}\}'$/m);
  // a signed xpi is never reused on a fresh runner
  assert.doesNotMatch(taskfile, /^ {4}status:$/m);
});

test('task sign refuses to run without a version or the AMO credentials', () => {
  const sign = read('Taskfile.yml').match(/^ {2}sign:\n(?:(?: {4}.*)?\n)*/m)[0];
  const checks = [...sign.matchAll(/^ {6}- sh: (.*)$/gm)].map((m) => m[1]);
  assert.equal(checks.length, 2);
  // the parent's values must not leak in, as the suite runs inside task sign
  const passes = (check, env) => spawnSync('bash', ['-c', check], { env: { PATH: process.env.PATH, ...env } }).status === 0;

  // a tag sets the version; without one a sign would burn the placeholder on AMO
  assert.ok(!passes(checks[0], {}));
  assert.ok(!passes(checks[0], { RELEASE_VERSION: '' }));
  assert.ok(passes(checks[0], { RELEASE_VERSION: '1.2.3' }));

  const both = { WEB_EXT_API_KEY: 'key', WEB_EXT_API_SECRET: 'secret' };
  assert.ok(passes(checks[1], both));
  assert.ok(!passes(checks[1], { ...both, WEB_EXT_API_KEY: '' }));
  assert.ok(!passes(checks[1], { ...both, WEB_EXT_API_SECRET: '' }));
  assert.ok(!passes(checks[1], {}));
});

test('task install:debug covers every platform and hands WSL to the Windows Firefox', () => {
  const run = read('Taskfile.yml').match(/^ {2}install:debug:\n(?: {4}.*\n| {6,}.*\n|\n)*/m)[0];
  assert.match(run, /^ {6}- node scripts\/build\.js$/m);
  assert.match(run, /platforms: \[darwin, windows\]/);
  assert.match(run, /platforms: \[linux\]/);
  assert.match(run, /WSL_DISTRO_NAME/);
  // web-ext from WSL would start the Linux Firefox, or fail on Linux paths with the Windows one
  assert.match(run, /powershell\.exe .*-File "\$script" -Path "\$dist"/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'install-debug.ps1')));
});

test('tsconfig stays strict, erasable and covers src', () => {
  const { compilerOptions, include } = JSON.parse(read('tsconfig.json'));
  assert.equal(compilerOptions.strict, true);
  assert.equal(compilerOptions.erasableSyntaxOnly, true);
  assert.deepEqual(include, ['src']);
});

test('manifest is MV2 with permissions exactly storage, tabs, sessions', () => {
  assert.equal(manifest.manifest_version, 2);
  assert.deepEqual([...manifest.permissions].sort(), ['sessions', 'storage', 'tabs']);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
});

// rendered note content (markdown images, mermaid image shapes, HTML labels
// and CSS) must not make extension pages load remote URLs: default-src covers
// every fetch type not listed; mermaid sets inline styles and <style> elements
test('manifest CSP allows only local loads plus data: and blob: images', () => {
  assert.equal(manifest.content_security_policy,
    "script-src 'self'; object-src 'self'; default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'");
  const directives = Object.fromEntries(manifest.content_security_policy.split(';')
    .map((d) => d.trim().split(/\s+/)).map(([name, ...srcs]) => [name, srcs]));
  for (const [name, srcs] of Object.entries(directives)) {
    for (const src of srcs) {
      assert.match(src, /^(?:'self'|'none'|'unsafe-inline'|data:|blob:)$/, `${name} ${src}`);
    }
  }
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.deepEqual(directives['img-src'], ["'self'", 'data:', 'blob:']);
});

// AMO rejects new add-ons without this declaration
test('manifest declares that no data is collected', () => {
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
});

test('extension sources contain no network calls or remote URLs', () => {
  const banned = new RegExp(`${networkAPIs}|https?:\\/\\/|\\/\\/[a-z0-9.-]+\\.[a-z]{2,}\\/`, 'i');
  for (const rel of sources) {
    assert.doesNotMatch(read(rel), banned, rel);
  }
});

// third-party code carries URLs in comments and docs, so only network APIs are banned
test('the build contains no network APIs', () => {
  const banned = new RegExp(networkAPIs);
  const files = walk(dist).filter((rel) => /\.(?:js|css|html)$/.test(rel));
  assert.ok(files.includes('note/note.js'));
  // the scan is only worth something on the bundle holding the third-party code
  for (const name of ['highlightAuto', 'defineMIME', 'walkTokens']) assert.ok(built('note', 'note.js').includes(name), name);
  assert.ok(built('recovery', 'recovery.js').includes('zipSync'));
  assert.ok(built('recovery', 'recovery.js').includes('inflate_fast'));
  // fflate's async API spawns Workers; only its sync API may reach the pages
  for (const rel of files) assert.doesNotMatch(built(rel), /new Worker\b/, rel);
  for (const rel of files) {
    assert.doesNotMatch(built(rel), banned, rel);
  }
});

test('network API check allows fetch methods and rejects fetch calls', () => {
  const banned = new RegExp(networkAPIs);
  for (const ok of ['a.fetch()', 'this.fetch(x)', 'fetch(){return 1}', 'class P{fetch() {}}', 'prefetch(x)', '$fetch(x)']) {
    assert.doesNotMatch(ok, banned, ok);
  }
  for (const bad of ['fetch(url)', ' fetch (url)', 'await fetch(u)', 'window.fetch(u)', 'globalThis.fetch(u)', 'self.fetch(u)', 'x=fetch()']) {
    assert.match(bad, banned, bad);
  }
});

test('manifest icons are PNGs', () => {
  const icons = [...Object.values(manifest.icons), ...Object.values(manifest.browser_action.default_icon)];
  for (const rel of icons) {
    const buf = fs.readFileSync(path.join(root, rel));
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], rel);
  }
});

// AMO wants a 128px icon for the listing, and the pages name their tab icons in
// <head>, so a page without them shows the generic one
test('the manifest has a 128px icon and every page a tab icon', () => {
  assert.equal(manifest.icons['128'], 'icons/icon-128.png');
  const png = (rel) => {
    const buf = fs.readFileSync(path.join(root, rel));
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  };
  for (const [size, rel] of Object.entries(manifest.icons)) {
    assert.deepEqual(png(rel), [Number(size), Number(size)], rel);
  }
  for (const page of pages) {
    const head = built(page).match(/<head>([\s\S]*?)<\/head>/)[1];
    for (const size of [16, 32]) {
      assert.match(head, new RegExp(`<link rel="icon" type="image/png" sizes="${size}x${size}" href="\\.\\./icons/icon-${size}\\.png">`), page);
    }
  }
});

// every __MSG_ in the manifest has a message in the default locale, or Firefox
// shows the placeholder itself
test('manifest strings come from the default locale', () => {
  assert.equal(manifest.default_locale, 'en');
  const messages = JSON.parse(read('_locales', 'en', 'messages.json'));
  const keys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), ['browserActionTitle', 'extensionDescription', 'extensionName']);
  for (const key of keys) assert.ok(messages[key]?.message, key);
  assert.equal(messages.extensionName.message, 'tabnotes');
});

// the toolbar button opens a note tab via browserAction.onClicked, which
// fires only without a popup
test('manifest has a background script, an options page and no popup', () => {
  assert.equal(manifest.browser_action.default_popup, undefined);
  assert.deepEqual(manifest.background.scripts, ['background.js']);
  assert.equal(manifest.options_ui.open_in_tab, true);
});

// storage.local.getKeys needs Firefox 143; the 24h purge interval needs a
// background page that is never unloaded
test('manifest requires Firefox 143 and a persistent background page', () => {
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '143.0');
  assert.notEqual(manifest.background.persistent, false);
});

// user data goes through textContent everywhere but the escaped preview
test('the note preview is the only HTML sink in extension sources', () => {
  const sink = /\.(?:innerHTML|outerHTML)\s*\+?=|\[\s*['"`](?:inner|outer)HTML['"`]\s*\]|insertAdjacentHTML|setHTML|srcdoc|DOMParser|parseHTMLUnsafe|document\.write|createContextualFragment/g;
  const hits = sources.flatMap((rel) => [...read(rel).matchAll(sink)].map((m) => `${rel}: ${m[0]}`));
  assert.deepEqual(hits, ['src/note/note.ts: .innerHTML =']);
  assert.match(read('src', 'note', 'note.ts'), /previewEl\.innerHTML = previewBlocks\(/);
  const forms = ['a.innerHTML = x', 'a.outerHTML += x', "a['innerHTML'] = x", 'a.setHTML(x)', 'f.srcdoc = x', 'new DOMParser()',
    'Document.parseHTMLUnsafe(x)', 'a.insertAdjacentHTML(p, x)', 'document.write(x)', 'r.createContextualFragment(x)'];
  for (const f of forms) assert.match(f, new RegExp(sink.source), f);
});

// the preview's direct children are block wrappers, which have no margin
test('the first preview block loses its top margin through the wrapper', () => {
  assert.match(read('src', 'note', 'note.css'), /\.preview > :first-child > :first-child \{\s*margin-top: 0;/);
});

// no fake layout shows these: without position the blocks' offsetTop, which
// scroll sync reads, is not measured from the preview, and the copy button's
// reveal rules are what make it visible at all
test('the preview rules that only a real layout would show', () => {
  const css = read('src', 'note', 'note.css');
  assert.match(css, /\.preview \{\s*position: relative;/);
  assert.match(css, /\.code-block \{\s*position: relative;/);
  assert.match(css, /\.code-block \.copy \{[^}]*position: absolute;[^}]*opacity: 0;/);
  assert.match(css, /\.code-block:hover \.copy,\s*\.code-block \.copy:focus-visible \{\s*opacity: 1;/);
});

// no fake layout shows this: an in-flow hint moves the panes when it opens and
// closes, so a click into the editor would land somewhere else
test('the rename hint sits over the panes', () => {
  const css = read('src', 'note', 'note.css');
  assert.match(css, /\.header \{\s*position: relative;/);
  assert.match(css, /\.title-hint \{\s*position: absolute;/);
});

// stop removes tabindex, so a stopped tab's title no longer looks editable
test('only a title that can be renamed shows the text cursor', () => {
  assert.match(read('src', 'note', 'note.css'), /\.header \.title\[tabindex\] \{\s*cursor: text;/);
});

// no fake layout shows these: a row must stay one line, and its actions must
// not shift it, yet stay reachable by keyboard and on touch
test('the All notes row rules that only a real layout would show', () => {
  const css = read('src', 'recovery', 'recovery.css');
  assert.match(css, /\.name,\s*\.preview \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
  assert.match(css, /\.actions \{[^}]*position: absolute;[^}]*opacity: 0;/);
  assert.match(css, /\.entry:hover \.actions,\s*\.entry:focus-within \.actions \{\s*opacity: 1;/);
  assert.match(css, /@media \(hover: none\) \{\s*\.actions \{[^}]*opacity: 1;/);
  assert.match(css, /\.top \{\s*position: sticky;/);
  assert.match(css, /\.date,\s*\.days,\s*\.temporary \{\s*flex-shrink: 0;/);
  assert.match(css, /\.header \{[^}]*white-space: nowrap;/);
  assert.match(css, /@media \(max-width: 720px\) \{\s*\.header \{\s*flex-wrap: wrap;/);
});

// the note page loads mermaid itself on the first diagram, so the HTML check
// above does not see that path
// get(null) would read the bytes of every image; the harnesses only see the
// paths they run, so this holds for every path
test('no extension source loads all of storage', () => {
  const loadAll = /storage\s*\.\s*local\s*\.\s*get\(\s*(?:null|undefined)?\s*\)/;
  for (const bad of ['browser.storage.local.get()', 'browser.storage.local.get(null)', 'storage.local.get( undefined )']) {
    assert.match(bad, loadAll, bad);
  }
  for (const ok of ['browser.storage.local.get(k)', "browser.storage.local.get([key, 'settings'])"]) {
    assert.doesNotMatch(ok, loadAll, ok);
  }
  for (const rel of sources) {
    assert.doesNotMatch(read(rel), loadAll, rel);
  }
});

test('preview images fit the pane', () => {
  assert.match(built('note', 'note.css'), /\.preview img\s*\{\s*max-width: 100%;\s*height: auto;\s*\}/);
});

test('the mermaid script the note page loads exists under vendor', () => {
  const refs = [...built('note', 'note.js').matchAll(/["'](\.\.\/vendor\/[^"']+\.js)["']/g)].map((m) => m[1]);
  assert.deepEqual(refs, ['../vendor/mermaid.min.js']);
  assert.ok(fs.existsSync(path.join(dist, 'note', refs[0])));
});

test('font size literals in the options field and note.css match fontSizeFrom', () => {
  const { fontSizeFrom } = require('../src/lib/notes.ts');
  const input = read('src', 'options', 'options.html').match(/<input id="font-size"[^>]*>/)[0];
  assert.equal(Number(input.match(/\smin="(\d+)"/)[1]), fontSizeFrom(0));
  assert.equal(Number(input.match(/\smax="(\d+)"/)[1]), fontSizeFrom(1e9));
  assert.match(read('src', 'note', 'note.css'), new RegExp(`--note-font-size: ${fontSizeFrom(undefined)}px;`));
});

test('pages have no inline scripts or on* handlers', () => {
  for (const page of pages) {
    const html = built(page);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(m[1], /\bsrc=/, `${page}: inline script`);
      assert.equal(m[2].trim(), '', `${page}: inline script body`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${page}: on* handler`);
  }
});

// a blocking script ahead of the stylesheet is what sets data-theme before the
// first paint; async, defer or a place after the stylesheet would allow a flash
test('every page loads theme.js in head, before its stylesheet', () => {
  for (const page of pages) {
    const head = built(page).match(/<head>([\s\S]*?)<\/head>/)[1];
    const script = head.indexOf('<script src="../theme.js"></script>');
    const style = head.indexOf('<link rel="stylesheet"');
    assert.notEqual(script, -1, page);
    assert.notEqual(style, -1, page);
    assert.ok(script < style, page);
  }
});

// pages toggle visibility with the hidden attribute, which class display rules
// (e.g. .editor { display: flex }) would otherwise override
test('page stylesheets force [hidden] to display none', () => {
  for (const css of pageStyles) {
    assert.match(built(css), /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/, css);
  }
});

// .error comes from base.css, imported before note.css's own .message
test('the note load error keeps its colour over .message', () => {
  assert.match(built('note', 'note.css'), /\.message\.error\s*\{\s*color: var\(--color-danger\);?\s*\}/);
});

test('each built page stylesheet includes the tokens', () => {
  const tokens = [...read('src', 'styles', 'base.css').matchAll(/^ {2}(--[\w-]+):/gm)].map((m) => m[1]);
  assert.ok(tokens.includes('--color-text'), 'token list parsed');
  for (const css of pageStyles) {
    for (const token of tokens) assert.ok(built(css).includes(`${token}:`), `${css}: ${token}`);
    // a misspelled var() is not a build error, the declaration just drops out
    const known = new Set([...tokens, '--note-font-size']);
    for (const m of built(css).matchAll(/var\((--[\w-]+)/g)) assert.ok(known.has(m[1]), `${css}: ${m[1]}`);
  }
});

const colourCode = /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i;

test('every colour token has a light and a dark value', () => {
  const base = read('src', 'styles', 'base.css');
  const colours = [...base.matchAll(/^ {2}--color-[\w-]+:.*$/gm)].map((m) => m[0]);
  assert.ok(colours.length > 0, 'colour tokens parsed');
  for (const line of colours) {
    const [, light, dark] = line.match(/: light-dark\((#[\da-f]{3,8}), (#[\da-f]{3,8})\);$/) ?? [];
    assert.ok(light, line);
    assert.notEqual(light, dark, line);
  }
  // a colour outside the tokens would stay the same in both modes
  assert.doesNotMatch(base.replace(/^ {2}--color-.*$/gm, ''), colourCode);
});

test('each built stylesheet follows the system and pins the explicit modes', () => {
  for (const css of pageStyles) {
    const src = built(css);
    assert.match(src, /:root\s*\{\s*color-scheme: light dark;/, css);
    assert.match(src, /:root\[data-theme="?light"?\]\s*\{\s*color-scheme: light;\s*\}/, css);
    assert.match(src, /:root\[data-theme="?dark"?\]\s*\{\s*color-scheme: dark;\s*\}/, css);
    // esbuild must pass it through: lowering would turn the tokens into something else
    assert.ok(src.includes('--color-text: light-dark('), css);
  }
});

test('page stylesheets take colours and button styles from base.css', () => {
  for (const css of pageStyles) {
    const src = read('src', css);
    assert.doesNotMatch(src, colourCode, css);
    assert.doesNotMatch(src, /\bbutton\b/, css);
  }
});

const cssRules = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2] }));
const declarations = (body) => body.split(';').map((d) => d.trim()).filter(Boolean)
  .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]);

// a named colour needs no list here: what stays of a colour-valued declaration
// after tokens, sizes and keywords is a literal
test('stylesheets name no colour in a colour property', () => {
  const colourProperty = /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|text-decoration(?:-color)?|caret-color|accent-color|fill|stroke)$/;
  const allowed = /var\(--[\w-]+\)|!important|-?[\d.]+(?:px|em|rem|%)?|\b(?:transparent|inherit|none|currentcolor|solid|dashed|dotted|underline)\b/gi;
  const decls = [...pageStyles, 'styles/base.css'].flatMap((css) => cssRules(read('src', css))
    .flatMap((r) => declarations(r.body)).map(([property, value]) => ({ css, property, value })))
    .filter(({ property }) => colourProperty.test(property));
  assert.ok(decls.length > 0, 'declarations parsed');
  for (const { css, property, value } of decls) {
    assert.equal(value.replace(allowed, '').trim(), '', `${css}: ${property}: ${value}`);
  }
});

// only the first paint may depend on it: storage is the source of truth
test('localStorage is read only by theme.ts', () => {
  const users = sources.filter((rel) => read(rel).includes('localStorage'));
  assert.deepEqual(users, [path.join('src', 'theme.ts')]);
});

const colourLiteral = new RegExp(`${colourCode.source}|(?<![\\w-])(?:white|black|blue|silver|gold|orange)(?![\\w-])`, 'i');
const noteRules = cssRules(read('src', 'note', 'note.css'));

// a colour left to the third-party file would stay the same in dark mode
test('note.css overrides every coloured CodeMirror and highlight.js selector', () => {
  // background-color answers background, border-left-color answers border-left
  const pair = (selector, property) => `${selector} | ${property.replace(/-color$/, '')}`;
  const overridden = new Set(noteRules.flatMap((r) => r.selectors
    .flatMap((s) => declarations(r.body).map(([property]) => pair(s, property)))));
  const coloured = (rel) => cssRules(read('node_modules', ...rel)).flatMap((r) => declarations(r.body)
    .filter(([, value]) => colourLiteral.test(value))
    .flatMap(([property]) => r.selectors.map((selector) => ({ selector, property }))));
  const unused = new Set([
    // no fat cursor, rulers, gutter markers, matchtags or active line in the editor options
    '.cm-fat-cursor .CodeMirror-cursor', '.CodeMirror-ruler', '.CodeMirror-guttermarker',
    '.CodeMirror-guttermarker-subtle', '.CodeMirror-matchingtag', '.CodeMirror-activeline-background',
    // no diff mode, the only source of these tokens
    '.cm-positive', '.cm-negative',
    // ::selection in note.css comes later with the same specificity, and Firefox treats both alike
    '.CodeMirror-line::-moz-selection', '.CodeMirror-line > span::-moz-selection', '.CodeMirror-line > span > span::-moz-selection',
    // take the colour of the shorter selector in the same note.css rule
    '.hljs-meta .hljs-keyword', '.hljs-meta .hljs-string', '.hljs-title.class_', '.hljs-title.class_.inherited__', '.hljs-title.function_',
    // .preview pre replaces its white background
    pair('.hljs', 'background'),
  ]);
  const pairs = [
    ['codemirror', 'lib', 'codemirror.css'],
    ['codemirror', 'addon', 'dialog', 'dialog.css'],
    ['highlight.js', 'styles', 'github.css'],
  ].flatMap(coloured);
  assert.ok(pairs.some((p) => p.selector === '.CodeMirror-selected') && pairs.some((p) => p.selector === '.hljs-keyword'), 'rules parsed');
  for (const { selector, property } of pairs) {
    const p = pair(selector, property);
    assert.ok(unused.has(selector) || unused.has(p) || overridden.has(p), p);
  }
});

test('note.css keeps the non-colour declarations of the highlight.js theme', () => {
  const kept = cssRules(read('node_modules', 'highlight.js', 'styles', 'github.css'))
    .filter((r) => r.selectors.some((s) => s.startsWith('.hljs-')))
    .flatMap((r) => declarations(r.body).filter(([, value]) => !colourLiteral.test(value))
      .flatMap(([property, value]) => r.selectors.map((s) => `${s} { ${property}: ${value} }`)));
  assert.ok(kept.includes('.hljs-section { font-weight: bold }'), 'rules parsed');
  const have = new Set(noteRules.flatMap((r) => r.selectors
    .flatMap((s) => declarations(r.body).map(([property, value]) => `${s} { ${property}: ${value} }`))));
  for (const d of kept) assert.ok(have.has(d), d);
});

// its inline colour cannot show up in the comparison with the stylesheets above
test('note.css overrides the inline colour of the search hint', () => {
  for (const rel of ['search.js', 'jump-to-line.js']) {
    assert.match(read('node_modules', 'codemirror', 'addon', 'search', rel), /color: #\w+"[^>]*CodeMirror-search-hint/, rel);
  }
  const hint = noteRules.find((r) => r.selectors.includes('.CodeMirror-search-hint'));
  assert.deepEqual(declarations(hint.body), [['color', 'var(--color-muted) !important']]);
});

test('every syntax, selection and search token is used by the note stylesheet', () => {
  const css = read('src', 'note', 'note.css');
  const tokens = [...read('src', 'styles', 'base.css').matchAll(/^ {2}(--color-(?:syntax|selection|search)[\w-]*):/gm)];
  assert.ok(tokens.length > 0, 'tokens parsed');
  for (const [, token] of tokens) assert.ok(css.includes(`var(${token})`), token);
});

// CodeMirror's search dialog holds a bare input and buttons
test('the built note.css scopes every button, input and select rule', () => {
  const rules = [...built('note', 'note.css').matchAll(/^([^{}\s][^{}]*)\{/gm)];
  const controls = rules.flatMap((m) => m[1].split(',')).map((s) => s.trim())
    .filter((s) => /(?:^|[\s>+~])(?:button|input|select)(?:[:.[]\S*)?$/.test(s));
  assert.ok(controls.includes('.header button'));
  assert.ok(controls.includes('.field select'));
  for (const s of controls) assert.match(s, /^\.(?:header|banner|field|CodeMirror\S*) /, s);
});
