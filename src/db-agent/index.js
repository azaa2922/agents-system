#!/usr/bin/env node
/**
 * DB Agent CLI
 *   node src/db-agent/index.js "design ecommerce database schema" --format prisma
 */
import { processRequest, handleError, fail, parseArgs, OUTPUT_FORMATS } from "./agent.js";

const HELP = `
🗄  DB Agent — Claude-оор өгөгдлийн сангийн дизайн

Хэрэглээ:
  node src/db-agent/index.js "<хүсэлт>" [--format sql|prisma|typeorm]

Жишээ:
  node src/db-agent/index.js "design a users table with authentication fields"
  node src/db-agent/index.js "create database schema for ecommerce app" --format prisma
  node src/db-agent/index.js "generate migration file for adding payments table"
  node src/db-agent/index.js "write SQL query to get top 10 customers"

Сонголтууд:
  --format  ${Object.keys(OUTPUT_FORMATS).join(" | ")}  (default: sql)
  --resume <sessionId>   Тасарсан session-ийг үргэлжлүүлэх (crash recovery)

Үр дүн: output/schema_YYYYMMDDHHmm.sql | .prisma | .ts
Тэмдэглэл: DB_CONNECTION_STRING (.env) одоогоор зөвхөн нөөцөд — агент SQL-ийг
бодит DB дээр ажиллуулдаггүй, файл л үүсгэнэ.

Шаардлага: .env дотор ANTHROPIC_API_KEY
           (санах ойд нэмэлтээр FIREBASE_DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_PATH)
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
  await processRequest(request, {
    format: typeof flags.format === "string" ? flags.format : undefined,
    resume: typeof flags.resume === "string" ? flags.resume : null,
  });
} catch (err) {
  handleError(err);
}
