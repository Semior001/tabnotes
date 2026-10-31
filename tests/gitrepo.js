// A git repo for tests that run real git commands, with no global git config so commits cannot try
// SSH signing. Not a *.test.js file: node --test does not run it.
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function gitRepo(dir, PATH, extra = {}) {
  const env = {
    PATH,
    ...extra,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-b', 'main');
  const commit = (subject) => {
    git('commit', '--allow-empty', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  return { env, git, commit };
}

module.exports = { gitRepo };
