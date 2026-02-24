import { test, expect } from "@playwright/test";

test("three terminals boot with network and IO", async ({ page }) => {
  test.setTimeout(900000);
  await page.addInitScript(() => {
    (window as any).__STARE_ALLOW_INSECURE__ = true;
    (window as any).__STARE_TEST_FAST_BOOT__ = true;
  });

  await page.goto("/");

  await page.evaluate(async () => {
    const initMod = await import("/src/components/stare-init.ts");
    await initMod.initStare();
  });

  await page.waitForSelector("stare-terminal", { timeout: 60000 });
  await page.waitForFunction(
    () => document.querySelectorAll("stare-terminal").length === 3,
    { timeout: 60000 },
  );

  await page.waitForTimeout(1500);

  await page.waitForFunction(() => {
    const terms = Array.from(document.querySelectorAll("stare-terminal"));
    return terms.length === 3 && terms.every((t) => t.getAttribute("data-network") === "1");
  }, { timeout: 60000 });

  await page.evaluate(() => {
    const alpine = document.querySelector('stare-terminal[data-example="alpine"]') as any;
    const nodejs = document.querySelector('stare-terminal[data-example="nodejs"]') as any;
    const claude = document.querySelector('stare-terminal[data-example="claude-cli"]') as any;
    alpine?.sendInput?.("echo STARE_ALPINE\n");
    nodejs?.sendInput?.("1+1\n");
    claude?.sendInput?.("\n");
  });

  await page.waitForFunction(() => {
    const alpine = document.querySelector('stare-terminal[data-example="alpine"]') as any;
    const out = alpine?.getOutputText?.() || "";
    return out.includes("STARE_ALPINE");
  }, { timeout: 120000 });

  await page.waitForFunction(() => {
    const nodejs = document.querySelector('stare-terminal[data-example="nodejs"]') as any;
    const out = nodejs?.getOutputText?.() || "";
    return out.includes("1+1");
  }, { timeout: 120000 });

  await page.waitForFunction(() => {
    const claude = document.querySelector('stare-terminal[data-example="claude-cli"]') as any;
    const out = claude?.getOutputText?.() || "";
    return out.length > 40;
  }, { timeout: 180000 });

  const outputs = await page.evaluate(() => {
    const terms = Array.from(document.querySelectorAll("stare-terminal")) as any[];
    return terms.map((t) => (t.getOutputText?.() || "").length);
  });

  outputs.forEach((len) => expect(len).toBeGreaterThan(0));
});
