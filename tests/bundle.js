// Bundles a page entry the way scripts/build.js does, for the vm harnesses.
'use strict';

const { after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { build, bundleOptions } = require('../scripts/build.js');

// bundle returns the compiled entry (a path relative to the repo root);
// options are extra esbuild options
function bundle(entry, options = {}) {
  const { outputFiles } = esbuild.buildSync({ ...bundleOptions, ...options, entryPoints: [entry], write: false });
  return new vm.Script(outputFiles[0].text, { filename: entry });
}

// tempBuild builds the extension into a temp dir, for a test file to read and
// removed when that file ends
function tempBuild() {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'tabnotes-dist-'));
  after(() => fs.rmSync(dist, { recursive: true }));
  build(dist);
  return dist;
}

module.exports = { bundle, tempBuild };
