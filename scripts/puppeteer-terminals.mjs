import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { request } from "undici";
import puppeteer from "puppeteer";

const DEV_URL = "http://127.0.0.1:5173";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";

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

    const browser = await puppeteer.launch({
      headless: "new",
      protocolTimeout: 600000,
      executablePath: CHROME_PATH,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(600000);

    page.on("console", (msg) => console.log(`[browser] ${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => console.log(`[browser] pageerror: ${err.message}`));

    await page.evaluateOnNewDocument(() => {
      window.__STARE_ALLOW_INSECURE__ = true;
    });

    await page.goto(DEV_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("stare-terminal", { timeout: 60000 });

    const count = await page.evaluate(() => document.querySelectorAll("stare-terminal").length);
    if (count !== 3) throw new Error(`Expected 3 terminals, saw ${count}`);

    // Wait until each terminal has some output (boot text)
    await page.waitForFunction(() => {
      const terms = Array.from(document.querySelectorAll("stare-terminal"));
      return terms.length === 3 && terms.every((t) => (t.getAttribute("data-ready") === "1") || (t.getOutputText?.()?.length ?? 0) > 0);
    }, { timeout: 600000, polling: 1000 });

    // Mount local folder into guest via OPFS
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const mounts = await root.getDirectoryHandle("stare-mounts", { create: true });
      const mount = await mounts.getDirectoryHandle("mount1", { create: true });
      const file = await mount.getFileHandle("hello.txt", { create: true });
      const writable = await file.createWritable();
      await writable.write(new TextEncoder().encode("from opfs"));
      await writable.close();
      document.dispatchEvent(new CustomEvent("stare:mounts-changed"));
    });

    // Verify mount visible inside guest (alpine)
    await page.evaluate(() => {
      const alpine = document.querySelector('stare-terminal[data-example="alpine"]');
      alpine?.sendInput?.("cat /mnt/host/mount1/hello.txt\n");
    });

    await page.waitForFunction(() => {
      const alpine = document.querySelector('stare-terminal[data-example="alpine"]');
      const out = alpine?.getOutputText?.() || "";
      return out.includes("from opfs");
    }, { timeout: 180000, polling: 1000 });

    // NodeJS stdin/stdout check
    await page.evaluate(() => {
      const nodejs = document.querySelector('stare-terminal[data-example="nodejs"]');
      nodejs?.sendInput?.("1+1\n");
    });

    await page.waitForFunction(() => {
      const nodejs = document.querySelector('stare-terminal[data-example="nodejs"]');
      const out = nodejs?.getOutputText?.() || "";
      return /\b2\b/.test(out);
    }, { timeout: 180000, polling: 1000 });

    // Edit file in guest then sync back to OPFS
    await page.evaluate(() => {
      const alpine = document.querySelector('stare-terminal[data-example="alpine"]');
      alpine?.sendInput?.("echo updated-from-guest > /mnt/host/mount1/hello.txt\n");
    });

    await page.click("#stare-sync-btn");

    await page.waitForFunction(() => {
      const chip = document.querySelector('[data-chip="sync-time"]');
      return chip && !chip.textContent?.includes("--:--");
    }, { timeout: 180000, polling: 1000 });

    const updated = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const mounts = await root.getDirectoryHandle("stare-mounts");
      const mount = await mounts.getDirectoryHandle("mount1");
      const file = await mount.getFileHandle("hello.txt");
      const data = await file.getFile();
      return await data.text();
    });

    if (!updated.includes("updated-from-guest")) {
      throw new Error(`OPFS content mismatch: ${updated}`);
    }

    // Claude CLI output (direct fetch)
    await page.waitForFunction(() => {
      const claude = document.querySelector('stare-terminal[data-example="claude-cli"]');
      const out = claude?.getOutputText?.() || "";
      return /risc|emulation|haiku|limerick/i.test(out) && !/error/i.test(out);
    }, { timeout: 600000, polling: 1000 });

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
