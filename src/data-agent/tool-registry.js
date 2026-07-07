/**
 * Data Agent Tool Registry
 * Tools: data (CSV/JSON analysis with Claude), file, write, think
 */
import path from "node:path";
import fse from "fs-extra";
import Papa from "papaparse";
import { callClaude, OUTPUT_DIR, timestamp, log } from "./agent.js";
import { makeFileTool, makeWriteTool, makeThinkTool } from "../core/registry-helpers.js";

const SAMPLE_ROWS = 100;

const SYSTEM = `You are a data-analysis agent. You receive a dataset profile, a sample of rows and an instruction.
Write a clear analysis report in Markdown that:
- answers the instruction directly,
- lists key findings as bullets with concrete numbers,
- includes at least one ASCII table,
- notes data-quality caveats when relevant.
Base every number strictly on the provided profile/sample — if the sample is partial, say so.
Write the report in the same language as the instruction.`;

function loadData(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") {
    const parsed = Papa.parse(text.trim(), { header: true, dynamicTyping: true, skipEmptyLines: true });
    return parsed.data;
  }
  if (ext === ".json") {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  }
  throw new Error(`Дэмжигдээгүй өргөтгөл: ${ext || "(байхгүй)"} — .csv эсвэл .json ашиглана уу`);
}

function profileData(rows) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const numeric = {};
  for (const col of columns) {
    const values = rows.map((r) => r[col]).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (values.length === 0 || values.length < rows.length / 2) continue;
    const sum = values.reduce((a, b) => a + b, 0);
    numeric[col] = {
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      mean: +(sum / values.length).toFixed(4),
      sum: +sum.toFixed(4),
    };
  }
  return { rows: rows.length, columns, numeric };
}

export function createToolRegistry() {
  return {
    /** Analyze a CSV/JSON file with Claude. params: { file, analysis|instruction } */
    async data(params) {
      const file = params.file || params.path;
      const instruction = params.analysis || params.instruction || params.value || "Analyze this dataset";
      if (!file) throw new Error("data tool: 'file' параметр шаардлагатай");

      const full = path.resolve(process.cwd(), file);
      const text = await fse.readFile(full, "utf8");
      if (!text.trim()) throw new Error(`${file} файл хоосон байна`);
      const rows = loadData(full, text);
      if (rows.length === 0) throw new Error("Өгөгдлийн мөр олдсонгүй");

      const profile = profileData(rows);
      log(`[DataAnalysis] ${file} — ${profile.rows} мөр, ${profile.columns.length} багана`);

      const sample = rows.slice(0, SAMPLE_ROWS);
      const userMsg = [
        `Instruction: ${instruction}`,
        `Dataset file: ${path.basename(full)}`,
        `Profile (computed over ALL ${profile.rows} rows):`,
        JSON.stringify(profile, null, 2),
        rows.length > SAMPLE_ROWS
          ? `Sample (first ${SAMPLE_ROWS} of ${rows.length} rows):`
          : `All rows (${rows.length}):`,
        JSON.stringify(sample, null, 2),
      ].join("\n\n");

      return await callClaude(SYSTEM, userMsg);
    },

    file: makeFileTool({ outputDir: OUTPUT_DIR, log }),
    write: makeWriteTool({ outputDir: OUTPUT_DIR, timestamp, log, prefix: "analysis" }),
    think: makeThinkTool({ callClaude, label: "data-analysis agent" }),
  };
}

export default createToolRegistry;
