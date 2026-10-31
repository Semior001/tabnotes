// Checks of .github/workflows, on file text as there is no YAML dependency, with the logic of the
// run blocks executed under bash against stubs. They hold the workflow side of the release guards:
// a real run cannot be part of `task test`.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VERSION } = require('../scripts/build.js');
const { TAG } = require('../scripts/release-notes.js');
const { gitRepo } = require('./gitrepo.js');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8');
const ci = read('ci.yml');
const release = read('release.yml');
const code = (text) => text.replace(/^\s*#.*\n/gm, '');

// top-level keys start at column 0, jobs at 2 and their step list items at 6
const job = (text, name) => {
  const jobs = text.slice(text.indexOf('\njobs:\n'));
  const start = jobs.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name}`);
  const rest = jobs.slice(start + 1);
  const end = rest.slice(1).search(/^ {2}\S/m);
  return end === -1 ? rest : rest.slice(0, end + 1);
};
const header = (section) => section.slice(0, section.indexOf('\n    steps:\n'));
const steps = (section) => code(section).split(/^ {6}- /m).slice(1);
const step = (section, match) => {
  const found = steps(section).filter((s) => s.includes(match));
  assert.equal(found.length, 1, `one step with ${match}`);
  return found[0];
};
// the shell text of every run key, as bash gets it
const runs = (text) =>
  [...code(text).matchAll(/^( *)(?:- )?run: (.*)\n((?:(?:\1 +.*)?\n)*)/gm)].map((m) => {
    if (!/^[|>]/.test(m[2])) return m[2];
    const pad = m[3].match(/^ */)[0].length;
    return m[3].replace(/\s+$/, '').split('\n').map((line) => line.slice(pad)).join('\n');
  });
const script = (section, match) => {
  const found = runs(step(section, match));
  assert.equal(found.length, 1, `one run with ${match}`);
  return found[0];
};

const guard = job(release, 'guard');
const rel = job(release, 'release');

// gh answers from GH_PRS and GH_RELEASES with the fields it was asked for, as the real one does
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_LOG, JSON.stringify(args) + '\\n');
if (process.env.GH_FAIL) process.exit(1);
const rows = { pr: process.env.GH_PRS, release: process.env.GH_RELEASES }[args[0]];
if (args[1] === 'list') {
  const fields = args[args.indexOf('--json') + 1].split(',');
  const pick = (row) => Object.fromEntries(fields.filter((k) => k in row).map((k) => [k, row[k]]));
  console.log(JSON.stringify(JSON.parse(rows).map(pick)));
}
`;

// a temp repo with gh and task stubs ahead of the real PATH, and a fresh environment, so no secret
// of a surrounding task sign reaches the blocks. Both stubs log one JSON array per call
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabnotes-workflows-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const [bin, temp, repo] = ['bin', 'temp', 'repo'].map((name) => path.join(root, name));
  for (const dir of [bin, temp, repo]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(path.join(bin, 'task'), `#!/bin/sh\nprintf '["%s", "%s"]\\n' "$RELEASE_VERSION" "$*" >> "$CALLS_LOG"\n`, {
    mode: 0o755,
  });
  const { env, git, commit } = gitRepo(repo, [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter), {
    HOME: root,
    RUNNER_TEMP: temp,
    CALLS_LOG: log,
  });
  return {
    root,
    temp,
    repo,
    git,
    commit,
    // -e is how GitHub runs a run block with no shell key
    bash: (block, tag, extra = {}) =>
      spawnSync('bash', ['-e', '-c', block], { cwd: repo, env: { ...env, TAG: tag, ...extra }, encoding: 'utf8' }),
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
  };
}

test('runs reads every run block whole, past blank lines', () => {
  const text =
    'steps:\n      - name: a\n        run: |\n          one\n\n          two ${{ x }}\n\n      - run: three\n';
  assert.deepEqual(runs(text), ['one\n\ntwo ${{ x }}', 'three']);
  assert.ok(runs(release).some((r) => r.includes('merge-base')));
});

test('every action is pinned to a full commit SHA with its version alongside', () => {
  for (const [name, text] of [['ci.yml', ci], ['release.yml', release]]) {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (.*)$/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0, name);
    for (const u of uses) {
      assert.match(u, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${name}: ${u}`);
    }
  }
});

test('the same tool versions run for PRs and releases', () => {
  const pin = (text, re) => {
    const values = [...text.matchAll(re)].map((m) => m[1]);
    assert.ok(values.length > 0, String(re));
    return [...new Set(values)];
  };
  const nodeRe = /^ +node-version: (\d+\.\d+\.\d+)$/gm;
  const taskRe = /^ +version: (\d+\.\d+\.\d+)$/gm;
  assert.deepEqual(pin(ci, nodeRe), pin(release, nodeRe));
  assert.deepEqual(pin(ci, taskRe), pin(release, taskRe));
});

test('workflows start from no permissions and use only the triggers they name', () => {
  for (const text of [ci, release]) {
    assert.match(text, /^permissions: \{\}$/m);
    assert.doesNotMatch(text, /pull_request_target|workflow_dispatch|repository_dispatch|workflow_run|schedule:/);
  }
  assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]\n\n/m);
  assert.match(release, /^on:\n {2}push:\n {4}tags:\n {6}- 'v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\n\n/m);
});

test('job permissions are the listed ones', () => {
  assert.match(job(ci, 'check'), /^ {4}permissions:\n {6}contents: read\n {4}steps:$/m);
  assert.match(guard, /^ {4}permissions:\n {6}contents: read\n {4}steps:$/m);
  assert.match(rel, /^ {4}permissions:\n {6}contents: write\n {6}pull-requests: read\n {4}steps:$/m);
});

test('the PR workflow has no secrets and no environment, and runs what task sign will', () => {
  assert.doesNotMatch(ci, /\bsecrets\b|environment:/);
  assert.match(
    code(ci),
    /^ {6}- run: npm ci\n {6}- run: task test\n {6}- run: RELEASE_VERSION=\S+ node --test tests\/build\.test\.js\n {6}- run: task lint$/m,
  );
});

test('secrets stay in the environment job, each in the one step using it', () => {
  assert.doesNotMatch(guard, /\bsecrets\b|environment:/);
  assert.match(rel, /^ {4}environment: release$/m);
  assert.match(rel, /^ {4}needs: guard$/m);
  // any other mention, toJSON(secrets) or secrets: inherit included, fails this
  assert.deepEqual(code(release).split('\n').filter((line) => /\bsecrets\b/.test(line)).map((line) => line.trim()), [
    'WEB_EXT_API_KEY: ${{ secrets.WEB_EXT_API_KEY }}',
    'WEB_EXT_API_SECRET: ${{ secrets.WEB_EXT_API_SECRET }}',
    'TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
    'CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
  ]);
  assert.match(code(release), /^env:\n {2}TAG: \$\{\{ github\.ref_name \}\}\n\njobs:$/m);
  for (const section of [guard, rel]) assert.doesNotMatch(header(section), /^ {4}env:/m);

  const sign = step(rel, 'task sign');
  assert.match(sign, /WEB_EXT_API_KEY: /);
  assert.match(sign, /WEB_EXT_API_SECRET: /);
  assert.match(step(rel, 'id: claude'), /TOKEN: /);

  // commit and PR text is untrusted input to Claude
  const notes = step(rel, 'scripts/release-notes.js');
  assert.match(notes, /CLAUDE_CODE_OAUTH_TOKEN: /);
  assert.doesNotMatch(notes, /WEB_EXT|GH_TOKEN|github\.token/);
});

test('both release jobs check the actor, as a re-run skips a guard that passed', () => {
  const actor =
    /^ {4}if: github\.actor == github\.repository_owner && github\.triggering_actor == github\.repository_owner$/m;
  assert.match(guard, actor);
  assert.match(rel, actor);
});

// one table through the guard, scripts/release-notes.js and scripts/build.js, as each holds its own
// copy of the pattern
test('the guard, the notes script and the build take the same strict versions', (t) => {
  const f = sandbox(t);
  const block = script(guard, 'Check the tag format');
  for (const version of ['0.0.0', '1.2.3', '0.10.0', '10.20.30']) {
    assert.equal(f.bash(block, `v${version}`).status, 0, version);
    assert.ok(TAG.test(`v${version}`), version);
    assert.ok(VERSION.test(version), version);
  }
  for (const version of ['1.2', '01.2.3', '1.02.3', '1.2.3-rc1', '1.2.3.4', '1.2.3\n', '$(id)', '']) {
    const r = f.bash(block, `v${version}`);
    assert.equal(r.status, 1, version);
    assert.match(r.stdout, /^::error::/);
    assert.ok(!TAG.test(`v${version}`), version);
    assert.ok(!VERSION.test(version), version);
  }
  for (const tag of ['1.2.3', '$(id)', '']) {
    assert.equal(f.bash(block, tag).status, 1, tag);
    assert.ok(!TAG.test(tag), tag);
  }
});

test('the guard takes only a commit on main', (t) => {
  const f = sandbox(t);
  // origin/main comes from this: the guard runs no git fetch, and has no credentials for one
  assert.match(step(guard, 'actions/checkout@'), /fetch-depth: 0/);
  const block = script(guard, 'merge-base');
  f.git('update-ref', 'refs/remotes/origin/main', f.commit('base'));
  f.git('tag', 'v0.1.0');
  f.git('tag', '-a', '-m', 'annotated', 'v0.1.1');
  f.git('switch', '-c', 'side');
  f.commit('off main');
  f.git('tag', 'v0.1.2');

  assert.equal(f.bash(block, 'v0.1.0').status, 0);
  assert.equal(f.bash(block, 'v0.1.1').status, 0);
  const r = f.bash(block, 'v0.1.2');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error::/);
});

test('the guard takes only the highest version, numerically', (t) => {
  const f = sandbox(t);
  const block = script(guard, 'sort -V');
  f.commit('base');
  for (const tag of ['v0.9.0', 'v0.10.0', 'v0.0.0', 'v9.9.9-rc1', 'v99.0', 'other']) f.git('tag', tag);

  assert.equal(f.bash(block, 'v0.10.0').status, 0);
  for (const tag of ['v0.9.0', 'v0.0.0']) {
    const r = f.bash(block, tag);
    assert.equal(r.status, 1, tag);
    assert.match(r.stdout, /^::error::the tag is not above v0\.10\.0$/m);
  }
  f.git('tag', 'v0.11.0');
  assert.equal(f.bash(block, 'v0.11.0').status, 0);
  assert.equal(f.bash(block, 'v0.10.0').status, 1);
});

test('no credentials stay on disk and no restored npm cache reaches the release job', () => {
  for (const section of [job(ci, 'check'), guard, rel]) {
    assert.match(step(section, 'actions/checkout@'), /persist-credentials: false/);
  }
  const node = step(rel, 'actions/setup-node@');
  assert.doesNotMatch(node, /^ +cache:/m);
  // setup-node turns this on by itself for a package.json with a packageManager field
  assert.match(node, /package-manager-cache: false/);
});

test('no expression is expanded inside a run block', () => {
  for (const text of [ci, release]) {
    for (const block of runs(text)) assert.doesNotMatch(block, /\$\{\{/, block);
  }
});

test('the release job runs its steps in the order the recovery relies on', () => {
  const order = [
    'npm ci',
    'actions/cache/restore@',
    'task sign',
    'actions/upload-artifact@',
    'actions/cache/save@',
    'gh pr list',
    'id: claude',
    '@anthropic-ai/claude-code@',
    'scripts/release-notes.js',
    'gh release create',
  ].map((match) => steps(rel).indexOf(step(rel, match)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(new Set(order).size, order.length);
});

test('one run per tag, and nothing cancels a run that may be signing', () => {
  assert.match(release, /^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}$/m);
  assert.doesNotMatch(release, /cancel-in-progress/);
});

test('the sign step gets the version from the tag', (t) => {
  const f = sandbox(t);
  assert.equal(f.bash(script(rel, 'task sign'), 'v1.2.3').status, 0);
  assert.deepEqual(f.calls(), [['1.2.3', 'sign']]);
});

test('the uuid cache restores and saves the file web-ext reuses, also after a failed sign', () => {
  const key = 'amo-upload-uuid-${{ env.TAG }}-${{ github.run_id }}-${{ github.run_attempt }}';
  const restore = step(rel, 'actions/cache/restore@');
  const save = step(rel, 'actions/cache/save@');
  for (const cache of [restore, save]) {
    assert.ok(cache.includes('path: dist/.amo-upload-uuid\n'));
    assert.ok(cache.includes(`key: ${key}\n`));
  }
  assert.ok(restore.includes('restore-keys: amo-upload-uuid-${{ env.TAG }}-\n'));
  assert.ok(save.includes("if: always() && hashFiles('dist/.amo-upload-uuid') != ''"));
});

test('the token check sees a token, and neither an empty nor a blank one', (t) => {
  const f = sandbox(t);
  const block = script(rel, 'id: claude');
  const output = path.join(f.root, 'output');
  const present = (TOKEN) => {
    fs.rmSync(output, { force: true });
    assert.equal(f.bash(block, 'v1.2.3', { TOKEN, GITHUB_OUTPUT: output }).status, 0);
    return fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : undefined;
  };
  assert.equal(present(''), undefined);
  assert.equal(present(' \n\t'), undefined);
  assert.equal(present('token'), 'present=true\n');
  assert.equal(present(' token\n'), 'present=true\n');
});

test('only the steps around Claude can fail without stopping the job', () => {
  const holding = steps(rel).filter((s) => /^ *continue-on-error: true$/m.test(s));
  assert.deepEqual(holding, [step(rel, '@anthropic-ai/claude-code@'), step(rel, 'scripts/release-notes.js')]);
  // anywhere else, the job level included, shows in the count
  assert.equal(code(release).match(/continue-on-error/g).length, holding.length);

  assert.match(step(rel, '@anthropic-ai/claude-code@'), /claude-code@\d+\.\d+\.\d+$/m);
  assert.match(step(rel, '@anthropic-ai/claude-code@'), /if: steps\.claude\.outputs\.present == 'true'/);
  for (const match of ['gh pr list', 'gh release create']) {
    assert.match(step(rel, match), /GH_TOKEN: \$\{\{ github\.token \}\}/, match);
  }
});

// the real script between stubbed gh calls: a swapped or renamed file breaks the notes or the publish
test('the listed files reach the notes, and the notes and only the xpi reach the release', (t) => {
  const f = sandbox(t);
  fs.mkdirSync(path.join(f.repo, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'release-notes.js'), path.join(f.repo, 'scripts', 'release-notes.js'));
  f.commit('feat: base');
  f.git('tag', 'v0.1.0');
  f.commit('feat: burned');
  f.git('tag', 'v0.1.1');
  const sha = f.commit('wip');
  f.git('tag', 'v0.1.2');
  fs.mkdirSync(path.join(f.repo, 'web-ext-artifacts'));
  for (const name of ['tabnotes-0.1.2.xpi', 'source-0.1.2.zip']) {
    fs.writeFileSync(path.join(f.repo, 'web-ext-artifacts', name), '');
  }

  const listed = f.bash(script(rel, 'gh pr list'), 'v0.1.2', {
    GH_PRS: JSON.stringify([
      { number: 6, title: 'feat: add work', body: 'text', mergeCommit: { oid: sha }, commits: [], unasked: 1 },
    ]),
    GH_RELEASES: JSON.stringify([{ tagName: 'v0.1.0' }]),
  });
  assert.equal(listed.status, 0, listed.stderr);
  const [prs, releases] = f.calls();
  const flag = (call, name) => call[call.indexOf(name) + 1];
  assert.deepEqual(prs.slice(0, 2), ['pr', 'list']);
  assert.equal(flag(prs, '--state'), 'merged');
  assert.equal(flag(prs, '--base'), 'main');
  // gh asks for 100 commits with 100 authors each per PR, which GitHub refuses from 50 PRs up
  assert.ok(Number(flag(prs, '--limit')) < 50, prs.join(' '));
  assert.deepEqual(releases.slice(0, 2), ['release', 'list']);
  // gh lists 30 by default, which could hide the previous release; a draft is no release
  assert.ok(Number(flag(releases, '--limit')) > 30, releases.join(' '));
  assert.ok(releases.includes('--exclude-drafts'));

  const notes = f.bash(script(rel, 'scripts/release-notes.js'), 'v0.1.2');
  assert.equal(notes.status, 0, notes.stderr);
  assert.equal(fs.readFileSync(path.join(f.temp, 'notes.md'), 'utf8'), '### Features\n\n- add work (#6)\n- burned\n');

  const published = f.bash(script(rel, 'gh release create'), 'v0.1.2');
  assert.equal(published.status, 0, published.stderr);
  assert.deepEqual(f.calls().at(-1), [
    'release', 'create', 'v0.1.2', 'web-ext-artifacts/tabnotes-0.1.2.xpi',
    '--verify-tag', '--title', 'v0.1.2', '--notes-file', path.join(f.temp, 'notes.md'),
  ]);
});

test('a failed list warns and leaves the notes to the tags', (t) => {
  const f = sandbox(t);
  const r = f.bash(script(rel, 'gh pr list'), 'v0.1.2', { GH_FAIL: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.match(/^::warning::/gm).length, 2);
});

test('with no notes file the release generates its notes', (t) => {
  const f = sandbox(t);
  fs.mkdirSync(path.join(f.repo, 'web-ext-artifacts'));
  fs.writeFileSync(path.join(f.repo, 'web-ext-artifacts', 'tabnotes-1.2.3.xpi'), '');

  const r = f.bash(script(rel, 'gh release create'), 'v1.2.3');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls(), [[
    'release', 'create', 'v1.2.3', 'web-ext-artifacts/tabnotes-1.2.3.xpi',
    '--verify-tag', '--title', 'v1.2.3', '--generate-notes',
  ]]);
});
