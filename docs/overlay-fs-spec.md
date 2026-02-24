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
- **Tar hash**: sha256 of the uncompressed tar payload
- **Layer ID**: sha256 of the canonical manifest JSON (excluding `layerId`)

## Manifest Schema (JSON)

Top-level fields:

- `manifestVersion` (number): must be `1`
- `layerId` (string): `sha256:<hex>` for canonical manifest JSON (excluding `layerId`)
- `tarHash` (string): `sha256:<hex>` for **uncompressed** tar payload
- `layerName` (string): human-readable, e.g. `python-3.12`
- `createdAtMs` (number): unix time in milliseconds
- `parentLayers` (string[]): optional array of layerIds
- `files` (array): file entries
- `tombstones` (array): deleted paths
- `stats` (object): optional stats

`files[]` entry:

- `path` (string): POSIX path without leading `/`
- `type` (string): `file | dir | symlink | hardlink`
- `size` (number): bytes (file only)
- `mtime` (object): `{ sec: number, nsec: number }`
- `mode` (number): file mode (octal stored as number)
- `uid` (number): user id
- `gid` (number): group id
- `sha256` (string): file content hash (file only)
- `tarOffset` (number): byte offset in tar
- `tarSize` (number): size of tar payload bytes
- `linkTarget` (string): link target (symlink or hardlink)
- `opaque` (boolean): directory shadowing when `type=dir`
- `inode` (number): stable deterministic inode (hash of path)

`tombstones[]` entry:

- `path` (string): POSIX path without leading `/`
- `recursive` (boolean): when true, deletes all children

Normalization rules:

- Paths must not contain `..` and must be normalized to `a/b/c`
- Directories are stored as `type=dir` entries
- Symlinks are stored as `type=symlink` with `linkTarget`
- Hardlinks use `type=hardlink` with `linkTarget`
- `inode` is deterministic: `fnv1a(path) & 0x7fffffff` (or similar)

## Merge Semantics (Deterministic)

Layers are merged in strict order:

1. Base layer
2. Feature overlays (in declared order)
3. User layer

Algorithm:

1. Initialize `VFS = {}`
2. For each layer in order:
   - Apply `tombstones`: delete any matching path in `VFS`
     - If `recursive`, delete all children prefixed by `path/`
   - Apply `files`: overwrite `VFS[path] = entry`
     - If `type=dir` and `opaque=true`, mask all lower-layer children
3. After merge, derive missing parent directories for files unless they were
   explicitly tombstoned in a later layer

Conflict policy:

- Later layer wins
- `tombstones` in later layer always delete the path, even if a file appears in
  earlier layers

## Content Addressing

`tarHash` = sha256 of **uncompressed** tar bytes.

`layerId` = sha256 of canonical manifest JSON **excluding** `layerId`.

Canonicalization rules:
- Sorted keys
- No whitespace
- Stable number formatting

## Incremental Sync

### Guest -> OPFS

- Export only the user layer
- Record tombstones for deletions
- Persist `layers/<layerId>/overlay.tar` + `manifest.json`
- Append-only writes: new/changed files appended to EOF and manifest updated
- Run compaction on demand (or on size threshold)

### OPFS -> Guest

- Compare manifests between old user layer and new user layer
- Apply only changed files
- Apply tombstones
- Support metadata-only entries (no tar payload for chmod/chown/touch)

## Instant Install UX

- If layer is cached in OPFS, apply immediately (<200ms)
- If not cached, download + apply with progress indicator
- Update UI state once merged layer is active

## Transport vs Storage

- Network transport may be compressed (`.tar.gz`, `.tar.zst`).
- OPFS storage must be uncompressed tar for random seek via `tarOffset`.

## Checkpoints and VFS Locking

- Checkpoints must embed the mounted layer stack ID.
- Resume is only allowed when the current layer stack matches exactly.
- Hot upgrades are only valid on cold boot.

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
