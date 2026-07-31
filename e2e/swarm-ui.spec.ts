import { devices, expect, test } from "@playwright/test";

test.describe("Phase 9 Swarm Mode", () => {
  test("defaults paused and labels contribution telemetry honestly", async ({ page }) => {
    await page.goto("/swarm");
    await expect(page.getByRole("link", { name: "Exit Swarm Mode" })).toHaveAttribute("href", "/");
    await expect(page.getByRole("button", { name: "Start contributing" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /Pause when hidden/i })).toBeChecked();
    await expect(page.getByText("Wasm allocation now")).toBeVisible();
    await expect(page.getByText("linear memory, not process RAM")).toBeVisible();
    await expect(page.getByText(/No OS-level CPU percentage is claimed/i)).toBeVisible();
    await expect(page.getByText(/search tree/i)).toHaveCount(0);
    await page.getByRole("button", { name: "Reset local totals" }).click();
    await expect.poll(() => page.evaluate(async () => {
      const request = indexedDB.open("hivesat-swarm-stats", 1);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("totals", "readonly");
      const values = await new Promise<Array<{ key: string; activeWorkerMs: number }>>((resolve, reject) => {
        const all = transaction.objectStore("totals").getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      });
      database.close();
      return values;
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "current-session", activeWorkerMs: 0 }),
      expect.objectContaining({ key: "device-lifetime", activeWorkerMs: 0 }),
    ]));
  });

  test("uses the one-worker fallback and responsive layout on mobile", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["Pixel 7"] });
    const page = await context.newPage();
    await page.goto("/swarm");
    await expect(page.getByRole("option", { name: "1" })).toHaveCount(1);
    await expect(page.getByRole("option", { name: "2" })).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await context.close();
  });

  test("respects reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/swarm");
    const duration = await page.getByRole("button", { name: "Start contributing" })
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    const seconds = duration.endsWith("ms")
      ? Number.parseFloat(duration) / 1_000
      : Number.parseFloat(duration);
    expect(seconds).toBeLessThanOrEqual(0.00001);
  });

  test("keeps the worker selector usable while contribution is active", async ({ page }) => {
    await page.goto("/swarm");
    const workers = page.getByRole("combobox", { name: /Maximum workers/i });
    await workers.selectOption("1");
    await page.getByRole("button", { name: "Start contributing" }).click();

    await expect(workers).toBeEnabled();
    await workers.selectOption("2");
    await expect(workers).toHaveValue("2");
    await expect(page.getByRole("button", { name: "Pause contribution" })).toBeVisible();
    await expect(page.getByText("Rolling local worker activity")).toBeVisible();
  });
});
