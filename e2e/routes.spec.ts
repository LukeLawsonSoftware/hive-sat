import { expect, test } from "@playwright/test";

test("serves the swarm-first submission experience", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Send one hard problem/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Submit to the swarm" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Upload Instance" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "My Jobs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Swarm Mode" })).toBeVisible();
});

test("serves application routes through SPA fallback", async ({ page }) => {
  await page.goto("/swarm");
  await expect(page.getByRole("heading", { name: /Lend a little compute/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Exit Swarm Mode" })).toHaveAttribute("href", "/");

  await page.goto("/jobs/example-job");
  await expect(page.getByRole("heading", { name: "Job progress" })).toBeVisible();
  await expect(page.getByText("example-job")).toBeVisible();

  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "My jobs" })).toBeVisible();
});

test("keeps the primary routes usable without horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const route of ["/", "/jobs", "/swarm"]) {
    await page.goto(route);
    await expect(page.getByRole("link", { name: route === "/swarm" ? "Exit Swarm Mode" : "Swarm Mode" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
