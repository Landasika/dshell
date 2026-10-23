# Supported versions

`dshell` uses an independent SemVer. A dshell release is only advertised for the
DSH versions and platforms in this table.

## V1 (0.1.x)

| dshell | DSH | dshell protocol | Node | OS | Status |
| --- | --- | --- | --- | --- | --- |
| `0.1.0` | `0.2.1-rc.2` | 2 | `^22.19.0 \|\| >=24.0.0` | Linux x64 | **Tested** |

Verified environment:

- Ubuntu 24.04.3 LTS, x64;
- Node `v24.21.0`;
- pnpm `11.27.1`;
- DSH runtime `0.2.1-rc.2` (Mayfly CLI runtime `0.1.4-rc.1-0.2.1-rc.2`);
- Linux kernel with Unix domain sockets.

### Not supported

- macOS and Windows. The transport is a Unix socket and the plugin relies on
  Linux file modes; there is no compatibility shim in V1.
- DSH versions older than `0.2.1-rc.2`; the plugin/API contract was not tested.
- DSH versions newer than `0.2.1-rc.2`. They may work through capability
  fallback, but they are **untested**. `dshell doctor` prints a warning.
- Multiple Hosts sharing one `DSH_HOME`. Start one `dsh --profile web`; a second
  dshell Host refuses to bind the same socket.

## Compatibility behavior

1. **Capability first**: the Host `welcome` advertises capabilities. Missing
   optional features are disabled rather than guessed.
2. **Protocol mismatch is fatal**: a CLI and plugin with different protocol
   versions fail the handshake with `PROTOCOL_MISMATCH`.
3. **Core safety fails closed**: approval, timeout, disconnect, and non-TTY
   paths never auto-allow.
4. **Version is diagnostic**: an untested DSH version produces a doctor warning,
   not a hard refusal, because the capability handshake is the real contract.
5. **No DSH peer dependency**: the plugin is mounted inside the Host and the CLI
   has no runtime DSH import. Installing dshell never downloads a second DSH
   tree.

## Checking your install

```bash
dshell --version
dshell doctor
```

`doctor` reports platform, Node, socket mode, protocol, plugin version, DSH
version, and capabilities. A `[warn] dsh version` line means the Host is outside
the tested matrix.

## Upgrading

1. Stop the Host.
2. Install the new CLI/plugin (`npm install -g @landasika/dshell`, or the
   verified tarball).
3. Re-run `dsh plugin --profile web add @landasika/dshell` if the profile
   resolves a versioned package.
4. Start the Host and run `dshell doctor`.
5. Run a small TUI/`-p` smoke test before relying on it.

If the protocol version changed, upgrade the CLI and plugin together. Mixed
versions are rejected at handshake rather than half-working.

## Release verification

The release workflow and `scripts/verify-pack.sh` verify:

- tarball contains `dist/plugin/index.js`, `dist/bin/dshell.js`, and
  `cordis.patch.yml`;
- no `.p0`, `.cache`, `docs/development`, or credentials are packed;
- a clean `npm install` of the tarball exposes the `dshell` bin and the
  `dshell-host` plugin export;
- `pnpm test` (25 tests), typecheck, and lint pass.

See [`docs/dev/06-compatibility-release.md`](./dev/06-compatibility-release.md).
