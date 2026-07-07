#!/usr/bin/env node
/**
 * File Agent CLI
 *   node src/file-agent/index.js "convert CSV to JSON" --file data.csv
 */
import { processRequest, handleError, fail, parseArgs } from "./agent.js";

const HELP = `
📂 File Agent — Gemini-ээр файл хувиргагч

Хэрэглээ:
  node src/file-agent/index.js "<заавар>" --file <зам> [--file <зам2> ...]

Жишээ:
  node src/file-agent/index.js "convert CSV to JSON" --file data.csv
  node src/file-agent/index.js "extract headings from markdown" --file notes.md
  node src/file-agent/index.js "merge two JSON files" --file a.json --file b.json

Дэмжих форматууд: CSV, JSON, TXT, Markdown
Үр дүн: output/<нэр>_YYYYMMDDHHmm.<өргөтгөл>

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

const { positional, flags } = parseArgs(argv, { multi: ["file"] });
const instruction = positional.join(" ").trim();
const files = flags.file ?? [];

if (!instruction) {
  console.log(HELP);
  fail("Хувиргалтын зааврыг өгнө үү");
}
if (files.length === 0) {
  console.log(HELP);
  fail("--file сонголтоор дор хаяж нэг файл өгнө үү");
}

try {
  await processRequest(instruction, files, {
    resume: typeof flags.resume === "string" ? flags.resume : null,
  });
} catch (err) {
  handleError(err);
}
