import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { request } from "undici";
import puppeteer from "puppeteer";

const DEV_URL = "http://127.0.0.1:5173";

const waitForServer = async (timeoutMs = 60000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request(DEV_URL, { method: "GET" });
      if (res.statusCode >= 200 && res.statusCode < 500) return true;
    } catch {
      // ignore
    }
    await sleep(500);
  }
  throw new Error("Dev server did not start in time");
};

const run = async () => {
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5173"], {
    stdio: "inherit",
  });

  try {
    await waitForServer(90000);

    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      window.__STARE_ALLOW_INSECURE__ = true;
      window.__STARE_TEST_FAST_BOOT__ = true;
    });

    await page.goto(DEV_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("stare-terminal", { timeout: 30000 });

    await page.evaluate(async () => {
      window.__stareInit = false;
      const mod = await import("/src/components/stare-init.ts");
      await mod.initStare();
    });

    const count = await page.evaluate(() => document.querySelectorAll("stare-terminal").length);
    if (count !== 3) throw new Error(`Expected 3 terminals, saw ${count}`);

    await page.waitForFunction(() => {
      const terms = Array.from(document.querySelectorAll("stare-terminal"));
      return terms.length === 3 && terms.every((t) => t.getAttribute("data-ready") === "1");
    }, { timeout: 20000 });

    await page.evaluate(() => {
      const alpine = document.querySelector('stare-terminal[data-example="alpine"]');
      const nodejs = document.querySelector('stare-terminal[data-example="nodejs"]');
      const claude = document.querySelector('stare-terminal[data-example="claude-cli"]');
      alpine?.sendInput?.("echo STARE_ALPINE\n");
      nodejs?.sendInput?.("1+1\n");
      claude?.sendInput?.("\n");
    });

    await page.waitForFunction(() => {
      const alpine = document.querySelector('stare-terminal[data-example="alpine"]');
      return alpine?.getOutputText?.().includes("STARE_ALPINE");
    }, { timeout: 20000 });

    await page.waitForFunction(() => {
      const nodejs = document.querySelector('stare-terminal[data-example="nodejs"]');
      return nodejs?.getOutputText?.().includes("1+1");
    }, { timeout: 20000 });

    const netOk = await page.evaluate(() => {
      const terms = Array.from(document.querySelectorAll("stare-terminal"));
      return terms.every((t) => t.getAttribute("data-network") === "1");
    });

    if (!netOk) throw new Error("Network flag missing on one or more terminals");

    await browser.close();
    console.log("Puppeteer: terminals boot test PASSED");
  } finally {
    dev.kill("SIGINT");
  }
};

run().catch((err) => {
  console.error("Puppeteer: terminals boot test FAILED\n", err);
  process.exit(1);
});
