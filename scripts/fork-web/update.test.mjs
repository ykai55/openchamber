import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyManifest, verifyAsset, isNewerRelease, createForkPackageManager } from './update.mjs';
import { buildVersion } from './prepare.mjs';
import { finalizeWebPackage } from './package.mjs';

const updater = fileURLToPath(new URL('./update.mjs', import.meta.url));
const repository = 'ykai55/openchamber';
const hash = data => createHash('sha256').update(data).digest('hex');

test('fork versions are distinct and numerically ordered across runs and attempts', () => {
  const date = new Date('2026-11-16T03:00:00Z');
  assert.equal(buildVersion('2.7.3', '22', '1', date), '2.7.3-fork.20261116.22.1');
  assert.equal(buildVersion('2.7.3-canary.1', '22', '2', date), '2.7.3-fork.20261116.22.2');
  assert.throws(() => buildVersion('bad', '22', '1', date));
  assert.equal(isNewerRelease('2.7.3-fork.20261116.10.1', '2.7.3-fork.20261116.9.1'), true);
  assert.equal(isNewerRelease('2.7.3-fork.20261116.9.1', '2.7.3-fork.20261116.10.1'), false);
});

test('manifest and checksum validation reject another fork or modified content', () => {
  const data = Buffer.from('archive');
  const asset = { size: data.length, sha256: hash(data) };
  const version = '2.7.3-fork.20261116.22.1';
  const manifest = { schema: 2, repository, version, tag: `fork-web-${version}`, assets: { 'openchamber-web.tgz': asset } };
  assert.equal(verifyManifest(manifest, repository), manifest);
  assert.throws(() => verifyManifest(manifest, 'other/fork'));
  assert.throws(() => verifyManifest({ ...manifest, version: '../outside' }, repository));
  verifyAsset(data, asset);
  assert.throws(() => verifyAsset(Buffer.from('changed'), asset));
});

test('one npm tarball supplies the private SDK version and supports verified updates and explicit rollback', { timeout: 90_000 }, async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'fork-web-npm-test-')));
  const prefix = join(temp, 'global');
  const originalPrefix = process.env.npm_config_prefix;
  const originalFetch = globalThis.fetch;
  process.env.npm_config_prefix = prefix;
  const createArchive = run => {
    const version = `2.7.3-fork.20261116.${run}.1`;
    const artifacts = join(temp, `artifacts-${run}`);
    const web = join(temp, `web-${run}`);
    const sdk = join(temp, `sdk-${run}`);
    mkdirSync(artifacts);
    const shared = join(temp, `shared-${run}`);
    mkdirSync(join(shared, 'package'), { recursive: true });
    writeFileSync(join(shared, 'package', 'package.json'), JSON.stringify({ name: '@fork-fixture/shared', version: '1.0.0', type: 'module', main: 'index.js' }));
    writeFileSync(join(shared, 'package', 'index.js'), 'export const ready = true;\n');
    const sharedArchive = join(artifacts, 'shared.tgz');
    execFileSync('tar', ['-czf', sharedArchive, '-C', shared, 'package']);
    mkdirSync(join(sdk, 'package'), { recursive: true });
    writeFileSync(join(sdk, 'package', 'package.json'), JSON.stringify({ name: '@openchamber/sdk', version, type: 'module', main: 'index.js', dependencies: { '@fork-fixture/shared': `file:${sharedArchive}` } }));
    writeFileSync(join(sdk, 'package', 'index.js'), `import {ready} from '@fork-fixture/shared'; if(!ready)throw Error('missing shared dependency'); export const version=${JSON.stringify(version)};\n`);
    const sdkArchive = join(artifacts, 'sdk.tgz');
    execFileSync('tar', ['-czf', sdkArchive, '-C', sdk, 'package']);
    mkdirSync(join(web, 'bin', 'lib'), { recursive: true });
    writeFileSync(join(web, 'package.json'), JSON.stringify({ name: '@openchamber/web', version, type: 'module', files: ['bin'], dependencies: { '@openchamber/sdk': version, '@fork-fixture/shared': `file:${sharedArchive}` }, bin: { openchamber: './bin/cli.js' } }));
    writeFileSync(join(web, 'bin', 'cli.js'), "#!/usr/bin/env node\nimport {version} from '@openchamber/sdk'; console.log(version);\n");
    writeFileSync(join(web, 'bin', 'lib', 'commands-update.js'), 'export function createUpdateCommand({importFromFilePath,packageManagerPath}) {}\n');
    finalizeWebPackage(web, sdkArchive, { version, repository, tag: `fork-web-${version}`, sourceSha: 'a'.repeat(40) });
    // Local tarballs seed the fixture without a registry. The packed packages
    // use normal version dependencies, like Web and SDK both depending on zod.
    for (const manifestPath of [join(web, 'package.json'), join(web, 'node_modules', '@openchamber', 'sdk', 'package.json')]) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.dependencies['@fork-fixture/shared'] = '1.0.0';
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], { cwd: web, encoding: 'utf8' }));
    assert.ok(packed[0].files.some(file => file.path === 'node_modules/@fork-fixture/shared/index.js'));
    rmSync(sharedArchive);
    const archive = join(artifacts, packed[0].filename);
    const bytes = readFileSync(archive);
    const manifest = { schema: 2, repository, version, tag: `fork-web-${version}`, assets: { 'openchamber-web.tgz': { size: bytes.length, sha256: hash(bytes) } } };
    return { version, archive, bytes, manifest };
  };
  const serveRelease = (release, corrupt = false) => {
    const manifest = Buffer.from(JSON.stringify(release.manifest));
    globalThis.fetch = async url => {
      if (String(url).endsWith('latest.json')) return Response.json({ schema: 2, repository, version: release.version, tag: release.manifest.tag, manifestSha256: hash(manifest) });
      if (String(url).endsWith('manifest.json')) return new Response(manifest);
      if (String(url).endsWith('openchamber-web.tgz')) return new Response(corrupt ? Buffer.from('corrupt') : release.bytes);
      throw new Error('Unexpected URL');
    };
  };
  const install = archive => execFileSync('npm', ['install', '--global', '--no-audit', '--no-fund', archive], { stdio: 'pipe' });
  try {
    const first = createArchive(1);
    const second = createArchive(2);
    install(first.archive);
    const packageRoot = join(execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim(), '@openchamber', 'web');
    const version = () => execFileSync(process.execPath, [join(packageRoot, 'bin', 'cli.js'), '--version'], { encoding: 'utf8' }).trim();
    assert.equal(version(), first.version);
    const manager = createForkPackageManager(packageRoot);
    try {
      serveRelease(second, true);
      await assert.rejects(manager.checkForUpdates(), /checksum/);
      assert.equal(version(), first.version);
      serveRelease(second);
      const available = await manager.checkForUpdates();
      assert.equal(available.available, true);
      assert.equal(manager.executeUpdate('npm', { targetVersion: available.version, silent: true }).success, true);
      assert.equal(version(), second.version);
      serveRelease(first);
      const current = createForkPackageManager(packageRoot);
      assert.equal((await current.checkForUpdates()).available, false);
      current.dispose();
      install(first.archive);
      assert.equal(version(), first.version);
    } finally {
      manager.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPrefix === undefined) delete process.env.npm_config_prefix;
    else process.env.npm_config_prefix = originalPrefix;
    rmSync(temp, { recursive: true, force: true });
  }
});

test('non-interactive invalid commands fail with a JSON error', () => {
  const result = spawnSync(process.execPath, [updater, '--json', 'unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).error, /Commands:/);
});
