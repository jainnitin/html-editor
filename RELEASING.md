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

Users download the installer for their platform from the GitHub Release assets. macOS builds are signed with a Developer ID and notarized by Apple, so they open normally with no quarantine workaround. Windows builds are unsigned and may still show a SmartScreen warning.

### macOS signing secrets

The macOS jobs sign and notarize automatically when these repository secrets are present (absent them, the build still succeeds, just unsigned):

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application cert as a `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_API_ISSUER` / `APPLE_API_KEY` | App Store Connect API key issuer ID + key ID |
| `APPLE_API_KEY_P8` | the raw contents of the API key `.p8` file |
