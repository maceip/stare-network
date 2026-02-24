# Overlay FS E2E (Puppeteer)

These tests validate overlay install + user layer sync using Puppeteer.

## Running

```
STARE_OVERLAY_E2E=1 node tests/overlay/run_overlay_tests.mjs
```

## Tests

1) Cached install
- Preseed OPFS with python overlay layer
- Click "Install Python"
- Expect install completes in <200ms
- Expect python binary present in VFS

2) Uncached install
- Clear OPFS
- Click "Install Python"
- Expect download + apply progress
- Expect layer cached in OPFS

3) User layer sync
- Create a file in guest
- Trigger sync
- Expect user-layer manifest contains the file
- Expect layer persisted in OPFS
