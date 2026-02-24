# Overlay FS Spec (v1)

This document defines the overlay filesystem format, merge semantics, and
incremental sync model for browser-based container instances.

## Goals

- Content-addressed, cacheable overlay layers
- Instant install of feature layers (e.g. "Install Python")
- Incremental sync for user data without full VFS export
- Deterministic, conflict-free merge semantics
- Compatible with tar-based bundles and OPFS storage

## Terms

- **Base layer**: immutable rootfs layer (tar)
- **Feature layer**: prebuilt overlay layer (python, git, node, etc.)
- **User layer**: last-write wins layer for user changes
- **Layer ID**: content hash of manifest + tar (sha256)

## Manifest Schema (JSON)

Top-level fields:

- `manifestVersion` (number): must be `1`
- `layerId` (string): `sha256:<hex>` for manifest + tar
- `layerName` (string): human-readable, e.g. `python-3.12`
- `createdAt` (string): ISO timestamp
- `parentLayers` (string[]): optional array of layerIds
- `files` (array): file entries
- `tombstones` (array): deleted paths
- `stats` (object): optional stats

`files[]` entry:

- `path` (string): POSIX path without leading `/`
- `type` (string): `file | dir | symlink`
- `size` (number): bytes (file only)
- `mtime` (number): unix seconds
- `mode` (number): file mode (octal stored as number)
- `sha256` (string): file content hash (file only)
- `tarOffset` (number): byte offset in tar
- `tarSize` (number): size of tar payload bytes
- `linkTarget` (string): symlink target (symlink only)

`tombstones[]` entry:

- `path` (string): POSIX path without leading `/`

Normalization rules:

- Paths must not contain `..` and must be normalized to `a/b/c`
- Directories are stored as `type=dir` entries
- Symlinks are stored as `type=symlink` with `linkTarget`

## Merge Semantics (Deterministic)

Layers are merged in strict order:

1. Base layer
2. Feature overlays (in declared order)
3. User layer

Algorithm:

1. Initialize `VFS = {}`
2. For each layer in order:
   - Apply `tombstones`: delete any matching path in `VFS`
   - Apply `files`: overwrite `VFS[path] = entry`
3. After merge, derive missing parent directories for files unless they were
   explicitly tombstoned in a later layer

Conflict policy:

- Later layer wins
- `tombstones` in later layer always delete the path, even if a file appears in
  earlier layers

## Content Addressing

`layerId` is a hash of:

- Normalized manifest JSON
- Tar payload bytes

Recommended:

- `sha256(manifest_bytes + tar_bytes)`

## Incremental Sync

### Guest -> OPFS

- Export only the user layer
- Record tombstones for deletions
- Persist `layers/<layerId>/overlay.tar` + `manifest.json`

### OPFS -> Guest

- Compare manifests between old user layer and new user layer
- Apply only changed files
- Apply tombstones

## Instant Install UX

- If layer is cached in OPFS, apply immediately (<200ms)
- If not cached, download + apply with progress indicator
- Update UI state once merged layer is active

## Storage Layout (OPFS)

```
/overlay
  /layers
    /<layerId>
      overlay.tar
      manifest.json
  registry.json
  user.json
```

`registry.json` maps human-readable layer names to `layerId` hashes.

## Test Requirements

- Cached install is instant and does not re-download
- Uncached install downloads and persists layer
- User layer sync updates only changed files

