import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve(process.env.SOURCE_DIR);
const artifacts = resolve(process.env.ARTIFACT_DIR);
const plan = JSON.parse(readFileSync(resolve(artifacts, 'plan.json'), 'utf8'));
if (process.env.GITHUB_REPOSITORY !== plan.repository) throw new Error('Release repository mismatch');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

// Only the generated branch is replaced, and only if nobody moved it since
// preparation. Fork main and personal development branches are never reset.
run('git', ['-c', 'credential.helper=!gh auth git-credential', 'push', `--force-with-lease=refs/heads/${plan.branch}:${plan.previousBranchSha}`, `https://github.com/${plan.repository}.git`, `${plan.sourceSha}:refs/heads/${plan.branch}`], source);
run('gh', ['release', 'create', plan.tag, ...['openchamber-web.tgz', 'openchamber-sdk.tgz', 'update.mjs', 'manifest.json'].map(file => resolve(artifacts, file)), '--repo', plan.repository, '--draft', '--prerelease', '--target', plan.sourceSha, '--title', plan.version, '--notes-file', resolve(artifacts, 'release-notes.md')]);
run('gh', ['release', 'edit', plan.tag, '--repo', plan.repository, '--draft=false', '--latest=false']);

const pointer = spawnSync('gh', ['api', `repos/${plan.repository}/releases/tags/fork-web`], { encoding: 'utf8' });
if (pointer.status === 0) {
  run('gh', ['release', 'upload', 'fork-web', resolve(artifacts, 'latest.json'), '--repo', plan.repository, '--clobber']);
  run('gh', ['release', 'edit', 'fork-web', '--repo', plan.repository, '--title', `Personal web: ${plan.version}`, '--notes', `Latest tested personal Web build: ${plan.tag}. Install with the update.mjs attached to that immutable release.`, '--latest=false']);
} else if (pointer.stderr.includes('HTTP 404')) {
  run('gh', ['release', 'create', 'fork-web', resolve(artifacts, 'latest.json'), '--repo', plan.repository, '--prerelease', '--target', plan.sourceSha, '--title', `Personal web: ${plan.version}`, '--notes', `Latest tested personal Web build: ${plan.tag}. Install with the update.mjs attached to that immutable release.`, '--latest=false']);
} else {
  throw new Error(`Could not update the release pointer: ${pointer.stderr}`);
}
