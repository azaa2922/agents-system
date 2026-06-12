#!/usr/bin/env node
/**
 * Search Agent CLI
 *   node src/search-agent/index.js "search for best React libraries"
 */
import { processRequest, handleError, fail } from "./agent.js";

const HELP = `
🔎 Search Agent — Claude + Tavily вэб хайлт

Хэрэглээ:
  node src/search-agent/index.js "<хайх зүйл>"

Жишээ:
  node src/search-agent/index.js "search for best React libraries"
  node src/search-agent/index.js "2026 оны JavaScript framework-үүдийн харьцуулалт"

Урсгал:
  1. Claude хайлтын стратеги, query-нүүдийг төлөвлөнө
  2. Tavily API-аар хайлтуудыг гүйцэтгэнэ
  3. Claude үр дүнг нэгтгэж дүгнэлт бичнэ
  4. output/search_YYYYMMDDHHmm.md файлд хадгална

Шаардлага: .env дотор ANTHROPIC_API_KEY, TAVILY_API_KEY
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const query = argv.filter((a) => !a.startsWith("-")).join(" ").trim();
if (!query) {
  console.log(HELP);
  fail("Хайлтын хүсэлтээ өгнө үү");
}

try {
  await processRequest(query);
} catch (err) {
  handleError(err);
}
