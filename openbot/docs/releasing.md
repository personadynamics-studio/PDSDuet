# Releasing

This page covers desktop version tooling and deploying published images. GitHub release and CI
workflows are no longer included in this checkout.


## Desktop build versions

The root `package.json` is the release version source. After a manual root version change,
`bun desktop/scripts/desktop-version.ts sync` updates the desktop Cargo manifest and lockfile.

Internal desktop artifacts use `X.Y.Z-internal.g<commit>` to identify the source revision. The desktop
version script prepares this version before packaging and writes `build-version.json` with the full
commit and release version.

To build locally, from the repository root:

```sh
bun desktop/scripts/desktop-version.ts internal
cd desktop
APPLE_SIGNING_IDENTITY=- bun run tauri build --config src-tauri/tauri.build-version.conf.json --bundles dmg
```

Use `release` instead of `internal` to prepare the plain release version. This only builds an
artifact; it does not publish a release. macOS keeps numeric system version fields and stores
the full internal identifier in `OpenBotBuildVersion` inside the app's `Info.plist`. Windows
retains the full identifier in `ProductVersion` and `FileVersion`; its fixed numeric fields
contain the release number.

Ad-hoc signed Mac builds require the first-open exception described in
[Apple's instructions](https://support.apple.com/en-us/102445). They are for internal testing
and are not Apple-notarized. See [Windows signing](windows-signing.md) for signed NSIS builds.


## Deploying a release

Supply this project's own built images and a `container-images.json` naming their immutable
references. The desktop and Compose consume these image keys: `agent-computer`, `supervisor`,
`agent-langgraph`, and `server` (used by the `initialize` service). The `agent-claude-sdk` and
`agent-langgraph-agui` keys remain for the Claude and ChatGPT subscription bridges respectively;
the desktop selects their images through the `agent-harness` service. Use the supplied file to
select the container images:

```sh
export COMPUTER_IMAGE="$(jq -r '.images["agent-computer"].reference' container-images.json)"
export SUPERVISOR_IMAGE="$(jq -r .images.supervisor.reference container-images.json)"
export LANGGRAPH_IMAGE="$(jq -r '.images["agent-langgraph"].reference' container-images.json)"
export SERVER_IMAGE="$(jq -r .images.server.reference container-images.json)"
export IMAGE_PULL_POLICY=missing
docker compose up -d
```

Compose starts the container dependencies. The existing source startup script or desktop shell
still starts the API and web app.

`IMAGE_PULL_POLICY=missing` is what turns those names into pulls; without it every one of those
services builds from source, because a service with a `build` section builds by default whatever
its image is called. A pull that fails still falls back to building, so a machine with no toolchain
wants the `build` sections overridden away rather than this variable alone.

A tag can be moved to point at a different image; a digest cannot. The selected digest is the one
that runs, and rolling back is the same command with an earlier version.

