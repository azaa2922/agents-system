#!/usr/bin/env node
/**
 * Search Agent CLI — autonomous agentic loop
 *   node src/search-agent/index.js "search for best React libraries"
 *
 * Урсгал (plan → execute → reflect, зорилго биелтэл давтана):
 *   1. AgenticLoop дараагийн 1-3 алхмаа төлөвлөнө
 *   2. toolRegistry-гийн tool-уудыг ажиллуулна (search / think / write)
 *   3. Үр дүнг эргэцүүлж, дуусаагүй бол дахин давтана
 *   4. Session бүр Firebase RTDB-д хадгалагдана (тохируулсан үед)
 */
import { handleError, fail, requireEnv } from "./agent.js";
import { createToolRegistry } from "./tool-registry.js";
import { runAgenticAgent, loopFlags } from "../core/run-agent.js";

const HELP = `
🔎 Search Agent — autonomous Gemini + Tavily вэб хайлт (agentic loop)

Хэрэглээ:
  node src/search-agent/index.js "<хайх зүйл>" [--max-iterations N] [--resume <sessionId>]

Жишээ:
  node src/search-agent/index.js "Find React frameworks and compare them"
  node src/search-agent/index.js "2026 оны JavaScript framework-үүдийн харьцуулалт"

Tools: search (Tavily), think (Gemini дүгнэлт), write (output/ руу тайлан)

Шаардлага: .env дотор GEMINI_API_KEY, TAVILY_API_KEY
Сонголтоор: FIREBASE_DATABASE_URL + FIREBASE_SERVICE_ACCOUNT_PATH (session тракинг)
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

function takeOption(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}

const flags = {
  "max-iterations": takeOption("--max-iterations"),
  resume: takeOption("--resume"),
};

const goal = argv.filter((a) => !a.startsWith("-")).join(" ").trim();
if (!goal) {
  console.log(HELP);
  fail("Хайлтын зорилгоо өгнө үү");
}

try {
  requireEnv("GEMINI_API_KEY", "TAVILY_API_KEY");
  await runAgenticAgent({
    agentType: "search-agent",
    label: "SEARCH AGENT",
    goal,
    toolRegistry: createToolRegistry(),
    ...loopFlags(flags),
  });
} catch (err) {
  handleError(err);
}
