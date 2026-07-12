#!/usr/bin/env node
/**
 * DB Agent CLI — autonomous agentic loop
 *   node src/db-agent/index.js "design ecommerce database schema" --format prisma
 */
import { handleError, fail, parseArgs, requireEnv, OUTPUT_FORMATS } from "./agent.js";
import { createToolRegistry } from "./tool-registry.js";
import { runAgenticAgent, loopFlags } from "../core/run-agent.js";

const HELP = `
🗄  DB Agent — Gemini-ээр өгөгдлийн сангийн дизайн (agentic loop)

Хэрэглээ:
  node src/db-agent/index.js "<хүсэлт>" [--format sql|prisma|typeorm] [--max-iterations N] [--resume <sessionId>]

Жишээ:
  node src/db-agent/index.js "design a users table with authentication fields"
  node src/db-agent/index.js "create database schema for ecommerce app" --format prisma

Сонголтууд:
  --format  ${Object.keys(OUTPUT_FORMATS).join(" | ")}  (default: sql)

Tools: db (Gemini schema → output/), file, write, think

Үр дүн: output/schema_YYYYMMDDHHmm.sql | .prisma | .ts
Тэмдэглэл: агент SQL-ийг бодит DB дээр ажиллуулдаггүй, файл л үүсгэнэ.
Шаардлага: .env дотор GEMINI_API_KEY
Сонголтоор: FIREBASE_DATABASE_URL + FIREBASE_SERVICE_ACCOUNT_PATH (session тракинг)
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const { positional, flags } = parseArgs(argv);
const request = positional.join(" ").trim();

if (!request) {
  console.log(HELP);
  fail("Өгөгдлийн сангийн хүсэлтээ өгнө үү");
}

try {
  requireEnv("GEMINI_API_KEY");
  await runAgenticAgent({
    agentType: "db-agent",
    label: "DB AGENT",
    goal: request,
    toolRegistry: createToolRegistry({
      format: typeof flags.format === "string" ? flags.format : undefined,
    }),
    ...loopFlags(flags),
  });
} catch (err) {
  handleError(err);
}
