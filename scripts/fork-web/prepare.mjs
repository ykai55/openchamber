import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function buildVersion(upstreamVersion, runNumber, attempt, date = new Date()) {
  const base = upstreamVersion.split('-')[0];
  if (!/^\d+\.\d+\.\d+$/.test(base) || !/^\d+$/.test(runNumber) || !/^\d+$/.test(attempt)) throw new Error('Invalid build version inputs');
  return `${base}-fork.${date.toISOString().slice(0, 10).replaceAll('-', '')}.${runNumber}.${attempt}`;
}

async function prepare() {
  const config = JSON.parse(readFileSync(resolve(here, 'config.json'), 'utf8'));
  if (process.env.GITHUB_REPOSITORY !== config.repository) throw new Error('This workflow only publishes the configured fork');
  const source = resolve(process.env.SOURCE_DIR);
  const artifacts = resolve(process.env.ARTIFACT_DIR);
  mkdirSync(artifacts, { recursive: true });
  const git = (...args) => run('git', args, source);
  const upstreamSha = git('rev-parse', 'HEAD');
  const patches = [];
  for (const number of config.patches) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Patch entries must be upstream PR numbers');
    const pr = JSON.parse(run('gh', ['api', `repos/${config.upstream}/pulls/${number}`]));
    if (pr.merged) {
      git('fetch', '--quiet', '--no-tags', 'origin', pr.merge_commit_sha);
      git('merge-base', '--is-ancestor', pr.merge_commit_sha, upstreamSha);
      patches.push({ pr: number, state: 'upstream', sha: pr.merge_commit_sha });
    } else {
      if (pr.state !== 'open') throw new Error(`PR #${number} is closed without being merged; remove it from the patch list`);
      git('fetch', '--quiet', '--no-tags', 'origin', pr.head.sha);
      patches.push({ pr: number, state: 'apply', sha: pr.head.sha });
    }
  }
  const controlSha = process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(controlSha ?? '')) throw new Error('Missing controller revision');
  const inputHash = createHash('sha256').update(JSON.stringify({ upstreamSha, patches, controlSha })).digest('hex');
  const previous = spawnSync('gh', ['api', `repos/${config.repository}/releases/tags/fork-web`], { encoding: 'utf8' });
  if (previous.status === 0) {
    const asset = JSON.parse(previous.stdout).assets.find((entry) => entry.name === 'latest.json');
    if (asset) {
      const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Could not read the last release (${response.status})`);
      const latest = await response.json();
      if (latest.inputHash === inputHash && process.env.FORCE_BUILD !== 'true') {
        appendFileSync(process.env.GITHUB_OUTPUT, 'build=false\n');
        console.log('Upstream, patches and publishing tools are unchanged.');
        return;
      }
    } else {
      console.log('The rolling pointer is missing; rebuilding will restore it.');
    }
  } else if (!previous.stderr.includes('HTTP 404')) {
    throw new Error(`Could not check the previous release: ${previous.stderr}`);
  }
  for (const patch of patches.filter((entry) => entry.state === 'apply')) {
    // Merge only the explicitly selected PR heads. Conflicts fail this run;
    // the published branch and latest release remain untouched.
    git('-c', 'user.name=ykai', '-c', 'user.email=me@ykai.cc', 'merge', '--no-ff', '--no-edit', patch.sha);
  }
  const sourceSha = git('rev-parse', 'HEAD');
  const upstreamVersion = JSON.parse(readFileSync(resolve(source, 'packages/web/package.json'), 'utf8')).version;
  const version = buildVersion(upstreamVersion, process.env.GITHUB_RUN_NUMBER, process.env.GITHUB_RUN_ATTEMPT);
  const remote = `https://github.com/${config.repository}.git`;
  const previousBranchSha = git('ls-remote', remote, `refs/heads/${config.branch}`).split(/\s/)[0];
  const plan = { ...config, patches, upstreamSha, sourceSha, controlSha, upstreamVersion, version, inputHash, previousBranchSha, tag: `fork-web-${version}` };
  writeFileSync(resolve(artifacts, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  appendFileSync(process.env.GITHUB_OUTPUT, `build=true\nversion=${version}\ntag=${plan.tag}\nsha=${sourceSha}\n`);
  console.log(JSON.stringify({ version, upstreamSha, sourceSha, patches }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
