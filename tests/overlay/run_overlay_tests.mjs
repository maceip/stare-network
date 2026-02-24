import puppeteer from "puppeteer";

const BASE_URL = process.env.STARE_BASE_URL || "http://127.0.0.1:5173";

const ensureEnabled = () => {
  if (process.env.STARE_OVERLAY_E2E !== "1") {
    console.log("SKIP: set STARE_OVERLAY_E2E=1 to run overlay tests");
    process.exit(0);
  }
};

const boot = async (page) => {
  await page.addInitScript(() => {
    window.__STARE_ALLOW_INSECURE__ = true;
  });
  await page.goto(BASE_URL, { waitUntil: "networkidle2" });
  await page.waitForSelector("stare-terminal[data-ready=\"1\"]", { timeout: 240000 });
};

const withPage = async (fn) => {
  const browser = await puppeteer.launch({ headless: "new" });
  try {
    const page = await browser.newPage();
    await fn(page);
  } finally {
    await browser.close();
  }
};

const checkOverlayHooks = async (page) => {
  const ok = await page.evaluate(() => {
    return Boolean(window.__stareOverlay);
  });
  if (!ok) {
    throw new Error("overlay hooks missing: window.__stareOverlay not found");
  }
};

const testCachedInstall = async () => {
  await withPage(async (page) => {
    await boot(page);
    await checkOverlayHooks(page);
    const start = Date.now();
    await page.evaluate(async () => {
      await window.__stareOverlay.seedLayer("python");
      await window.__stareOverlay.install("python");
    });
    const elapsed = Date.now() - start;
    if (elapsed > 200) throw new Error(`cached install too slow: ${elapsed}ms`);
  });
};

const testUncachedInstall = async () => {
  await withPage(async (page) => {
    await boot(page);
    await checkOverlayHooks(page);
    await page.evaluate(async () => {
      await window.__stareOverlay.clearCache();
      await window.__stareOverlay.install("python");
      const ok = await window.__stareOverlay.isCached("python");
      if (!ok) throw new Error("layer not cached after install");
    });
  });
};

const testUserLayerSync = async () => {
  await withPage(async (page) => {
    await boot(page);
    await checkOverlayHooks(page);
    await page.evaluate(async () => {
      await window.__stareOverlay.writeUserFile("/mnt/host/hello.txt", "hi");
      await window.__stareOverlay.syncUserLayer();
      const has = await window.__stareOverlay.userManifestHas("mnt/host/hello.txt");
      if (!has) throw new Error("user manifest missing test file");
    });
  });
};

const main = async () => {
  ensureEnabled();
  const tests = [
    { name: "cached install", fn: testCachedInstall },
    { name: "uncached install", fn: testUncachedInstall },
    { name: "user layer sync", fn: testUserLayerSync },
  ];

  let passed = 0;
  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn();
      const ms = Date.now() - start;
      console.log(`PASS ${t.name} (${ms}ms)`);
      passed++;
    } catch (err) {
      console.error(`FAIL ${t.name}:`, err.message || err);
      process.exitCode = 1;
      break;
    }
  }

  console.log(`pass=${passed}/${tests.length}`);
  if (passed !== tests.length) process.exit(1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
