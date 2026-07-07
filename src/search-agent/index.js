#!/usr/bin/env node
/**
 * Search Agent CLI
 *   node src/search-agent/index.js "search for best React libraries"
 */
import { processRequest, handleError, fail, parseArgs } from "./agent.js";

const HELP = `
🔎 Search Agent — Gemini + Tavily вэб хайлт

Хэрэглээ:
  node src/search-agent/index.js "<хайх зүйл>" [--resume <sessionId>]

Жишээ:
  node src/search-agent/index.js "search for best React libraries"
  node src/search-agent/index.js "2026 оны JavaScript framework-үүдийн харьцуулалт"

Урсгал (санах ойтой):
  1. Session үүсгэнэ (Firebase тохируулсан бол)
  2. Gemini хайлтын стратеги, query-нүүдийг төлөвлөнө
  3. Tavily API-аар хайлт бүрийг гүйцэтгэнэ (олдвор нь context-д хуримтлагдана)
  4. Gemini үр дүнг нэгтгэж дүгнэлт бичнэ
  5. output/search_YYYYMMDDHHmm.md файлд хадгална

Сонголт:
  --resume <sessionId>   Тасарсан session-ийг үргэлжлүүлэх (crash recovery)

Шаардлага: .env дотор GEMINI_API_KEY, TAVILY_API_KEY
           (санах ойд нэмэлтээр FIREBASE_DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_PATH)
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const { positional, flags } = parseArgs(argv);
const query = positional.join(" ").trim();
if (!query) {
  console.log(HELP);
  fail("Хайлтын хүсэлтээ өгнө үү");
}

try {
  await processRequest(query, { resume: typeof flags.resume === "string" ? flags.resume : null });
} catch (err) {
  handleError(err);
}
