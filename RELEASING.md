# Releasing HTML Editor

## One-time updater setup

Generate the Tauri updater signing keypair:

```sh
npm run tauri signer generate -- -w ~/.tauri/html-editor.key
```

Store the generated private key in the GitHub repository secret `TAURI_SIGNING_PRIVATE_KEY`, and store its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Back up both securely.

Put the generated public key in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey` before relying on auto-updates.

> Losing the private key means existing installs can never auto-update again. Users would have to reinstall manually, so keep a secure backup.

## Before you push

```bash
npm run preflight
```

Runs the same checks as CI — vite build, `cargo fmt --check`, clippy with
warnings denied, workflow YAML, version agreement across the three manifests,
and a scan for committed credentials. CI takes minutes per attempt; this takes
seconds, and a release rejected for formatting costs a full rebuild.

## Cut a release

1. Bump the version in all three places:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
2. Commit the version changes.
3. Create and push a matching tag:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow also supports manual `workflow_dispatch`; provide the existing `vX.Y.Z` tag when prompted.

## How publishing works

Each platform builds in parallel into a **draft** release, and a final job
publishes it only once `latest.json` contains every platform.

This matters because GitHub resolves `/releases/latest` to the newest published
release. Publishing per-platform meant a macOS build could go live minutes
before Windows, and a Windows user checking for updates in that window got
"none of the fallback platforms were found". While the release is a draft,
installed apps keep seeing the previous complete release instead.

If the publish job fails, the release stays a draft and nobody is offered a
partial update — fix the failing platform and re-run.

## Release outputs

The workflow builds and publishes one GitHub Release containing the macOS Apple Silicon bundle, macOS Intel bundle, Windows x64 bundle, and the signed `latest.json` updater manifest consumed by `tauri-plugin-updater`.

Users should download the installer for their platform from the GitHub Release assets. Because builds are unsigned, macOS users may need to remove quarantine for the first manual install, for example:

```sh
xattr -dr com.apple.quarantine "/Applications/HTML Editor.app"
```

Auto-updates after that initial install are signed with the updater key and are not affected by Gatekeeper quarantine in the same way. Windows users may still see unsigned-app warnings.
