#!/usr/bin/env node
/**
 * File Agent CLI — autonomous agentic loop
 *   node src/file-agent/index.js "convert CSV to JSON" --file data.csv
 */
import { handleError, fail, parseArgs, requireEnv } from "./agent.js";
import { createToolRegistry } from "./tool-registry.js";
import { runAgenticAgent, loopFlags } from "../core/run-agent.js";

const HELP = `
📂 File Agent — Gemini-ээр файл хувиргагч (agentic loop)

Хэрэглээ:
  node src/file-agent/index.js "<заавар>" --file <зам> [--file <зам2> ...] [--max-iterations N] [--resume <sessionId>]

Жишээ:
  node src/file-agent/index.js "convert CSV to JSON" --file data.csv
  node src/file-agent/index.js "extract headings from markdown" --file notes.md

Tools: file (read/create/append/list/transform), write, think
Дэмжих форматууд: CSV, JSON, TXT, Markdown

Үр дүн: output/<нэр>_YYYYMMDDHHmm.<өргөтгөл>
Шаардлага: .env дотор GEMINI_API_KEY
Сонголтоор: FIREBASE_DATABASE_URL + FIREBASE_SERVICE_ACCOUNT_PATH (session тракинг)
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
  requireEnv("GEMINI_API_KEY");
  await runAgenticAgent({
    agentType: "file-agent",
    label: "FILE AGENT",
    goal: `${instruction} (input files: ${files.join(", ")})`,
    toolRegistry: createToolRegistry(),
    ...loopFlags(flags),
  });
} catch (err) {
  handleError(err);
}
