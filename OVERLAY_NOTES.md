# Overlay FS Notes (Friscy Reference)

These notes summarize the prior overlay filesystem design from the Windows friscy repo. No code is copied; this is conceptual guidance only.

## Observed Overlay Design (Reference)
- Overlay is represented as a tar archive, not individual file diffs.
- The browser worker exposes a VFS export command (`CMD_EXPORT_VFS = 8`) which dumps a tar snapshot of the current VFS and posts it back to the main thread.
- Exported tar is also persisted into OPFS (e.g. `persisted_rootfs.tar`) for reload continuity.
- Overlay load path exists via a worker message (e.g. `load_overlay`), which writes the tar into the wasm FS at `/tmp/overlay.tar`.
- On boot, the worker attempts to restore from OPFS first and falls back to the bundled rootfs if no persisted tar exists.
- There is a periodic auto-save loop that triggers VFS export and persists to OPFS.

## Problems / Risks in the Current Design
- Full snapshot tar export is heavy and scales poorly for large sessions.
- Persisted tar writes on a timer can cause significant IO and UI stalls.
- Overlay injection (`/tmp/overlay.tar`) depends on runtime-side logic to apply it; it is opaque from the JS layer and can fail silently.
- Single-file tar persistence makes partial update or conflict resolution difficult; a single corruption invalidates the entire overlay.
- Reload restore always prefers OPFS tar, which can mask failures and make recovery tricky when the tar is stale/bad.

## High-Impact, Low-Effort Improvements
- **Overlay-only export**: Export just `/mnt/host` (or designated mutable paths) instead of full VFS. This reduces tar size and sync cost.
- **Incremental apply**: Keep a manifest (size + mtime) in OPFS to skip unchanged files on sync and prune deleted entries.
- **User-triggered save with soft autosave**: Default to manual sync, keep a longer autosave interval, and add idle-triggered sync with backoff.
- **Transparent sync telemetry**: Expose `files written/skipped` and last sync time in the UI to build confidence.
- **Resilient fallback**: If OPFS restore fails, fall back to bundled rootfs and keep the failed tar as a backup file.
- **Lightweight test stub**: For E2E, stub overlay writes via a minimal tar builder rather than relying on a full guest shell.

## Relevance to STARE
- The tar-based overlay approach can be retained but should focus on incremental + scoped exports and explicit user controls.
- The E2E strategy should validate OPFS round-trip without depending on a full guest shell (unless the image is verified to execute commands).
