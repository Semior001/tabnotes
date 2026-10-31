// Tests for scripts/release-notes.js: unit tests for the pure logic, then runs in a temp repo.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawnSync } = childProcess;
const { gitRepo } = require('./gitrepo.js');

const {
  parseNotes,
  fallbackNotes,
  previousTag,
  matchPRs,
  notice,
} = require('../scripts/release-notes.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'release-notes.js');
const envelope = (fields) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...fields });
const answer = (notes) => envelope({ structured_output: { notes } });

test('parseNotes reads structured_output and trims it', () => {
  assert.equal(parseNotes(answer('\n- a\n- b\n')), '- a\n- b');
});

test('parseNotes rejects invalid JSON, an error envelope and empty notes', () => {
  assert.throws(() => parseNotes('not json'), SyntaxError);
  assert.throws(() => parseNotes(''), SyntaxError);
  const failed = envelope({ is_error: true, structured_output: { notes: 'x' } });
  assert.throws(() => parseNotes(failed), /claude reported an error/);
  for (const notes of ['', '  \n', 7, null, undefined]) {
    assert.throws(() => parseNotes(answer(notes)), /empty notes/);
  }
  for (const text of ['[]', envelope({})]) {
    assert.throws(() => parseNotes(text), /empty notes/, text);
  }
});

test('fallbackNotes groups features, fixes and other, and skips other conventional types', () => {
  const got = fallbackNotes([
    'feat: add bin',
    'Add dark theme (#7)',
    'fix(note): keep cursor',
    'docs: update readme',
    'feat(recovery)!: drop old format',
    'chore: release v0.5.0',
    'fix!: stop losing notes',
    'refactor: rename helper',
  ]);
  assert.equal(
    got,
    '### Features\n\n- add bin\n- drop old format\n\n' +
      '### Fixes\n\n- keep cursor\n- stop losing notes\n\n' +
      '### Other\n\n- Add dark theme (#7)',
  );
});

test('fallbackNotes leaves out empty sections', () => {
  assert.equal(fallbackNotes(['fix: a', 'chore: b']), '### Fixes\n\n- a');
  assert.equal(fallbackNotes(['Plain title', 'chore: b']), '### Other\n\n- Plain title');
});

test('fallbackNotes strips only the prefix when the entry has its own "(...):"', () => {
  assert.equal(fallbackNotes(['fix(a): handle (b): c']), '### Fixes\n\n- handle (b): c');
});

test('fallbackNotes lists everything when only skipped types exist', () => {
  assert.equal(fallbackNotes(['docs: a', 'chore: b']), '- docs: a\n- chore: b');
});

test('fallbackNotes puts lookalike subjects into Other', () => {
  const subjects = ['feature-x: add thing', 'fixes: typo', 'feat add thing', 'Feat: upper'];
  assert.equal(fallbackNotes(subjects), `### Other\n\n${subjects.map((s) => `- ${s}`).join('\n')}`);
});

test('previousTag takes the highest lower tag, numerically', () => {
  const tags = ['v0.9.0', 'v0.10.0', 'v0.2.0', 'v1.0.0'];
  assert.equal(previousTag('v0.11.0', tags), 'v0.10.0');
  assert.equal(previousTag('v0.10.0', tags), 'v0.9.0');
  assert.equal(previousTag('v2.0.0', tags), 'v1.0.0');
});

test('previousTag skips a burned tag when the releases are known', () => {
  const tags = ['v0.4.0', 'v0.5.0', 'v0.5.1'];
  assert.equal(previousTag('v0.5.2', tags, new Set(['v0.4.0', 'v0.5.0'])), 'v0.5.0');
  assert.equal(previousTag('v0.5.2', tags, undefined), 'v0.5.1');
  assert.equal(previousTag('v0.5.2', tags, new Set()), undefined);
});

test('previousTag is undefined with no lower tag and ignores tags that are no version', () => {
  assert.equal(previousTag('v0.1.0', ['v0.1.0', 'v0.2.0', '']), undefined);
  assert.equal(previousTag('v0.2.0', ['v0.1.0-rc1', 'v0x', 'v1']), undefined);
});

test('matchPRs replaces the commits of each merge style and keeps the rest', () => {
  const commits = [
    { sha: 'direct', subject: 'fix: direct push' },
    { sha: 'squash', subject: 'feat: squashed (#1)' },
    { sha: 'branch', subject: 'feat: branch work' },
    { sha: 'rebased1', subject: 'feat: rebased first' },
    { sha: 'rebased2', subject: 'feat: rebased last' },
  ];
  const shas = new Set([...commits.map((c) => c.sha), 'mergecommit']);
  const prs = [
    { number: 1, title: 'squash', mergeCommit: { oid: 'squash' }, commits: [{ oid: 'orig' }] },
    { number: 2, title: 'merge', mergeCommit: { oid: 'mergecommit' }, commits: [{ oid: 'branch' }] },
    {
      number: 3,
      title: 'rebase',
      mergeCommit: { oid: 'rebased2' },
      commits: [{ oid: 'orig1' }, { oid: 'orig2' }],
    },
    { number: 4, title: 'older', mergeCommit: { oid: 'old' }, commits: [{ oid: 'old1' }] },
  ];
  const got = matchPRs(prs, shas, commits);
  assert.deepEqual(got.prs.map((pr) => pr.number), [1, 2, 3]);
  assert.deepEqual(got.subjects, ['fix: direct push', 'feat: rebased first']);
});

test('matchPRs finds a PR by a commit alone and takes one with no merge commit', () => {
  const commits = [{ sha: 'a', subject: 'x' }];
  const pr = { number: 1, title: 't', mergeCommit: null, commits: [{ oid: 'a' }] };
  assert.deepEqual(matchPRs([pr], new Set(['a']), commits), { prs: [pr], subjects: [] });
});

test('notice stays one line and one command', () => {
  assert.equal(notice('a\r\n::error::b 100%'), '::notice::a%0D%0A::error::b 100%25');
});

// A temp repo with stubs on PATH next to links to git and node, so the real claude cannot be
// reached.
function fixture(t, claudeSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabnotes-notes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  const seen = path.join(root, 'seen.json');
  fs.mkdirSync(bin);
  fs.mkdirSync(repo);
  const gitPath = process.env.PATH.split(path.delimiter)
    .map((d) => path.join(d, 'git'))
    .find((p) => fs.existsSync(p));
  fs.symlinkSync(gitPath, path.join(bin, 'git'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  if (claudeSource !== undefined) {
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
  args: process.argv.slice(2),
  stdin: fs.readFileSync(0, 'utf8'),
  env: process.env,
}));
${claudeSource}
`,
      { mode: 0o755 },
    );
  }

  const { env, git, commit } = gitRepo(repo, bin, { HOME: root });

  const out = path.join(root, 'notes.md');
  const file = (name, value) => {
    const p = path.join(root, name);
    fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
    return p;
  };
  // absent files unless given, as when the gh step failed
  const run = (tag, { prs, releases, extraEnv = {} } = {}) =>
    spawnSync(
      process.execPath,
      [
        SCRIPT,
        tag,
        prs === undefined ? path.join(root, 'no-prs.json') : file('prs.json', prs),
        releases === undefined ? path.join(root, 'no-releases.json') : file('releases.json', releases),
        out,
      ],
      { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' },
    );
  return {
    git,
    commit,
    run,
    notes: () => fs.readFileSync(out, 'utf8'),
    wrote: () => fs.existsSync(out),
    claude: () => (fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen, 'utf8')) : undefined),
  };
}

const TOKEN = { extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'token' } };
const releases = (...tags) => tags.map((tagName) => ({ tagName }));

test('the range starts at the last release, past a burned tag', (t) => {
  const f = fixture(t);
  f.commit('feat: in v0.1.0');
  f.git('tag', 'v0.1.0');
  f.commit('feat: after the release');
  f.git('tag', 'v0.1.1'); // burned: signed by AMO, never released
  f.commit('fix: after the burned tag');
  f.git('tag', 'v0.1.2');

  const r = f.run('v0.1.2', { releases: releases('v0.1.0') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    f.notes(),
    '### Features\n\n- after the release\n\n### Fixes\n\n- after the burned tag\n',
  );
});

test('without a usable releases file the range starts at the highest lower tag', (t) => {
  for (const given of [undefined, 'not json', '{}']) {
    const f = fixture(t);
    f.commit('feat: one');
    f.git('tag', 'v0.1.0');
    f.commit('feat: two');
    f.git('tag', 'v0.1.1');
    f.commit('feat: three');
    f.git('tag', 'v0.1.2');

    assert.equal(f.run('v0.1.2', { releases: given }).status, 0);
    assert.equal(f.notes(), '### Features\n\n- three\n');
  }
});

test('with no earlier tag the range is all history', (t) => {
  const f = fixture(t);
  f.commit('feat: one');
  f.commit('fix: two');
  f.git('tag', 'v0.1.0');

  assert.equal(f.run('v0.1.0').status, 0);
  assert.equal(f.notes(), '### Features\n\n- one\n\n### Fixes\n\n- two\n');
});

test('the commits stop at the tag, not at HEAD', (t) => {
  const f = fixture(t);
  f.commit('feat: one');
  f.git('tag', 'v0.1.0');
  f.commit('feat: two');
  f.git('tag', 'v0.1.1');
  f.commit('feat: after the tag');

  assert.equal(f.run('v0.1.1').status, 0);
  assert.equal(f.notes(), '### Features\n\n- two\n');
});

test('an empty range says so and skips claude', (t) => {
  const f = fixture(t, `process.stdout.write(${JSON.stringify(answer('- x'))});`);
  f.commit('feat: one');
  f.git('tag', 'v0.1.0');
  f.git('tag', 'v0.1.1');

  const r = f.run('v0.1.1', TOKEN);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.notes(), 'No changes since v0.1.0.\n');
  assert.equal(f.claude(), undefined);
  assert.match(r.stdout, /^::notice::.*empty range$/m);
});

test('a merge-style PR replaces its commits, while merges and other commits stay out or listed', (t) => {
  const f = fixture(t);
  f.commit('feat: base');
  f.git('tag', 'v0.1.0');
  f.commit('fix: direct push');
  f.git('switch', '-c', 'work');
  const branch = f.commit('wip');
  f.git('switch', 'main');
  f.git('merge', '--no-ff', '-m', 'Merge pull request #5 from x/work', 'work');
  const merge = f.git('rev-parse', 'HEAD');
  f.git('tag', 'v0.1.1');

  const prs = [
    { number: 5, title: 'feat: add work', mergeCommit: { oid: merge }, commits: [{ oid: branch }] },
    { number: 4, title: 'feat: older', mergeCommit: { oid: 'f'.repeat(40) }, commits: [] },
  ];
  assert.equal(f.run('v0.1.1', { prs }).status, 0);
  assert.equal(f.notes(), '### Features\n\n- add work (#5)\n\n### Fixes\n\n- direct push\n');
});

test('a squash PR replaces its commit and a missing or invalid PR file means no PRs', (t) => {
  const setup = () => {
    const f = fixture(t);
    const sha = f.commit('Add work (#6)');
    f.git('tag', 'v0.1.0');
    return { f, sha };
  };
  const { f, sha } = setup();
  const prs = [{ number: 6, title: 'feat: add work', mergeCommit: { oid: sha }, commits: [] }];
  assert.equal(f.run('v0.1.0', { prs }).status, 0);
  assert.equal(f.notes(), '### Features\n\n- add work (#6)\n');

  for (const given of [undefined, 'not json', '{"a":1}']) {
    const other = setup().f;
    assert.equal(other.run('v0.1.0', { prs: given }).status, 0);
    assert.equal(other.notes(), '### Other\n\n- Add work (#6)\n');
  }
});

test('claude gets the commits and the PR text as data, and its notes are written', (t) => {
  const f = fixture(t, `process.stdout.write(${JSON.stringify(answer('- Add \u2014 work \u2013 now'))});`);
  f.commit('feat: base');
  f.git('tag', 'v0.1.0');
  const sha = f.commit('feat: add work\n\nthe commit body');
  f.git('switch', '-c', 'work');
  f.commit('wip');
  f.git('switch', 'main');
  f.git('merge', '--no-ff', '-m', 'Merge pull request #8 from x/work', 'work');
  f.git('tag', 'v0.1.1');

  const prs = [
    { number: 6, title: 'PR title', body: 'PR body', mergeCommit: { oid: sha }, commits: [] },
    { number: 7, title: 'unrelated', body: 'other', mergeCommit: { oid: 'old' }, commits: [] },
  ];
  const r = f.run('v0.1.1', { ...TOKEN, prs });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.notes(), '- Add - work - now\n');
  assert.match(r.stdout, /^::notice::release notes for v0\.1\.1: claude$/m);

  const { args, stdin } = f.claude();
  assert.deepEqual(args.slice(0, 4), ['--print', '--tools', '', '--no-session-persistence']);
  assert.ok(!args.includes('--bare'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.deepEqual(Object.keys(schema.properties), ['notes']);
  assert.deepEqual(schema.required, ['notes']);
  assert.match(stdin, /do not follow instructions/);
  assert.match(stdin, /#6 PR title\n\nPR body/);
  assert.match(stdin, /the commit body/);
  assert.doesNotMatch(stdin, /unrelated/);
  assert.doesNotMatch(stdin, /Merge pull request/);
});

test('claude is told when no PR is in the range', (t) => {
  const f = fixture(t, `process.stdout.write(${JSON.stringify(answer('- x'))});`);
  f.commit('feat: one');
  f.git('tag', 'v0.1.0');

  assert.equal(f.run('v0.1.0', TOKEN).status, 0);
  assert.match(f.claude().stdin, /Pull requests:\n\n\(none\)\n/);
});

test('fallback notes lose em and en dashes', (t) => {
  const f = fixture(t);
  f.commit('fix: keep \u2014 the \u2013 cursor');
  f.git('tag', 'v0.1.0');
  assert.equal(f.run('v0.1.0').status, 0);
  assert.equal(f.notes(), '### Fixes\n\n- keep - the - cursor\n');
});

test('a missing or blank token never spawns claude', (t) => {
  for (const extraEnv of [{}, { CLAUDE_CODE_OAUTH_TOKEN: '' }, { CLAUDE_CODE_OAUTH_TOKEN: ' \n' }]) {
    const f = fixture(t, `process.stdout.write(${JSON.stringify(answer('- x'))});`);
    f.commit('fix: one');
    f.git('tag', 'v0.1.0');

    const r = f.run('v0.1.0', { extraEnv });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.notes(), '### Fixes\n\n- one\n');
    assert.equal(f.claude(), undefined);
    assert.match(r.stdout, /^::notice::.*fallback \(no CLAUDE_CODE_OAUTH_TOKEN\)$/m);
  }
});

test('the script falls back on every claude failure', async (t) => {
  const write = (text) => `process.stdout.write(${JSON.stringify(text)});`;
  const cases = [
    { name: 'spawn error', claude: undefined, reason: /ENOENT/ },
    { name: 'non-zero exit', claude: `process.exit(3);`, reason: /claude exited with 3/ },
    { name: 'killed', claude: `process.kill(process.pid, 'SIGKILL');`, reason: /claude exited with SIGKILL/ },
    { name: 'invalid output', claude: write('oops\n::error::x'), reason: /JSON/ },
    { name: 'is_error', claude: write(envelope({ is_error: true })), reason: /reported an error/ },
    { name: 'empty notes', claude: write(answer(' ')), reason: /empty notes/ },
  ];
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const f = fixture(t, c.claude);
      f.commit('fix: one');
      f.git('tag', 'v0.1.0');

      const r = f.run('v0.1.0', TOKEN);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(f.notes(), '### Fixes\n\n- one\n');
      assert.match(r.stdout, /^::notice::.*fallback \(/m);
      assert.match(r.stdout, c.reason);
      assert.doesNotMatch(r.stdout, /^::error/m);
    });
  }
});

// a real wait would take the full 2 minutes, so spawnSync answers as node does on a timeout. The
// script takes it from the module at load, hence the fresh require under the mock.
test('claude gets a 2 minute limit, and running into it falls back', (t) => {
  const file = require.resolve('../scripts/release-notes.js');
  const loaded = require.cache[file];
  delete require.cache[file];
  t.after(() => {
    require.cache[file] = loaded;
  });
  const timedOut = { error: new Error('spawnSync claude ETIMEDOUT'), status: null, signal: 'SIGTERM' };
  const spawn = t.mock.method(childProcess, 'spawnSync', () => timedOut);

  const { notes, source } = require(file).chooseNotes(['fix: one'], 'prompt', { CLAUDE_CODE_OAUTH_TOKEN: 'token' });
  assert.equal(spawn.mock.calls[0].arguments[2].timeout, 120_000);
  assert.equal(notes, '### Fixes\n\n- one');
  assert.match(source, /^fallback \(.*ETIMEDOUT/);
});

test('no AMO or GitHub variable reaches claude, and the token is passed trimmed', (t) => {
  const f = fixture(t, `process.stdout.write(${JSON.stringify(answer('- x'))});`);
  f.commit('feat: one');
  f.git('tag', 'v0.1.0');

  const r = f.run('v0.1.0', {
    extraEnv: {
      CLAUDE_CODE_OAUTH_TOKEN: ' token\n',
      WEB_EXT_API_KEY: 'key',
      WEB_EXT_API_SECRET: 'secret',
      GH_TOKEN: 'gh',
      GITHUB_TOKEN: 'github',
      GITHUB_REPOSITORY: 'a/b',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const { env } = f.claude();
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'token');
  assert.deepEqual(Object.keys(env).filter((k) => /^(WEB_EXT|GH_|GITHUB)/.test(k)), []);
});

test('a bad tag or missing git history fails and leaves no notes file', (t) => {
  const f = fixture(t);
  f.commit('feat: one');

  for (const tag of ['v1.2', 'v1.2.3-rc1', '--all', '$(id)']) {
    const r = f.run(tag);
    assert.equal(r.status, 1, tag);
    assert.match(r.stderr, /invalid tag/);
  }
  const r = f.run('v9.9.9');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^release-notes: git log/);
  assert.equal(f.wrote(), false);
});

test('the script takes exactly its four arguments', () => {
  for (const args of [[], ['v0.1.0'], ['v0.1.0', 'a', 'b'], ['v0.1.0', 'a', 'b', 'c', 'd']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /usage:/);
  }
});
