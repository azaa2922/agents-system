#!/usr/bin/env node
/**
 * Data Agent CLI
 *   node src/data-agent/index.js "analyze sales.csv and find trends" --file sales.csv
 */
import { processRequest, handleError, fail, parseArgs } from "./agent.js";

const HELP = `
📊 Data Agent — Claude-оор өгөгдлийн шинжилгээ

Хэрэглээ:
  node src/data-agent/index.js "<заавар>" --file <зам>

Жишээ:
  node src/data-agent/index.js "analyze sales data and find trends" --file sales.csv
  node src/data-agent/index.js "find top 10 products by revenue" --file products.csv
  node src/data-agent/index.js "compare Q1 vs Q2 performance" --file quarters.json

Дэмжих форматууд: CSV (papaparse), JSON (объектын массив)
Үр дүн: output/analysis_YYYYMMDDHHmm.md — гол дүгнэлтүүд + ASCII chart/table

Шаардлага: .env дотор ANTHROPIC_API_KEY
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
  await processRequest(instruction, file);
} catch (err) {
  handleError(err);
}
