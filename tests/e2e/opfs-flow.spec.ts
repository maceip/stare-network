import { test, expect } from "@playwright/test";

test("alpine guest OPFS round-trip", async ({ page }) => {
  test.setTimeout(300000);
  await page.addInitScript(() => {
    (window as any).__STARE_ALLOW_INSECURE__ = true;
    (window as any).__STARE_TEST_STUB__ = true;
  });
  await page.goto("/");

  await page.waitForSelector("stare-terminal", { timeout: 60000 });
  await page.waitForTimeout(3000);

  await page.waitForSelector("stare-terminal[data-ready=\"1\"]", {
    timeout: 240000,
  });

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const mounts = await root.getDirectoryHandle("stare-mounts", {
      create: true,
    });
    const mount = await mounts.getDirectoryHandle("mount1", { create: true });
    const file = await mount.getFileHandle("hello.txt", { create: true });
    const writable = await file.createWritable();
    await writable.write(new TextEncoder().encode("from opfs"));
    await writable.close();
    document.dispatchEvent(new CustomEvent("stare:mounts-changed"));
  });

  await page.evaluate(() => {
    const term = document.querySelector("stare-terminal") as any;
    term?.testWriteFile?.("mnt/host/mount1/hello.txt", "updated");
  });

  await page.click("#stare-sync-btn");
  await page.waitForFunction(() => {
    const chip = document.querySelector('[data-chip="sync-time"]');
    return chip && !chip.textContent?.includes("--:--");
  });

  const updated = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const mounts = await root.getDirectoryHandle("stare-mounts");
    const mount = await mounts.getDirectoryHandle("mount1");
    const file = await mount.getFileHandle("hello.txt");
    const data = await file.getFile();
    return await data.text();
  });

  expect(updated).toBe("updated");
});
