
  Top points I accepted:

  - Checkpoints must be bound to exact mounted layer stack state.
  - Current layerId definition is circular; split tarHash and manifest hash.
  - Add recursive tombstones and opaque directory semantics.
  - Keep network transfer compressed, but store OPFS layer tar uncompressed for random seek.
  - Add missing POSIX fields/types: hardlink, uid, gid, plus stable inode strategy.
  - Use append-only user-layer writes + periodic compaction.
  - Support metadata-only overlay updates (chmod/chown/touch without data copy).

  Minor schema recommendations:

  - Use integer timestamps (createdAtMs, mtimeNs/sec+nsec), not float.
  - Define canonical JSON serialization for hashing.
  - Make tombstones explicit objects (path, recursive) for clarity.

  I also noted this work belongs to another team, so I’ll only consume their contract and align emulator/checkpoint behavior to it.
