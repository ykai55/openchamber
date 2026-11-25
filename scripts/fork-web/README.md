# Personal Web releases

The fork's `main` branch owns the publishing workflow and `config.json`. The
generated `personal` branch contains the latest stable upstream Release tag plus
configured PR patches that are not yet included in that release.
Other changes on fork `main` are not implicitly included in the program.

## Synchronization

After upstream PR backports, the build applies `scripts/fork-web/patches/*.patch`
in filename order. These are fork-only changes, including the compact keyboard
shortcut actions. A patch already in the stable source is skipped; a conflict
stops the build before publication. The release manifest lists them in `forkPatches`.

The workflow runs every six hours at minute 17 UTC, on publishing-tool/config
changes to `main`, and through Run workflow. Unchanged inputs skip the build.
Add upstream PR numbers to `patches`; conflicts or closed, unmerged PRs stop the
run. Merged PRs are skipped only when the selected stable tag contains their
merge commits. A PR merged to `main` but not released remains a backport.
For a merged PR, its recorded target base and merge result define the patch;
an open PR uses its merge-base-to-head diff. Only the diff is applied, so later
`main` history does not enter `personal`. A patch already present is skipped.
#6902 is backported on `v2.7.2` and will retire once a stable release includes it.

`personal` is generated. Develop on separate branches based on upstream `main`.
A successful build replaces `personal` using force-with-lease, preserving edits
made concurrently with the build. Fork `main` and the old `latest` release remain
untouched by that generated-branch update.

Set the repository Actions secret `FORK_PUSH_TOKEN` to a fine-grained token for
this fork with Contents and Workflows read/write permissions. Only the publishing
step receives it, for the Git push. Release API calls use the built-in Actions
token. Build and install steps receive neither publishing credential.

## Install and update

Each immutable `fork-web-<version>` release contains **one installable Web tgz
with its matching SDK bundled**. It requires no unpublished SDK version on npm.
Native/runtime dependencies are installed by npm for the target machine.

Requires Node.js 24.14+, npm, and a compatible installed OpenCode CLI. Copy the
Web archive URL from the selected Release:

```sh
npm install -g --allow-scripts=node-pty https://github.com/ykai55/openchamber/releases/download/<tag>/openchamber-web.tgz
openchamber --version
```

The script allowance lets npm prepare the native terminal module. Confirm that
the CLI reports the fork version. If multiple Node/package-manager
installations exist, use the npm prefix whose `openchamber` command is on PATH.
Installation alone does not restart an existing server. Use the normal
OpenChamber start/startup commands when switching the running server to it.

```sh
openchamber-fork-update check
openchamber update
```

The packaged CLI's update command checks this fork, verifies its manifest and
archive checksums, then installs the tgz with npm. Upstream's existing update
command owns instance discovery, restarting services and checking the resulting
version. The adapter refuses to install through a different npm global prefix.
It downloads before stopping any CLI instance, and ignores an older latest
pointer. `--quiet` and `--json` follow the CLI's existing output modes.

The browser's official update route stays manually managed; update the fork
through the CLI. Settings, sessions and credentials use the normal OpenChamber
locations. There is no separate fork LaunchAgent or version-directory manager.

Packaging follows the CLI entry declared in the Web package manifest. The fork
adapters are applied to the emitted JavaScript after upstream build/prepack, so
TypeScript sources are compiled normally and prepack cannot overwrite the
adapters. Both the legacy `bin/` layout and the compiled `build/bin/` layout use
the same update contract.

To roll back, install a previous Release's Web tgz with npm and restart using
the normal OpenChamber service management. Program rollback does not undo data
migrations. The earlier two-archive experimental release used a different
installer; bootstrap this npm package directly when moving from that release.

## Release contract and verification

Versions such as `2.7.3-fork.20261116.22.1` use the next patch version after the
latest stable release (`v2.7.2` in this example), followed by the UTC date,
workflow run number and attempt. Draft and prerelease tags are never bases.
Immutable releases publish the Web
archive, `manifest.json` and the standalone update/check helper. The `fork-web`
prerelease holds `latest.json`, updated after the package passes a clean npm
installation check. Schema 2 identifies the single-archive format.

`node --test scripts/fork-web/*.test.mjs` covers stable-tag selection, diff-only
backports and automatic patch retirement, version ordering, pointer
recovery, checksums, installing the single tgz with its private-version SDK,
updating through npm, and explicitly reinstalling an older archive. The workflow
also installs the real package into a temporary npm global prefix and verifies
its CLI, SDK version and manual browser-update policy. It does not switch the
user's running service.
