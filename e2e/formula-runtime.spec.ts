import { expect, test, type Page } from "@playwright/test";
import { gzipSync } from "node:zlib";
import path from "node:path";

const fixtures = path.join(import.meta.dirname, "fixtures");

async function choose(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByLabel("Choose DIMACS CNF file").setInputFiles(file);
}

async function chooseAndSolve(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await choose(page, file);
  await page.getByRole("button", { name: "Solve locally" }).click();
}

test.describe("Phase 3 formula runtime", () => {
  test("strictly parses and solves known SAT/UNSAT fixtures", async ({ page }) => {
    await page.goto("/");
    await chooseAndSolve(page, path.join(fixtures, "known-sat.cnf"));
    await expect(page.getByText("Local CaDiCaL verdict")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "SAT", exact: true })).toBeVisible();
    await expect(page.getByText("Model verified")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download model" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("known-sat.model.txt");
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const output = await import("node:fs/promises").then(({ readFile }) =>
      readFile(downloadPath!, "utf8"),
    );
    expect(output).toContain("s SATISFIABLE\n");
    expect(output).toContain("v 1 2 0\n");

    await page.getByRole("button", { name: "New instance" }).click();
    await chooseAndSolve(page, path.join(fixtures, "known-unsat.cnf"));
    await expect(page.getByText("Local CaDiCaL verdict")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "UNSAT", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download model" })).toHaveCount(0);
  });

  test("accepts gzip DIMACS and stores a verified formula cache entry by SHA-256", async ({ page }) => {
    await page.goto("/");
    const dimacs = Buffer.from("c compressed fixture\np cnf 2 2\n1 0\n2 0\n");
    const compressedFile = {
      name: "compressed.cnf.gz",
      mimeType: "application/gzip",
      buffer: gzipSync(dimacs),
    };
    await chooseAndSolve(page, compressedFile);
    await expect(page.getByRole("heading", { name: "SAT", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Stored", { exact: true })).toBeVisible();

    const cached = await page.evaluate(async () => {
      const request = indexedDB.open("hivesat-formulas", 1);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("verified-formulas", "readonly");
      const recordsRequest = transaction.objectStore("verified-formulas").getAll();
      const records = await new Promise<Array<{ hash: string; encoded: ArrayBuffer; gzip: ArrayBuffer }>>(
        (resolve, reject) => {
          recordsRequest.onsuccess = () => resolve(recordsRequest.result);
          recordsRequest.onerror = () => reject(recordsRequest.error);
        },
      );
      database.close();
      return records.map((record) => ({
        hash: record.hash,
        encodedBytes: record.encoded.byteLength,
        compressedBytes: record.gzip.byteLength,
      }));
    });
    expect(cached).toHaveLength(1);
    expect(cached[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cached[0].encodedBytes).toBeGreaterThan(20);
    expect(cached[0].compressedBytes).toBeLessThanOrEqual(5 * 1024 * 1024);

    await page.getByRole("button", { name: "New instance" }).click();
    await chooseAndSolve(page, compressedFile);
    await expect(page.getByRole("heading", { name: "SAT", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Verified hit", { exact: true })).toBeVisible();
  });

  test("surfaces strict parser locations without invoking the solver", async ({ page }) => {
    await page.goto("/");
    await choose(page, {
      name: "malformed.cnf",
      mimeType: "text/plain",
      buffer: Buffer.from("c bad literal\np cnf 2 1\n1 nope 0\n"),
    });
    await expect(page.getByText("Local runtime error")).toBeVisible();
    await expect(page.getByText(/line 3, column 3, byte offset 26/i)).toBeVisible();
  });

  test("rejects a gzip decompression bomb before parsing beyond 32 MiB", async ({ page }) => {
    await page.goto("/");
    const expanded = Buffer.alloc(32 * 1024 * 1024 + 1, 0x20);
    await choose(page, {
      name: "bomb.cnf.gz",
      mimeType: "application/gzip",
      buffer: gzipSync(expanded),
    });
    await expect(page.getByText("Local runtime error")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/decompressed DIMACS exceeds the 33554432-byte limit/i)).toBeVisible();
  });

  test("pauses and resumes one conflict-bounded CaDiCaL instance", async ({ page }) => {
    await page.goto("/");
    const pigeons = 20;
    const holes = 19;
    const lines = [`p cnf ${pigeons * holes} ${pigeons + pigeons * holes * (holes - 1) / 2 + holes * pigeons * (pigeons - 1) / 2}`];
    const variable = (pigeon: number, hole: number) => pigeon * holes + hole + 1;
    for (let pigeon = 0; pigeon < pigeons; pigeon += 1) {
      lines.push(`${Array.from({ length: holes }, (_, hole) => variable(pigeon, hole)).join(" ")} 0`);
      for (let first = 0; first < holes; first += 1) {
        for (let second = first + 1; second < holes; second += 1) {
          lines.push(`${-variable(pigeon, first)} ${-variable(pigeon, second)} 0`);
        }
      }
    }
    for (let hole = 0; hole < holes; hole += 1) {
      for (let first = 0; first < pigeons; first += 1) {
        for (let second = first + 1; second < pigeons; second += 1) {
          lines.push(`${-variable(first, hole)} ${-variable(second, hole)} 0`);
        }
      }
    }

    await chooseAndSolve(page, {
      name: "resume.cnf",
      mimeType: "text/plain",
      buffer: Buffer.from(`${lines.join("\n")}\n`),
    });
    await expect(page.getByRole("heading", { name: "Exploring assignments" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Pause solve" }).click();
    await expect(page.getByText(/resume continues the current bounded CaDiCaL search/i)).toBeVisible();
    await page.getByRole("button", { name: "Solve locally" }).click();
    await expect(page.getByRole("heading", { name: "Exploring assignments" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause solve" })).toBeVisible();
  });

  test("differentially matches brute force on deterministic random small formulas", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const { loadCaDiCaL, SolverStatus } = await import("/solver/hivesat.mjs");
      const runtime = await loadCaDiCaL();
      let state = 0x5eed1234;
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
      };
      const cases: Array<{ variables: number; clauses: number[][] }> = [];
      for (let caseIndex = 0; caseIndex < 80; caseIndex += 1) {
        const variables = 1 + Math.floor(random() * 7);
        const clauseCount = Math.floor(random() * 18);
        const clauses = Array.from({ length: clauseCount }, () => {
          const length = Math.floor(random() * 5);
          return Array.from({ length }, () => {
            const variable = 1 + Math.floor(random() * variables);
            return random() < 0.5 ? variable : -variable;
          });
        });
        cases.push({ variables, clauses });
      }

      const mismatches: number[] = [];
      for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
        const testCase = cases[caseIndex];
        const bruteSat = Array.from({ length: 1 << testCase.variables }, (_, assignment) => assignment)
          .some((assignment) => testCase.clauses.every((clause) =>
            clause.some((literal) => {
              const value = Boolean(assignment & (1 << (Math.abs(literal) - 1)));
              return value === (literal > 0);
            }),
          ));
        const solver = runtime.createSolver();
        for (const clause of testCase.clauses) solver.addClauses([...clause, 0]);
        const status = solver.solve(-1);
        solver.dispose();
        if ((status === SolverStatus.SAT) !== bruteSat) mismatches.push(caseIndex);
      }
      return { count: cases.length, mismatches };
    });

    expect(result.count).toBe(80);
    expect(result.mismatches).toEqual([]);
  });
});
