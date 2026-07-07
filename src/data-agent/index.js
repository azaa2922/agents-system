#!/usr/bin/env node
/**
 * Data Agent CLI
 *   node src/data-agent/index.js "analyze sales.csv and find trends" --file sales.csv
 */
import { processRequest, handleError, fail, parseArgs } from "./agent.js";

const HELP = `
📊 Data Agent — Gemini-ээр өгөгдлийн шинжилгээ

Хэрэглээ:
  node src/data-agent/index.js "<заавар>" --file <зам>

Жишээ:
  node src/data-agent/index.js "analyze sales data and find trends" --file sales.csv
  node src/data-agent/index.js "find top 10 products by revenue" --file products.csv
  node src/data-agent/index.js "compare Q1 vs Q2 performance" --file quarters.json

Дэмжих форматууд: CSV (papaparse), JSON (объектын массив)
Үр дүн: output/analysis_YYYYMMDDHHmm.md — гол дүгнэлтүүд + ASCII chart/table

Сонголт:
  --resume <sessionId>   Тасарсан session-ийг үргэлжлүүлэх (crash recovery)

Шаардлага: .env дотор GEMINI_API_KEY
           (санах ойд нэмэлтээр FIREBASE_DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_PATH)
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
  await processRequest(instruction, file, {
    resume: typeof flags.resume === "string" ? flags.resume : null,
  });
} catch (err) {
  handleError(err);
}
