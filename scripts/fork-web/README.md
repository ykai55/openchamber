# Personal Web releases

This workflow lives on the fork's default `main` branch. It builds upstream
`main` with the open PRs listed in `config.json`, publishes tested packages to
GitHub Releases, and advances the generated `personal` branch. Changes made
directly on fork `main` are not implicitly included in the program.

## Synchronization

- Runs every six hours at minute 17 UTC, when publishing tools/config change on
  `main`, and through the workflow's Run workflow action.
- An unchanged upstream commit, patch list and controller revision skip the build.
- Add an upstream PR number to `patches` to include an unmerged change. Its exact
  head is merged into a fresh upstream checkout. A conflict stops the run.
- Merged PRs are skipped only after their merge commit is confirmed in the
  selected upstream revision. Closed, unmerged PRs stop the run for a decision.
- `personal` is generated. Develop on separate branches; direct edits to
  `personal` are replaced on a later successful build. A force-with-lease prevents
  overwriting a concurrent edit made during the build.
- The existing fork `main` source changes and old `latest` release are preserved.

`config.json` initially lists #6902. It is already upstream, so the first build
has no additional source patch. The other historical fork `main` fixes are not
included unless they are already upstream or explicitly added as PRs.

## Release contract

Versions have the form `2.7.3-fork.20261116.22.1`: upstream package version,
UTC date, workflow run number, and attempt. Each version has its own immutable
`fork-web-<version>` release. The `fork-web` prerelease holds a small `latest.json`
pointer, updated only after installation checks pass and the version is published.

Each version publishes the Web and SDK tarballs, `manifest.json` with SHA-256
checksums, and a standalone `update.mjs`. No npm publishing permission is needed.
The packages are built from the same source and stamped with the same version.
The installer installs the SDK from the local archive, so an unpublished fork
SDK version never has to exist on npm. Runtime dependencies and native modules
are installed for the target machine, not copied from the Linux build runner.

The package overlay makes the Web UI report a manually managed installation.
Use this updater for fork releases. The updater's `cli update` command also
routes here, instead of installing the official npm package.

## Install and update

Requires Node.js 24.14+, npm, tar, and an installed OpenCode CLI compatible with
the packaged Web version. Download `update.mjs` from the selected immutable
release. Run it with Node:

```sh
node update.mjs install
node ~/.local/share/openchamber-fork/update.mjs check
node ~/.local/share/openchamber-fork/update.mjs update
node ~/.local/share/openchamber-fork/update.mjs rollback
```

`--root <directory>` selects a different installation root; pass it on later
commands too. `--json` produces machine-readable output without prompts.
Installation verifies checksums and the installed package version before
switching `current`. `previous` retains the former program. Existing OpenChamber
settings, sessions and credentials remain in the usual data directories.
An update refuses an older release, including a stale cached pointer; use the
explicit rollback command to return to the preceding installed version.

Installation alone does not stop or replace a running official server. To try
the installed version in the foreground on a free port:

```sh
node ~/.local/share/openchamber-fork/update.mjs --port 4097 run
```

For macOS login startup, stop/disable the previous server yourself, then:

```sh
node ~/.local/share/openchamber-fork/update.mjs --port 4096 service
```

This registers a separate `cc.ykai.openchamber-fork.<root-hash>` LaunchAgent. It refuses an
occupied port. The launcher resolves `current` on each start, so upgrades do not
leave launchd pointing at a deleted version. It binds to loopback. PATH, HOME,
LANG, OPENCODE_BINARY, OPENCHAMBER_DATA_DIR and OPENCHAMBER_UI_PASSWORD, when set
for this command, are preserved in the private service configuration. Credential
values are never printed; keep the LaunchAgent file private.

Updates restart only this fork's registered service and verify its reported
version. A failed health check restores the previous program and restarts it.
Rollback switches program files only; it cannot undo an upstream data migration.
Without the fork service, restart any manually launched process yourself after
updating. Old version directories remain available for inspection.

Forward other CLI commands with `node update.mjs cli <arguments>`.
If a killed updater leaves `.update-lock` under the installation root, verify
that no update is running before removing that lock and retrying.

## Verification

`node --test scripts/fork-web/*.test.mjs` exercises versioning, archive integrity,
clean local SDK installation, failed-update preservation and program rollback.
The workflow also installs the real built packages in an empty temporary root,
checks the CLI version and UI assets, and verifies manual-update ownership.
Native macOS service startup must be checked when the user activates it; the
Linux packaging job cannot verify launchd or a macOS native dependency build.
