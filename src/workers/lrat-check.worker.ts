import { decodeHiveCnfV1 } from "../lib/formula/hiveCnf";

interface CheckerModule {
  FS: { writeFile(path: string, contents: string): void };
  callMain(args: string[]): number;
}

type CheckerFactory = (options: {
  locateFile(path: string): string;
  print(value: string): void;
  printErr(value: string): void;
}) => Promise<CheckerModule>;

function toDimacs(encoded: Uint8Array, cube: readonly number[]): string {
  const formula = decodeHiveCnfV1(encoded);
  const clauses = [...formula.clauses, ...cube.map((literal) => [literal])];
  return [
    `p cnf ${formula.variableCount} ${clauses.length}`,
    ...clauses.map((clause) => `${clause.join(" ")} 0`),
    "",
  ].join("\n");
}

globalThis.addEventListener("message", (event: MessageEvent<{
  encodedFormula: Uint8Array;
  cube: number[];
  proof: Uint8Array;
}>) => {
  void (async () => {
    const output: string[] = [];
    try {
      const moduleUrl = new URL(["solver", "lrat-check.mjs"].join("/"), `${globalThis.location.origin}/`).href;
      const imported = await import(/* @vite-ignore */ moduleUrl) as { default: CheckerFactory };
      const checker = await imported.default({
        locateFile: (path) => new URL(path, moduleUrl).href,
        print: (value) => output.push(value),
        printErr: (value) => output.push(value),
      });
      checker.FS.writeFile("/formula.cnf", toDimacs(event.data.encodedFormula, event.data.cube));
      checker.FS.writeFile("/proof.lrat", new TextDecoder().decode(event.data.proof));
      const status = checker.callMain(["/formula.cnf", "/proof.lrat"]);
      const valid = status === 0 && output.some((line) => line.includes("VERIFIED"));
      globalThis.postMessage({ valid, ...(!valid ? { reason: output.at(-1) ?? "LRAT verification failed." } : {}) });
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status: unknown }).status)
        : -1;
      const valid = status === 0 && output.some((line) => line.includes("VERIFIED"));
      globalThis.postMessage({ valid, ...(!valid ? { reason: String(error) } : {}) });
    }
  })();
});
