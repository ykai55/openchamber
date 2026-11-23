#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPOSITORY = 'ykai55/openchamber';
const VERSION = /^\d+\.\d+\.\d+-fork\.\d{8}\.\d+\.\d+$/;
const sha256 = data => createHash('sha256').update(data).digest('hex');

export function verifyManifest(value, repository) {
  if (value.schema !== 2 || value.repository !== repository || !VERSION.test(value.version) || value.tag !== `fork-web-${value.version}`) throw new Error('Invalid fork release manifest');
  const asset = value.assets?.['openchamber-web.tgz'];
  if (!/^[a-f0-9]{64}$/.test(asset?.sha256 ?? '') || !Number.isSafeInteger(asset?.size) || asset.size < 1 || asset.size > 1024 ** 3) throw new Error('Invalid Web archive entry');
  return value;
}

export function verifyAsset(data, asset) {
  if (data.length !== asset.size || sha256(data) !== asset.sha256) throw new Error('Release asset checksum mismatch');
}

export function isNewerRelease(candidate, current) {
  if (!VERSION.test(candidate) || !VERSION.test(current)) throw new Error('Invalid fork version');
  const next = candidate.match(/\d+/g).map(Number);
  const previous = current.match(/\d+/g).map(Number);
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== previous[index]) return next[index] > previous[index];
  }
  return false;
}

async function download(url) {
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function latestRelease(repository) {
  const base = `https://github.com/${repository}/releases/download`;
  const pointer = JSON.parse(await download(`${base}/fork-web/latest.json`));
  if (pointer.schema !== 2 || pointer.repository !== repository || !VERSION.test(pointer.version) || pointer.tag !== `fork-web-${pointer.version}` || !/^[a-f0-9]{64}$/.test(pointer.manifestSha256 ?? '')) throw new Error('Invalid latest release pointer');
  const bytes = await download(`${base}/${pointer.tag}/manifest.json`);
  if (sha256(bytes) !== pointer.manifestSha256) throw new Error('Manifest checksum mismatch');
  const manifest = verifyManifest(JSON.parse(bytes), repository);
  if (manifest.version !== pointer.version) throw new Error('Release pointer does not match its manifest');
  return manifest;
}

function npmPackageRoot() {
  const root = execFileSync('npm', ['root', '--global'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return join(root, '@openchamber', 'web');
}

// Adapter for upstream's update command. It retains upstream instance discovery,
// startup-service restart and health checks, replacing only package selection
// and installation. The archive is downloaded before any instance is stopped.
export function createForkPackageManager(packageRoot) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const repository = pkg.openchamberFork?.repository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !VERSION.test(pkg.version)) throw new Error('Install a fork release with npm first');
  let prepared = null;
  return {
    getCurrentVersion: () => pkg.version,
    detectPackageManager: () => 'npm',
    checkForUpdates: async () => {
      const manifest = await latestRelease(repository);
      const available = isNewerRelease(manifest.version, pkg.version);
      if (available) {
        if (realpathSync(npmPackageRoot()) !== realpathSync(packageRoot)) throw new Error('This CLI is not owned by the active npm global prefix; select the npm/Node installation that owns it');
        const bytes = await download(`https://github.com/${repository}/releases/download/${manifest.tag}/openchamber-web.tgz`);
        verifyAsset(bytes, manifest.assets['openchamber-web.tgz']);
        const directory = mkdtempSync(join(tmpdir(), 'openchamber-fork-update-'));
        const archive = join(directory, 'openchamber-web.tgz');
        writeFileSync(archive, bytes);
        prepared = { directory, archive, version: manifest.version };
      }
      return { available, currentVersion: pkg.version, version: manifest.version, releaseUrl: `https://github.com/${repository}/releases/tag/${manifest.tag}` };
    },
    executeUpdate: (_pm, { targetVersion, silent } = {}) => {
      if (!prepared || prepared.version !== targetVersion) return { success: false, error: 'No verified archive prepared for the requested version' };
      try {
        execFileSync('npm', ['install', '--global', '--allow-scripts=node-pty', '--no-audit', '--no-fund', prepared.archive], { stdio: silent ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
        const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
        if (installed.version !== targetVersion || installed.openchamberFork?.repository !== repository) throw new Error('npm did not install the requested fork version');
        return { success: true, exitCode: 0 };
      } catch (error) {
        return { success: false, exitCode: error.status ?? 1, error: error.message };
      } finally {
        rmSync(prepared.directory, { recursive: true, force: true });
        prepared = null;
      }
    },
    dispose: () => {
      if (prepared) rmSync(prepared.directory, { recursive: true, force: true });
      prepared = null;
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean', default: false }, quiet: { type: 'boolean', default: false } } });
  const command = positionals[0] ?? 'check';
  if (!['check', 'update'].includes(command)) throw new Error('Commands: check, update. Install or roll back with npm install -g <release.tgz>.');
  const packageRoot = npmPackageRoot();
  const pkg = existsSync(join(packageRoot, 'package.json')) ? JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) : null;
  if (command === 'update') {
    if (!pkg?.openchamberFork) throw new Error('Install a fork release with npm first');
    const flags = values.json ? ['--json'] : values.quiet ? ['--quiet'] : [];
    const result = spawnSync(process.execPath, [resolve(packageRoot, pkg.bin.openchamber), 'update', ...flags], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  const latest = await latestRelease(pkg?.openchamberFork?.repository ?? DEFAULT_REPOSITORY);
  const current = pkg?.openchamberFork ? pkg.version : null;
  const result = { current, latest: latest.version, updateAvailable: !current || isNewerRelease(latest.version, current) };
  console.log(values.json ? JSON.stringify(result) : `${current ?? 'not installed'} -> ${latest.version}: ${result.updateAvailable ? 'update available' : 'up to date'}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(process.argv.includes('--json') ? JSON.stringify({ error: error.message }) : error.message); process.exitCode = 1; });
}
