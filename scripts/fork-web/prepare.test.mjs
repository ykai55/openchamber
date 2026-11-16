import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('rebuilds a release when the rolling pointer upload was interrupted', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fork-web-prepare-test-'));
  try {
    const bin = join(temp, 'bin');
    const source = join(temp, 'source');
    const artifacts = join(temp, 'artifacts');
    const output = join(temp, 'output');
    mkdirSync(bin);
    mkdirSync(join(source, 'packages', 'web'), { recursive: true });
    writeFileSync(join(source, 'packages', 'web', 'package.json'), JSON.stringify({ version: '2.7.3' }));
    writeFileSync(output, '');
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nconst path=process.argv[3]; if(path.includes('/pulls/')) console.log(JSON.stringify({merged:true,merge_commit_sha:'${'a'.repeat(40)}'})); else if(path.endsWith('/releases/tags/fork-web')) console.log(JSON.stringify({assets:[]})); else process.exit(1);\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node\nif(process.argv[2]==='rev-parse')console.log('${'a'.repeat(40)}');\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare.mjs', import.meta.url))], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin + delimiter + process.env.PATH, SOURCE_DIR: source, ARTIFACT_DIR: artifacts, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'ykai55/openchamber', GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_NUMBER: '5', GITHUB_RUN_ATTEMPT: '1' },
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
