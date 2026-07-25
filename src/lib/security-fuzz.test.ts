import { describe, expect, it } from "vitest";
import { parseCoordinatorClientMessage } from "../../shared/coordinator-protocol";
import { verifyTextLrat } from "../../shared/lrat-check";
import { parseResultManifest, decodeSatModelArtifact } from "../../shared/result-manifest";
import { parseSwarmClientMessage } from "../../shared/swarm-protocol";
import { parseDimacsText } from "./formula/dimacs";

function generator(seed = 0x51a7): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomText(random: () => number, maximum = 256): string {
  const length = Math.floor(random() * maximum);
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(Math.floor(random() * 128));
  }
  return value;
}

describe("bounded parser fuzz regression", () => {
  it("never throws from WebSocket or artifact manifest validators", () => {
    const random = generator();
    const choices: unknown[] = [null, true, 1, "", [], {}, Number.NaN, Number.MAX_SAFE_INTEGER];
    for (let index = 0; index < 1_000; index += 1) {
      const value = {
        type: randomText(random, 24),
        protocolVersion: Math.floor(random() * 6),
        messageId: randomText(random),
        jobId: randomText(random),
        sessionId: randomText(random),
        taskId: randomText(random),
        leaseId: randomText(random),
        cube: Array.from({ length: Math.floor(random() * 80) }, () => Math.floor(random() * 10) - 5),
        capabilities: choices[Math.floor(random() * choices.length)],
        manifest: choices[Math.floor(random() * choices.length)],
      };
      expect(() => parseCoordinatorClientMessage(value)).not.toThrow();
      expect(() => parseSwarmClientMessage(value)).not.toThrow();
      expect(() => parseResultManifest(value)).not.toThrow();
    }
  });

  it("fails closed on random DIMACS, model, and proof bytes", async () => {
    const random = generator(0xc0ffee);
    for (let index = 0; index < 250; index += 1) {
      const text = randomText(random, 512);
      await parseDimacsText(text).then(
        (formula) => {
          expect(formula.literalCount).toBeLessThanOrEqual(2_000_000);
          expect(formula.clauses).toHaveLength(formula.clauseCount);
        },
        (error: unknown) => expect(error).toBeInstanceOf(Error),
      );
      const bytes = new TextEncoder().encode(text);
      try {
        const decoded = decodeSatModelArtifact(bytes);
        expect(decoded.assignment.byteLength).toBeLessThanOrEqual(512 * 1024);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(() => verifyTextLrat([[1], [-1]], text, {
        maxProofBytes: 512,
        maxDerivedClauses: 100,
        maxHints: 1_000,
      })).not.toThrow();
    }
  });
});
