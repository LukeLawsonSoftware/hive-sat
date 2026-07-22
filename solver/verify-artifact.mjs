import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = resolve(repositoryRoot, "public/solver");
const wasm = await readFile(resolve(outputDirectory, "cadical.wasm"));
const glue = await readFile(resolve(outputDirectory, "cadical.mjs"), "utf8");
const module = await WebAssembly.compile(wasm);
const imports = WebAssembly.Module.imports(module);
const files = await readdir(outputDirectory);

if (imports.some((entry) => entry.kind === "memory")) {
  throw new Error("solver imports memory; the artifact may be a shared/pthread build");
}
if (/SharedArrayBuffer|PThread|pthread/.test(glue)) {
  throw new Error("pthread/shared-memory runtime code found in solver glue");
}
if (files.some((file) => file.endsWith(".worker.js"))) {
  throw new Error("unexpected Emscripten pthread worker artifact found");
}

console.log("Solver artifact is a valid non-pthread WebAssembly module.");
