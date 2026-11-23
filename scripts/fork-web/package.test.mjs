import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('version stamping does not depend on or rewrite server TypeScript sources', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fork-web-stamp-'));
  try {
    const source = join(temp, 'source');
    const artifacts = join(temp, 'artifacts');
    mkdirSync(artifacts);
    const version = '2.8.1-fork.20261123.1.1';
    writeFileSync(join(artifacts, 'plan.json'), JSON.stringify({ version }));
    for (const folder of ['', 'packages/ui', 'packages/sdk', 'packages/web']) {
      mkdirSync(join(source, folder), { recursive: true });
      writeFileSync(join(source, folder, 'package.json'), JSON.stringify({ version: '2.8.0', dependencies: { '@openchamber/sdk': 'workspace:*' } }));
    }
    const server = join(source, 'packages/web/server/lib');
    mkdirSync(server, { recursive: true });
    const original = 'export function isUnmanagedInstall(): boolean { return false; }\n';
    writeFileSync(join(server, 'package-manager.ts'), original);
    execFileSync(process.execPath, [fileURLToPath(new URL('./package.mjs', import.meta.url)), 'stamp'], {
      env: { ...process.env, SOURCE_DIR: source, ARTIFACT_DIR: artifacts }, stdio: 'pipe',
    });
    assert.equal(JSON.parse(readFileSync(join(source, 'packages/web/package.json'))).version, version);
    assert.equal(readFileSync(join(server, 'package-manager.ts'), 'utf8'), original);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
