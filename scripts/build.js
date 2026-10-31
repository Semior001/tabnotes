// Builds the unpacked extension: bundles src/ with esbuild and copies the
// static files, keeping the paths page URLs and the manifest rely on.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

// shared with tests/bundle.js, so the harnesses run what ships; not minified,
// to keep the output reviewable and the network-API scan meaningful
const bundleOptions = {
  absWorkingDir: root,
  bundle: true,
  format: 'iife',
  minify: false,
  target: 'firefox143',
};

const entries = [
  'src/background.ts',
  'src/theme.ts',
  'src/note/note.ts',
  'src/options/options.ts',
  'src/recovery/recovery.ts',
  'src/note/note.css',
  'src/options/options.css',
  'src/recovery/recovery.css',
];
const pages = ['note/note.html', 'options/options.html', 'recovery/recovery.html'];
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
// the suffix keeps cytoscape's license-update.mjs out and LICENSE-MPL in
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(-[a-z0-9-]+)?(\.(md|txt))?$/i;
// these two hold their MIT text only in the README
const README_LICENSES = ['fastdom', 'strictdom'];

// One section per non-dev lockfile entry. Entries are keyed by path, as a
// nested package can differ from the top-level one of the same name, and the
// label comes from the installed package.
function thirdPartyNotices(lockfile, dir) {
  const readmeLicense = (name, pkgDir) => {
    if (!README_LICENSES.includes(name)) throw new Error(`no license file in ${name}`);
    const readme = fs.readFileSync(path.join(pkgDir, 'README.md'), 'utf8');
    const start = readme.search(/^## License/m);
    if (start === -1) throw new Error(`no license section in the README of ${name}`);
    return readme.slice(start);
  };
  const rule = '='.repeat(80);
  const sections = [];
  for (const [key, entry] of Object.entries(lockfile.packages)) {
    if (key === '' || entry.dev) continue;
    const pkgDir = path.join(dir, key);
    if (entry.optional && !fs.existsSync(pkgDir)) continue;
    const { name, version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const texts = fs.readdirSync(pkgDir).filter((file) => LICENSE_FILE.test(file)).sort()
      .map((file) => fs.readFileSync(path.join(pkgDir, file), 'utf8'));
    if (texts.length === 0) texts.push(readmeLicense(name, pkgDir));
    const body = texts.map((text) => text.trim()).join('\n\n');
    sections.push(`${rule}\n${name} ${version}\n${rule}\n\n${body}\n`);
  }
  return sections.join('\n');
}

// build empties outdir so a removed file cannot linger in the package, but
// keeps .amo-upload-uuid: web-ext sign stores it there, and the release
// workflow restores it there, so a re-run after a failure between validation
// and submit reuses the upload. An empty or missing version keeps the
// placeholder of the root manifest.
function build(outdir, version) {
  if (version && !VERSION.test(version)) {
    throw new Error(`invalid version: ${version}`);
  }
  fs.mkdirSync(outdir, { recursive: true });
  for (const name of fs.readdirSync(outdir)) {
    if (name === '.amo-upload-uuid') continue;
    fs.rmSync(path.join(outdir, name), { recursive: true });
  }
  esbuild.buildSync({ ...bundleOptions, entryPoints: entries, outbase: 'src', outdir });
  const manifest = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  const stamped = version ? JSON.stringify({ ...JSON.parse(manifest), version }, null, 2) : manifest;
  fs.writeFileSync(path.join(outdir, 'manifest.json'), stamped);
  fs.cpSync(path.join(root, 'icons'), path.join(outdir, 'icons'), { recursive: true });
  for (const page of pages) fs.copyFileSync(path.join(root, 'src', page), path.join(outdir, page));
  // the note page loads mermaid itself on the first diagram, so it is not bundled
  fs.mkdirSync(path.join(outdir, 'vendor'));
  fs.copyFileSync(path.join(root, 'node_modules/mermaid/dist/mermaid.min.js'), path.join(outdir, 'vendor/mermaid.min.js'));
  const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const bundled = fs.readFileSync(path.join(root, 'scripts/mermaid-bundled-licenses.txt'), 'utf8');
  fs.writeFileSync(path.join(outdir, 'THIRD_PARTY_LICENSES.txt'), `${thirdPartyNotices(lockfile, root)}\n${bundled}`);
}

module.exports = { build, bundleOptions, pages, thirdPartyNotices, VERSION };

// read only here: the test suite runs inside task sign with the variable set
if (require.main === module) build(path.join(root, 'dist'), process.env.RELEASE_VERSION);
