import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyManifest, verifyAsset, isNewerRelease } from './update.mjs';
import { buildVersion } from './prepare.mjs';

const updater = fileURLToPath(new URL('./update.mjs', import.meta.url));
const repository = 'ykai55/openchamber';

test('fork versions are distinct across runs and attempts', () => {
  const date = new Date('2026-11-16T03:00:00Z');
  assert.equal(buildVersion('2.7.3', '22', '1', date), '2.7.3-fork.20261116.22.1');
  assert.equal(buildVersion('2.7.3-canary.1', '22', '2', date), '2.7.3-fork.20261116.22.2');
  assert.throws(() => buildVersion('bad', '22', '1', date));
  assert.equal(isNewerRelease('2.7.3-fork.20261116.10.1', '2.7.3-fork.20261116.9.1'), true);
  assert.equal(isNewerRelease('2.7.3-fork.20261116.9.1', '2.7.3-fork.20261116.10.1'), false);
});

test('manifest and checksum validation reject another fork or modified content', () => {
  const data = Buffer.from('archive');
  const asset = { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  const version = '2.7.3-fork.20261116.22.1';
  const manifest = { schema: 1, repository, version, tag: `fork-web-${version}`, assets: Object.fromEntries(['openchamber-web.tgz', 'openchamber-sdk.tgz', 'update.mjs'].map(name => [name, asset])) };
  assert.equal(verifyManifest(manifest, repository), manifest);
  assert.throws(() => verifyManifest(manifest, 'other/fork'));
  assert.throws(() => verifyManifest({ ...manifest, version: '../outside' }, repository));
  verifyAsset(data, asset);
  assert.throws(() => verifyAsset(Buffer.from('changed'), asset));
});

test('install, failed update and rollback keep the correct active program', { timeout: 90_000 }, () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'fork-web-install-test-')));
  const root = join(temp, 'installation');
  const createArtifacts = (run) => {
    const version = `2.7.3-fork.20261116.${run}.1`;
    const artifacts = join(temp, `artifacts-${run}`);
    mkdirSync(artifacts);
    for (const name of ['sdk', 'web']) {
      const folder = join(temp, `${name}-${run}`);
      const pkg = join(folder, 'package');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: `@openchamber/${name}`, version, type: 'module', ...(name === 'sdk' ? { main: 'index.js' } : { dependencies: { '@openchamber/sdk': version } }) }));
      if (name === 'sdk') writeFileSync(join(pkg, 'index.js'), `export const version=${JSON.stringify(version)};\n`);
      else {
        mkdirSync(join(pkg, 'bin')); mkdirSync(join(pkg, 'dist'));
        writeFileSync(join(pkg, 'bin', 'cli.js'), "import {version} from '@openchamber/sdk'; console.log(version);\n");
        writeFileSync(join(pkg, 'dist', 'index.html'), '<p>fixture</p>');
      }
      execFileSync('tar', ['-czf', join(artifacts, `openchamber-${name}.tgz`), '-C', folder, 'package']);
    }
    copyFileSync(updater, join(artifacts, 'update.mjs'));
    const assets = {};
    for (const name of ['openchamber-web.tgz', 'openchamber-sdk.tgz', 'update.mjs']) {
      const data = readFileSync(join(artifacts, name));
      assets[name] = { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    }
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify({ schema: 1, repository, version, tag: `fork-web-${version}`, assets }));
    return { artifacts, version };
  };
  const invoke = (...args) => spawnSync(process.execPath, [updater, '--root', root, '--json', ...args], { encoding: 'utf8', timeout: 30_000 });
  try {
    const first = createArtifacts(1);
    const installed = invoke('install', '--artifacts', first.artifacts);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).version, first.version);
    assert.equal(realpathSync(join(root, 'current')), join(root, 'versions', first.version));

    const second = createArtifacts(2);
    const archive = join(second.artifacts, 'openchamber-web.tgz');
    const original = readFileSync(archive);
    writeFileSync(archive, 'corrupt');
    const failed = invoke('update', '--artifacts', second.artifacts);
    assert.equal(failed.status, 1);
    assert.match(JSON.parse(failed.stderr).error, /checksum/);
    assert.equal(realpathSync(join(root, 'current')), join(root, 'versions', first.version));
    writeFileSync(archive, original);
    const updated = invoke('update', '--artifacts', second.artifacts);
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(JSON.parse(updated.stdout).version, second.version);
    const stale = invoke('update', '--artifacts', first.artifacts);
    assert.equal(stale.status, 1);
    assert.equal(realpathSync(join(root, 'current')), join(root, 'versions', second.version));
    const rolledBack = invoke('rollback');
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(JSON.parse(rolledBack.stdout).version, first.version);
    assert.equal(realpathSync(join(root, 'current')), join(root, 'versions', first.version));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('non-interactive invalid commands fail with a JSON error', () => {
  const result = spawnSync(process.execPath, [updater, '--json', 'unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).error, /Commands:/);
});
