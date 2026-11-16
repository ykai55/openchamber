import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, renameSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function finalizeWebPackage(directory, sdkArchive, plan) {
  const sdk = join(directory, 'node_modules', '@openchamber', 'sdk');
  mkdirSync(sdk, { recursive: true });
  execFileSync('tar', ['-xzf', sdkArchive, '--strip-components=1', '-C', sdk]);
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const sdkPackage = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'));
  if (pkg.version !== plan.version || sdkPackage.version !== plan.version) throw new Error('Web and bundled SDK versions must match the release');
  pkg.bundledDependencies = [...new Set([...(pkg.bundledDependencies ?? pkg.bundleDependencies ?? []), '@openchamber/sdk'])];
  delete pkg.bundleDependencies;
  pkg.bin = { ...pkg.bin, 'openchamber-fork-update': './bin/fork-update.mjs' };
  pkg.openchamberFork = { repository: plan.repository, tag: plan.tag, sourceSha: plan.sourceSha };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  copyFileSync(join(here, 'update.mjs'), join(directory, 'bin', 'fork-update.mjs'));

  const commands = join(directory, 'bin', 'lib', 'commands-update.js');
  const original = readFileSync(commands, 'utf8');
  if (!original.includes('createUpdateCommand') || !original.includes('importFromFilePath') || !original.includes('packageManagerPath')) throw new Error('Upstream CLI update wiring changed; review the fork adapter');
  renameSync(commands, join(directory, 'bin', 'lib', 'commands-update-upstream.js'));
  writeFileSync(commands, `import { fileURLToPath } from 'node:url';
import { createUpdateCommand as upstreamUpdateCommand } from './commands-update-upstream.js';
import { createForkPackageManager } from '../fork-update.mjs';

export function createUpdateCommand(dependencies) {
  return async (options) => {
    const manager = createForkPackageManager(fileURLToPath(new URL('../../', import.meta.url)));
    try {
      return await upstreamUpdateCommand({ ...dependencies, importFromFilePath: async () => manager })(options);
    } finally {
      manager.dispose();
    }
  };
}
`);
}

function packageRelease() {
  const source = resolve(process.env.SOURCE_DIR);
  const artifacts = resolve(process.env.ARTIFACT_DIR);
  const plan = JSON.parse(readFileSync(resolve(artifacts, 'plan.json'), 'utf8'));
  for (const folder of ['', 'packages/ui', 'packages/sdk', 'packages/web']) {
    const path = resolve(source, folder, 'package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    pkg.version = plan.version;
    if (folder === 'packages/web') pkg.dependencies['@openchamber/sdk'] = plan.version;
    writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  }
  // The browser's official update route remains manual; the packaged CLI below
  // uses the fork release adapter and upstream restart management.
  const managerPath = resolve(source, 'packages/web/server/lib/package-manager.js');
  const manager = readFileSync(managerPath, 'utf8');
  const unmanaged = /export function isUnmanagedInstall\(\) \{\n[^}]+\n\}/g;
  if ([...manager.matchAll(unmanaged)].length !== 1) throw new Error('The upstream update-management hook changed; review the fork packaging overlay');
  writeFileSync(managerPath, manager.replace(unmanaged, 'export function isUnmanagedInstall() {\n  return true;\n}'));
  if (process.argv[2] === 'stamp') return;

  const staging = mkdtempSync(join(artifacts, '.package-'));
  try {
    for (const name of ['sdk', 'web']) {
      const before = new Set(readdirSync(staging));
      execFileSync('bun', ['pm', 'pack', '--cwd', `packages/${name}`, '--destination', staging], { cwd: source, stdio: 'inherit' });
      const files = readdirSync(staging).filter(file => file.endsWith('.tgz') && !before.has(file));
      if (files.length !== 1) throw new Error(`Expected one ${name} archive`);
      renameSync(join(staging, files[0]), join(staging, `${name}.tgz`));
    }
    execFileSync('tar', ['-xzf', join(staging, 'web.tgz'), '-C', staging]);
    finalizeWebPackage(join(staging, 'package'), join(staging, 'sdk.tgz'), plan);
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], { cwd: join(staging, 'package'), encoding: 'utf8' }));
    renameSync(join(artifacts, packed[0].filename), join(artifacts, 'openchamber-web.tgz'));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  copyFileSync(join(here, 'update.mjs'), join(artifacts, 'update.mjs'));
  const assets = {};
  for (const name of ['openchamber-web.tgz', 'update.mjs']) {
    const data = readFileSync(join(artifacts, name));
    assets[name] = { sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
  }
  const manifest = { schema: 2, ...plan, assets };
  writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const manifestHash = createHash('sha256').update(readFileSync(join(artifacts, 'manifest.json'))).digest('hex');
  writeFileSync(join(artifacts, 'latest.json'), JSON.stringify({ schema: 2, repository: plan.repository, tag: plan.tag, version: plan.version, inputHash: plan.inputHash, manifestSha256: manifestHash }, null, 2) + '\n');
  writeFileSync(join(artifacts, 'release-notes.md'), `Web release ${plan.version}\n\nUpstream: ${plan.upstream}@${plan.upstreamSha}\nSource: ${plan.sourceSha}\nPublishing tools: ${plan.controlSha}\n\nPatches:\n${plan.patches.map(patch => `- #${patch.pr}: ${patch.state} (${patch.sha})`).join('\n')}\n\nInstall with:\n\n\`npm install -g https://github.com/${plan.repository}/releases/download/${plan.tag}/openchamber-web.tgz\`\n\nThe matching SDK is bundled. Use \`openchamber update\` to update from this fork, or install an older Release URL to roll back.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageRelease();
