const LITERALS_PER_LINE = 20;

export function formatDimacsSatModel(model: readonly number[], formulaHash: string): string {
  for (const literal of model) {
    if (!Number.isInteger(literal) || literal === 0) {
      throw new Error(`Cannot export invalid model literal ${literal}.`);
    }
  }

  const lines = [
    "c HiveSAT independently verified SAT model",
    `c formula-sha256 ${formulaHash}`,
    "s SATISFIABLE",
  ];

  if (model.length === 0) {
    lines.push("v 0");
  } else {
    for (let offset = 0; offset < model.length; offset += LITERALS_PER_LINE) {
      const literals = model.slice(offset, offset + LITERALS_PER_LINE).join(" ");
      const isLastLine = offset + LITERALS_PER_LINE >= model.length;
      lines.push(`v ${literals}${isLastLine ? " 0" : ""}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function modelDownloadFilename(formulaFilename: string): string {
  const stem = formulaFilename.replace(/\.cnf(?:\.gz)?$/i, "") || "formula";
  return `${stem}.model.txt`;
}

