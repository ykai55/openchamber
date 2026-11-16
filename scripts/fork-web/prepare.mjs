import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function buildVersion(upstreamVersion, runNumber, attempt, date = new Date()) {
  const base = upstreamVersion.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(base) || !/^\d+$/.test(runNumber) || !/^\d+$/.test(attempt)) throw new Error('Invalid build version inputs');
  const [major, minor, patch] = base.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}-fork.${date.toISOString().slice(0, 10).replaceAll('-', '')}.${runNumber}.${attempt}`;
}

export function stableReleaseTag(release) {
  if (release.draft !== false || release.prerelease !== false || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name ?? '')) throw new Error('The latest upstream release is not a stable version');
  return release.tag_name;
}

export function applyPullRequestPatch(source, patch) {
  const diff = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', patch.base, patch.sha], { cwd: source, maxBuffer: 32 * 1024 * 1024 });
  if (diff.length === 0) return false;
  const reverse = spawnSync('git', ['apply', '--reverse', '--check'], { cwd: source, input: diff, stdio: ['pipe', 'pipe', 'pipe'] });
  if (reverse.status === 0) return false;
  execFileSync('git', ['apply', '--3way', '--index'], { cwd: source, input: diff, stdio: ['pipe', 'pipe', 'pipe'] });
  if (spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: source }).status === 0) return false;
  run('git', ['-c', 'user.name=ykai', '-c', 'user.email=me@ykai.cc', 'commit', '-m', `Apply upstream PR #${patch.pr} to the stable release`], source);
  return true;
}

async function prepare() {
  const config = JSON.parse(readFileSync(resolve(here, 'config.json'), 'utf8'));
  if (process.env.GITHUB_REPOSITORY !== config.repository) throw new Error('This workflow only publishes the configured fork');
  if (process.argv[2] === 'resolve') {
    const release = JSON.parse(run('gh', ['api', `repos/${config.upstream}/releases/latest`]));
    const tag = stableReleaseTag(release);
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
    console.log(`Stable upstream release: ${tag}`);
    return;
  }
  const source = resolve(process.env.SOURCE_DIR);
  const artifacts = resolve(process.env.ARTIFACT_DIR);
  mkdirSync(artifacts, { recursive: true });
  const git = (...args) => run('git', args, source);
  const upstreamTag = stableReleaseTag({ tag_name: process.env.UPSTREAM_TAG, draft: false, prerelease: false });
  const upstreamSha = git('rev-parse', 'HEAD');
  if (git('rev-parse', `refs/tags/${upstreamTag}^{commit}`) !== upstreamSha) throw new Error('Source checkout does not match the selected stable tag');
  const upstreamVersion = upstreamTag.replace(/^v/, '');
  if (JSON.parse(readFileSync(resolve(source, 'packages/web/package.json'), 'utf8')).version !== upstreamVersion) throw new Error('Stable tag and Web package versions disagree');
  const patches = [];
  for (const number of config.patches) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Patch entries must be upstream PR numbers');
    const pr = JSON.parse(run('gh', ['api', `repos/${config.upstream}/pulls/${number}`]));
    if (pr.merged) {
      git('fetch', '--quiet', '--no-tags', 'origin', pr.merge_commit_sha);
      const included = spawnSync('git', ['merge-base', '--is-ancestor', pr.merge_commit_sha, upstreamSha], { cwd: source });
      if (included.status !== 0 && included.status !== 1) throw new Error(`Cannot determine whether PR #${number} is in the stable release`);
      if (included.status === 0) patches.push({ pr: number, state: 'upstream', sha: pr.merge_commit_sha });
      else {
        // The recorded target base and merge result delimit the landed PR,
        // including maintainer edits, without importing later main history.
        git('fetch', '--quiet', '--no-tags', 'origin', pr.base.sha);
        git('merge-base', '--is-ancestor', pr.base.sha, pr.merge_commit_sha);
        patches.push({ pr: number, state: 'apply', base: pr.base.sha, sha: pr.merge_commit_sha });
      }
    } else {
      if (pr.state !== 'open') throw new Error(`PR #${number} is closed without being merged; remove it from the patch list`);
      git('fetch', '--quiet', '--no-tags', 'origin', pr.head.sha);
      git('fetch', '--quiet', '--no-tags', 'origin', pr.base.sha);
      patches.push({ pr: number, state: 'apply', base: git('merge-base', pr.base.sha, pr.head.sha), sha: pr.head.sha });
    }
  }
  const controlSha = process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(controlSha ?? '')) throw new Error('Missing controller revision');
  const inputHash = createHash('sha256').update(JSON.stringify({ upstreamTag, upstreamSha, patches, controlSha })).digest('hex');
  const previous = spawnSync('gh', ['api', `repos/${config.repository}/releases/tags/fork-web`], { encoding: 'utf8' });
  if (previous.status === 0) {
    const asset = JSON.parse(previous.stdout).assets.find((entry) => entry.name === 'latest.json');
    if (asset) {
      const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Could not read the last release (${response.status})`);
      const latest = await response.json();
      if (latest.inputHash === inputHash && process.env.FORCE_BUILD !== 'true') {
        appendFileSync(process.env.GITHUB_OUTPUT, 'build=false\n');
        console.log('Stable release, patches and publishing tools are unchanged.');
        return;
      }
    } else {
      console.log('The rolling pointer is missing; rebuilding will restore it.');
    }
  } else if (!previous.stderr.includes('HTTP 404')) {
    throw new Error(`Could not check the previous release: ${previous.stderr}`);
  }
  for (const patch of patches.filter((entry) => entry.state === 'apply')) {
    // Apply only each PR's diff. Conflicts leave published refs untouched.
    if (!applyPullRequestPatch(source, patch)) patch.state = 'already-present';
  }
  const sourceSha = git('rev-parse', 'HEAD');
  const version = buildVersion(upstreamVersion, process.env.GITHUB_RUN_NUMBER, process.env.GITHUB_RUN_ATTEMPT);
  const remote = `https://github.com/${config.repository}.git`;
  const previousBranchSha = git('ls-remote', remote, `refs/heads/${config.branch}`).split(/\s/)[0];
  const plan = { ...config, patches, upstreamTag, upstreamSha, sourceSha, controlSha, upstreamVersion, version, inputHash, previousBranchSha, tag: `fork-web-${version}` };
  writeFileSync(resolve(artifacts, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  appendFileSync(process.env.GITHUB_OUTPUT, `build=true\nversion=${version}\ntag=${plan.tag}\nsha=${sourceSha}\n`);
  console.log(JSON.stringify({ version, upstreamSha, sourceSha, patches }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
