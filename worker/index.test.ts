import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("HiveSAT Worker", () => {
  it("reports disabled production features from the runtime bindings", async () => {
    const response = await SELF.fetch("https://hive-sat.test/api/v1/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      features: { publicJobs: false, publicSwarm: false },
    });
  });

  it("returns a structured error for unknown API routes", async () => {
    const response = await SELF.fetch("https://hive-sat.test/api/v1/missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "API route not found" },
    });
  });
});
