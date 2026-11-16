import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
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

// Release installations are owned by update.mjs. The web Update button must
// not replace this copy with the official npm package.
const managerPath = resolve(source, 'packages/web/server/lib/package-manager.js');
const manager = readFileSync(managerPath, 'utf8');
const unmanaged = /export function isUnmanagedInstall\(\) \{\n[^}]+\n\}/g;
if ([...manager.matchAll(unmanaged)].length !== 1) throw new Error('The upstream update-management hook changed; review the fork packaging overlay');
writeFileSync(managerPath, manager.replace(unmanaged, 'export function isUnmanagedInstall() {\n  return true;\n}'));

if (process.argv[2] !== 'stamp') {
for (const name of ['sdk', 'web']) {
  const before = new Set(readdirSync(artifacts));
  execFileSync('bun', ['pm', 'pack', '--cwd', `packages/${name}`, '--destination', artifacts], { cwd: source, stdio: 'inherit' });
  const files = readdirSync(artifacts).filter((file) => file.endsWith('.tgz') && !before.has(file));
  if (files.length !== 1) throw new Error(`Expected one ${name} archive`);
  renameSync(resolve(artifacts, files[0]), resolve(artifacts, `openchamber-${name}.tgz`));
}
copyFileSync(resolve(here, 'update.mjs'), resolve(artifacts, 'update.mjs'));
const assets = {};
for (const name of ['openchamber-web.tgz', 'openchamber-sdk.tgz', 'update.mjs']) {
  const data = readFileSync(resolve(artifacts, name));
  assets[name] = { sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
}
const manifest = { schema: 1, ...plan, assets };
writeFileSync(resolve(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const manifestHash = createHash('sha256').update(readFileSync(resolve(artifacts, 'manifest.json'))).digest('hex');
writeFileSync(resolve(artifacts, 'latest.json'), JSON.stringify({ schema: 1, repository: plan.repository, tag: plan.tag, version: plan.version, inputHash: plan.inputHash, manifestSha256: manifestHash }, null, 2) + '\n');
writeFileSync(resolve(artifacts, 'release-notes.md'), `Web release ${plan.version}\n\nUpstream: ${plan.upstream}@${plan.upstreamSha}\nSource: ${plan.sourceSha}\nPublishing tools: ${plan.controlSha}\n\nPatches:\n${plan.patches.map(patch => `- #${patch.pr}: ${patch.state} (${patch.sha})`).join('\n')}\n\nInstall and update with the attached update.mjs. Both Web and SDK archives are required. This is a personal fork release; it is not published to npm.\n`);
}
