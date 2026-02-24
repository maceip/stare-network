import { test, expect } from "@playwright/test";

test("auto sync updates OPFS after idle", async ({ page }) => {
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
    const mount = await mounts.getDirectoryHandle("mount2", { create: true });
    const file = await mount.getFileHandle("auto.txt", { create: true });
    const writable = await file.createWritable();
    await writable.write(new TextEncoder().encode("auto"));
    await writable.close();
    document.dispatchEvent(new CustomEvent("stare:mounts-changed"));
  });

  await page.click("#stare-sync-auto");
  await page.evaluate(() => {
    const term = document.querySelector("stare-terminal") as any;
    term?.testWriteFile?.("mnt/host/mount2/auto.txt", "auto-updated");
  });

  await page.mouse.move(10, 10);
  await page.waitForFunction(async () => {
    const root = await navigator.storage.getDirectory();
    const mounts = await root.getDirectoryHandle("stare-mounts");
    const mount = await mounts.getDirectoryHandle("mount2");
    const file = await mount.getFileHandle("auto.txt");
    const data = await file.getFile();
    return (await data.text()) === "auto-updated";
  }, { timeout: 120000 });
});
