import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stableReleaseTag, applyPullRequestPatch } from './prepare.mjs';

test('only a numbered, published stable release is accepted', () => {
  assert.equal(stableReleaseTag({ tag_name: 'v2.7.2', draft: false, prerelease: false }), 'v2.7.2');
  for (const release of [
    { tag_name: 'v2.7.3', draft: true, prerelease: false },
    { tag_name: 'v2.7.3', draft: false, prerelease: true },
    { tag_name: 'canary', draft: false, prerelease: false },
    { tag_name: 'v2.7.2' },
  ]) assert.throws(() => stableReleaseTag(release));
});

test('rebuilds a release when the rolling pointer upload was interrupted', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fork-web-prepare-test-'));
  try {
    const bin = join(temp, 'bin');
    const source = join(temp, 'source');
    const artifacts = join(temp, 'artifacts');
    const output = join(temp, 'output');
    mkdirSync(bin);
    mkdirSync(join(source, 'packages', 'web'), { recursive: true });
    writeFileSync(join(source, 'packages', 'web', 'package.json'), JSON.stringify({ version: '2.7.2' }));
    writeFileSync(output, '');
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nconst path=process.argv[3]; if(path.includes('/pulls/')) console.log(JSON.stringify({merged:true,merge_commit_sha:'${'a'.repeat(40)}'})); else if(path.endsWith('/releases/tags/fork-web')) console.log(JSON.stringify({assets:[]})); else process.exit(1);\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node\nif(process.argv[2]==='rev-parse')console.log('${'a'.repeat(40)}');\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare.mjs', import.meta.url))], {
      encoding: 'utf8',
      env: { ...process.env, FORK_WEB_PATCH_DIR: bin, PATH: bin + delimiter + process.env.PATH, SOURCE_DIR: source, ARTIFACT_DIR: artifacts, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'ykai55/openchamber', GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_NUMBER: '5', GITHUB_RUN_ATTEMPT: '1', UPSTREAM_TAG: 'v2.7.2' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(output, 'utf8'), /build=true/);
    const plan = JSON.parse(readFileSync(join(artifacts, 'plan.json'), 'utf8'));
    assert.equal(plan.sourceSha, 'a'.repeat(40));
    assert.equal(plan.patches[0].state, 'upstream');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('backports a merged PR without later main changes, then retires it when stable includes it', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fork-stable-patch-test-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const upstream = join(temp, 'upstream');
    const source = join(temp, 'source');
    const bin = join(temp, 'bin');
    const artifacts = join(temp, 'artifacts');
    const output = join(temp, 'output');
    mkdirSync(upstream); mkdirSync(bin);
    git(upstream, 'init', '-q');
    git(upstream, 'config', 'user.name', 'Fixture');
    git(upstream, 'config', 'user.email', 'fixture@example.test');
    mkdirSync(join(upstream, 'packages', 'web'), { recursive: true });
    const packageJson = join(upstream, 'packages', 'web', 'package.json');
    writeFileSync(packageJson, JSON.stringify({ version: '2.7.2' }));
    git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'Stable release');
    git(upstream, 'tag', 'v2.7.2');
    const stable = git(upstream, 'rev-parse', 'HEAD');
    writeFileSync(join(upstream, 'unreleased-main.txt'), 'unrelated change\n');
    git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'Later main change');
    const base = git(upstream, 'rev-parse', 'HEAD');
    writeFileSync(join(upstream, 'selected-fix.txt'), 'selected PR fix\n');
    git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'Merged PR');
    const merge = git(upstream, 'rev-parse', 'HEAD');
    git(temp, 'clone', '-q', upstream, source);
    git(source, 'checkout', '-q', '--detach', 'v2.7.2');
    // The final read of the fork branch also stays local to this fixture.
    git(source, 'config', `url.${upstream}.insteadOf`, 'https://github.com/ykai55/openchamber.git');
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nconst path=process.argv[3]; console.log(JSON.stringify(path.includes('/pulls/')?{merged:true,merge_commit_sha:'${merge}',base:{sha:'${base}'}}:{assets:[]}));\n`, { mode: 0o755 });
    const prepare = tag => {
      writeFileSync(output, '');
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare.mjs', import.meta.url))], {
        encoding: 'utf8',
        env: { ...process.env, FORK_WEB_PATCH_DIR: bin, PATH: bin + delimiter + process.env.PATH, SOURCE_DIR: source, ARTIFACT_DIR: artifacts, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'ykai55/openchamber', GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_NUMBER: '5', GITHUB_RUN_ATTEMPT: '1', UPSTREAM_TAG: tag },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(readFileSync(join(artifacts, 'plan.json'), 'utf8'));
    };
    const plan = prepare('v2.7.2');
    assert.equal(plan.upstreamSha, stable);
    assert.equal(plan.patches[0].state, 'apply');
    assert.match(plan.version, /^2\.7\.3-fork\./);
    assert.equal(existsSync(join(source, 'unreleased-main.txt')), false);
    assert.equal(readFileSync(join(source, 'selected-fix.txt'), 'utf8'), 'selected PR fix\n');
    assert.equal(git(source, 'rev-parse', 'HEAD^'), stable);
    assert.equal(applyPullRequestPatch(source, { pr: 6902, base, sha: merge }), false);

    writeFileSync(packageJson, JSON.stringify({ version: '2.7.3' }));
    git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'Next stable release');
    git(upstream, 'tag', 'v2.7.3');
    git(source, 'fetch', '-q', '--tags', 'origin');
    git(source, 'checkout', '-q', '--detach', 'v2.7.3');
    const released = prepare('v2.7.3');
    assert.equal(released.patches[0].state, 'upstream');
    assert.equal(released.sourceSha, released.upstreamSha);
    assert.match(released.version, /^2\.7\.4-fork\./);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
