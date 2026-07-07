#!/usr/bin/env node
/**
 * Data Agent CLI — autonomous agentic loop
 *   node src/data-agent/index.js "analyze sales.csv and find trends" --file sales.csv
 */
import { handleError, fail, parseArgs, requireEnv } from "./agent.js";
import { createToolRegistry } from "./tool-registry.js";
import { runAgenticAgent, loopFlags } from "../core/run-agent.js";

const HELP = `
📊 Data Agent — Claude-оор өгөгдлийн шинжилгээ (agentic loop)

Хэрэглээ:
  node src/data-agent/index.js "<заавар>" --file <зам> [--max-iterations N] [--resume <sessionId>]

Жишээ:
  node src/data-agent/index.js "analyze sales data and find trends" --file sales.csv
  node src/data-agent/index.js "find top 10 products by revenue" --file products.csv

Tools: data (CSV/JSON шинжилгээ), file, write (тайлан → output/), think
Дэмжих форматууд: CSV (papaparse), JSON (объектын массив)

Үр дүн: output/analysis_YYYYMMDDHHmm.md
Шаардлага: .env дотор ANTHROPIC_API_KEY
Сонголтоор: FIREBASE_DATABASE_URL + FIREBASE_SERVICE_ACCOUNT_PATH (session тракинг)
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const { positional, flags } = parseArgs(argv);
const instruction = positional.join(" ").trim();
const file = typeof flags.file === "string" ? flags.file : null;

if (!instruction) {
  console.log(HELP);
  fail("Шинжилгээний зааврыг өгнө үү");
}
if (!file) {
  console.log(HELP);
  fail("--file сонголтоор өгөгдлийн файлаа өгнө үү");
}

try {
  requireEnv("ANTHROPIC_API_KEY");
  await runAgenticAgent({
    agentType: "data-agent",
    label: "DATA AGENT",
    goal: `${instruction} (data file: ${file})`,
    toolRegistry: createToolRegistry(),
    ...loopFlags(flags),
  });
} catch (err) {
  handleError(err);
}
