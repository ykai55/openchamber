#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, symlinkSync, realpathSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPOSITORY = 'ykai55/openchamber';
const VERSION = /^\d+\.\d+\.\d+-fork\.\d{8}\.\d+\.\d+$/;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const serviceName = root => `cc.ykai.openchamber-fork.${sha256(Buffer.from(root)).slice(0, 12)}`;

export function verifyManifest(value, repository) {
  if (value.schema !== 1 || value.repository !== repository || !VERSION.test(value.version) || value.tag !== `fork-web-${value.version}`) throw new Error('Invalid fork release manifest');
  for (const name of ['openchamber-web.tgz', 'openchamber-sdk.tgz', 'update.mjs']) {
    const asset = value.assets?.[name];
    if (!/^[a-f0-9]{64}$/.test(asset?.sha256 ?? '') || !Number.isSafeInteger(asset?.size) || asset.size < 1 || asset.size > 1024 ** 3) throw new Error(`Invalid manifest entry: ${name}`);
  }
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
  if (pointer.schema !== 1 || pointer.repository !== repository || !VERSION.test(pointer.version) || pointer.tag !== `fork-web-${pointer.version}` || !/^[a-f0-9]{64}$/.test(pointer.manifestSha256 ?? '')) throw new Error('Invalid latest release pointer');
  const bytes = await download(`${base}/${pointer.tag}/manifest.json`);
  if (sha256(bytes) !== pointer.manifestSha256) throw new Error('Manifest checksum mismatch');
  const manifest = verifyManifest(JSON.parse(bytes), repository);
  if (manifest.version !== pointer.version) throw new Error('Release pointer does not match its manifest');
  return manifest;
}

function installed(root, link = 'current') {
  if (!existsSync(join(root, link))) return null;
  const directory = realpathSync(join(root, link));
  if (!directory.startsWith(realpathSync(join(root, 'versions')) + '/')) throw new Error('Installation link points outside the release directory');
  const manifest = readJson(join(directory, 'manifest.json'));
  if (!VERSION.test(manifest.version)) throw new Error('Invalid installed version');
  return { directory, version: manifest.version, repository: manifest.repository };
}

function pointTo(root, name, version) {
  if (!VERSION.test(version)) throw new Error('Invalid release version');
  const temporary = join(root, `${name}.next-${process.pid}`);
  symlinkSync(`versions/${version}`, temporary);
  renameSync(temporary, join(root, name));
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024, ...options });
  } catch (error) {
    throw new Error(`${command} failed with exit status ${error.status ?? 'unknown'}: ${String(error.stderr ?? '').slice(-1500)}`);
  }
}

function extract(archive, directory) {
  const names = run('tar', ['-tzf', archive]).split('\n').filter(Boolean);
  if (!names.length || names.some(name => !name.startsWith('package/') || name.split('/').includes('..'))) throw new Error('Unexpected paths in release archive');
  mkdirSync(directory);
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', directory]);
}

const serviceLoaded = root => process.platform === 'darwin' && spawnSync('launchctl', ['print', `gui/${process.getuid()}/${serviceName(root)}`], { stdio: 'ignore' }).status === 0;

async function waitForVersion(port, version) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json();
        if (health.openchamberVersion === version && health.isOpenCodeReady !== false) return;
      }
    } catch { /* The service can be between stopping and listening. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  throw new Error(`Service did not become healthy on version ${version}`);
}

async function restart(root, version) {
  const { port } = readJson(join(root, 'service.json'));
  run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${serviceName(root)}`]);
  await waitForVersion(port, version);
}

async function activate(root, version) {
  const previous = installed(root);
  if (previous?.version === version) return false;
  const running = existsSync(join(root, 'service.json')) && serviceLoaded(root);
  pointTo(root, 'current', version);
  try {
    if (running) await restart(root, version);
  } catch (error) {
    if (previous) {
      pointTo(root, 'current', previous.version);
      await restart(root, previous.version);
    }
    throw error;
  }
  if (previous) pointTo(root, 'previous', previous.version);
  return running;
}

async function installRelease(root, manifest, artifactDirectory, quiet) {
  const current = installed(root);
  if (current && current.repository !== manifest.repository) throw new Error('This installation belongs to a different fork; use a separate root');
  if (current && current.version !== manifest.version && !isNewerRelease(manifest.version, current.version)) throw new Error('The selected release is older than the installed version; use rollback explicitly');
  const destination = join(root, 'versions', manifest.version);
  if (!existsSync(destination)) {
    const staging = mkdtempSync(join(root, '.install-'));
    try {
      for (const [name, expected] of Object.entries(manifest.assets)) {
        if (!['openchamber-web.tgz', 'openchamber-sdk.tgz', 'update.mjs'].includes(name)) continue;
        const bytes = artifactDirectory
          ? readFileSync(join(artifactDirectory, name))
          : await download(`https://github.com/${manifest.repository}/releases/download/${manifest.tag}/${name}`);
        verifyAsset(bytes, expected);
        writeFileSync(join(staging, name), bytes);
      }
      extract(join(staging, 'openchamber-web.tgz'), join(staging, 'app'));
      const pkg = readJson(join(staging, 'app', 'package.json'));
      if (pkg.name !== '@openchamber/web' || pkg.version !== manifest.version) throw new Error('Web package version does not match the manifest');
      const runtime = join(staging, 'runtime');
      mkdirSync(runtime);
      writeFileSync(join(runtime, 'package.json'), JSON.stringify({ private: true, dependencies: { ...pkg.dependencies, '@openchamber/sdk': `file:${join(staging, 'openchamber-sdk.tgz')}` }, optionalDependencies: pkg.optionalDependencies }));
      if (!quiet) console.error('Installing runtime dependencies for this machine...');
      run('npm', ['install', '--prefix', runtime, '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org']);
      symlinkSync('../runtime/node_modules', join(staging, 'app', 'node_modules'));
      const sdk = readJson(join(runtime, 'node_modules', '@openchamber', 'sdk', 'package.json'));
      if (sdk.version !== manifest.version) throw new Error('SDK package version does not match the manifest');
      const version = run(process.execPath, [join(staging, 'app', 'bin', 'cli.js'), '--version']).trim();
      if (!version.includes(manifest.version) || !existsSync(join(staging, 'app', 'dist', 'index.html'))) throw new Error('Installed package smoke check failed');
      writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      renameSync(staging, destination);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const restarted = await activate(root, manifest.version);
  copyFileSync(join(destination, 'update.mjs'), join(root, 'update.mjs.next'));
  renameSync(join(root, 'update.mjs.next'), join(root, 'update.mjs'));
  return { action: 'installed', version: manifest.version, root, restarted };
}

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

async function installService(root, port) {
  if (process.platform !== 'darwin') throw new Error('Service installation currently supports macOS only; use the run command on other systems');
  const current = installed(root);
  if (!current) throw new Error('Install a release first');
  if (serviceLoaded(root)) throw new Error('The fork service is already installed; use update to replace its version');
  const probe = createServer();
  await new Promise((resolveProbe, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolveProbe); });
  await new Promise(resolveClose => probe.close(resolveClose));
  const service = serviceName(root);
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${service}.plist`);
  mkdirSync(resolve(plist, '..'), { recursive: true });
  const environment = Object.fromEntries(['PATH', 'HOME', 'LANG', 'OPENCODE_BINARY', 'OPENCHAMBER_DATA_DIR', 'OPENCHAMBER_UI_PASSWORD'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  writeFileSync(join(root, 'service.json'), JSON.stringify({ port }) + '\n', { mode: 0o600 });
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${service}</string><key>ProgramArguments</key><array>${[process.execPath, join(root, 'update.mjs'), '--root', root, 'run'].map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>WorkingDirectory</key><string>${xml(homedir())}</string><key>StandardOutPath</key><string>${xml(join(root, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root, 'service.err.log'))}</string></dict></plist>\n`, { mode: 0o600 });
  try {
    run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
    await waitForVersion(port, current.version);
  } catch (error) {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${service}`], { stdio: 'ignore' });
    rmSync(plist, { force: true });
    throw error;
  }
  return { action: 'service-installed', service, port, version: current.version };
}

export async function main(args = process.argv.slice(2)) {
  const cliIndex = args.indexOf('cli');
  const forwarded = cliIndex < 0 ? [] : args.slice(cliIndex + 1);
  const { values, positionals } = parseArgs({ args: cliIndex < 0 ? args : args.slice(0, cliIndex + 1), allowPositionals: true, options: { root: { type: 'string', default: join(homedir(), '.local', 'share', 'openchamber-fork') }, repo: { type: 'string', default: DEFAULT_REPOSITORY }, port: { type: 'string' }, artifacts: { type: 'string' }, json: { type: 'boolean', default: false } } });
  let command = positionals[0] ?? 'check';
  if (command === 'cli' && forwarded[0] === 'update') command = 'update';
  const root = existsSync(values.root) ? realpathSync(values.root) : resolve(values.root);
  const repository = values.repo;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const port = Number(values.port ?? '4096');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 14)) throw new Error('Node.js 24.14 or newer is required');
  if (command === 'run' || command === 'cli') {
    const current = installed(root);
    if (!current) throw new Error('Install a fork release first');
    const servicePort = values.port === undefined && existsSync(join(root, 'service.json')) ? readJson(join(root, 'service.json')).port : port;
    const cliArgs = command === 'cli' ? forwarded : ['serve', '--foreground', '--host', '127.0.0.1', '--port', String(servicePort)];
    const child = spawn(process.execPath, [join(current.directory, 'app', 'bin', 'cli.js'), ...cliArgs], {
      stdio: 'inherit',
      env: { ...process.env, OPENCHAMBER_RUNTIME: 'web', OPENCHAMBER_DIST_DIR: join(current.directory, 'app', 'dist') },
    });
    const stop = signal => child.kill(signal);
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 0; resolveExit(); }); });
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    return;
  }
  let result;
  if (command === 'check') {
    const latest = await latestRelease(repository);
    const current = installed(root);
    result = { action: 'check', current: current?.version ?? null, latest: latest.version, updateAvailable: !current || isNewerRelease(latest.version, current.version) };
  } else {
    if (!['install', 'update', 'rollback', 'service'].includes(command)) throw new Error('Commands: check, install, update, rollback, service, run, cli');
    mkdirSync(join(root, 'versions'), { recursive: true, mode: 0o700 });
    const lock = join(root, '.update-lock');
    try { mkdirSync(lock); } catch { throw new Error(`Another update holds ${lock}; if it was interrupted, remove that lock before retrying`); }
    try {
      if (command === 'service') result = await installService(root, port);
      else if (command === 'rollback') {
        const previous = installed(root, 'previous');
        if (!previous) throw new Error('No previous release is installed');
        result = { action: 'rolled-back', version: previous.version, restarted: await activate(root, previous.version) };
      } else {
        const manifest = values.artifacts ? verifyManifest(readJson(join(resolve(values.artifacts), 'manifest.json')), repository) : await latestRelease(repository);
        result = await installRelease(root, manifest, values.artifacts ? resolve(values.artifacts) : null, values.json);
      }
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  console.log(values.json ? JSON.stringify(result) : Object.entries(result).map(([key, value]) => `${key}: ${value}`).join('\n'));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(process.argv.includes('--json') ? JSON.stringify({ error: error.message }) : error.message); process.exitCode = 1; });
}
