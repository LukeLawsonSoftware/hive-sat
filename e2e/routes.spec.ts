import { expect, test } from "@playwright/test";

test("serves the local browser-solver experience", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Many browsers/i })).toBeVisible();
  await expect(page.getByText("Local solver")).toBeVisible();
});

test("serves route placeholders through SPA fallback", async ({ page }) => {
  await page.goto("/swarm");
  await expect(page.getByRole("heading", { name: "Swarm mode" })).toBeVisible();

  await page.goto("/jobs/example-job");
  await expect(page.getByRole("heading", { name: "Job status" })).toBeVisible();
  await expect(page.getByText("example-job")).toBeVisible();
});
