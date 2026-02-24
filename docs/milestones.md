# Demo Milestones + Test Gates

## M1 — Demo Layout + 2-Term Minimum

Deliverables
1. 2 terminals in the UI with correct split layout.
2. Terminal focus/active styling.
3. Terminal status rail visible and consistent.

Test gates
1. Manual: load page and verify two terminals render (desktop + mobile breakpoints).
2. E2E: smoke test that both terminal components mount and report `data-ready="1"`.

## M2 — 3-Term Layout Ready (Marketing Iteration)

Deliverables
1. 3-terminal layout (2 vertical left, 1 right split horizontal) wired.
2. Responsive variants: fold / phone behavior.

Test gates
1. Manual: layout matches spec at 3 breakpoints.
2. E2E: snapshot/DOM test for pane counts and sizes.

## M3 — Suspend/Resume (Minimal Overlay)

Deliverables
1. “Suspend” button saves current tar snapshot to OPFS.
2. “Resume” loads snapshot at boot.

Test gates
1. E2E: write file in guest → suspend → reload → file still exists.
2. E2E: time-to-resume under 2s for cached snapshot.

## M4 — Overlay Spec v1 (Content Addressed + Manifest)

Deliverables
1. Manifest generation for user layer.
2. Layer ID hash stored and retrievable.
3. Ability to register a feature layer (`python`) by hash.

Test gates
1. E2E: manifest created and hash stable.
2. E2E: install python overlay uses cache when present.

## M5 — Incremental Sync

Deliverables
1. User layer only export (no full VFS).
2. Manifest diff apply.

Test gates
1. E2E: write file → sync → OPFS user layer updated.
2. E2E: deletion → tombstone recorded → file removed on resume.

## M6 — Streaming/Seekable Optimization (Optional)

Deliverables
1. Partial fetch support based on manifest offsets.
2. Seekable compression optional.

Test gates
1. E2E: install python with partial fetch works.
2. Performance: large layer install faster than full download.

## Where To Put Friscy Runtime (Not In This Repo)

Recommended path (separate from public demo repo):

- `/home/pooppoop/friscy-runtime`

Alternative (local-only, gitignored):

- `/home/pooppoop/qwik/stare/.local/friscy-runtime`

Wire `stare` to the runtime via an env var:

- `FRISCY_RUNTIME_PATH=/home/pooppoop/friscy-runtime`
