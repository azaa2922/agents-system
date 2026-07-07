#!/usr/bin/env node
/**
 * Code Agent CLI — autonomous agentic loop
 *   node src/code-agent/index.js "generate React todo app with useState"
 */
import { handleError, fail, parseArgs, requireEnv } from "./agent.js";
import { createToolRegistry } from "./tool-registry.js";
import { runAgenticAgent, loopFlags } from "../core/run-agent.js";

const HELP = `
🛠  Code Agent — Claude-оор төслийн код үүсгэгч (agentic loop)

Хэрэглээ:
  node src/code-agent/index.js "<шаардлага>" [--name <төслийн-нэр>] [--max-iterations N] [--resume <sessionId>]

Жишээ:
  node src/code-agent/index.js "generate a React todo app with useState"
  node src/code-agent/index.js "create a Node.js Express server with 3 routes" --name my-api

Tools: code (Claude төслийн код → output/), file, write, think
Урсгал: plan → execute → reflect — зорилго биелтэл давтана.

Үр дүн: output/PROJECT_NAME/ — бүх эх файл + README.md
Шаардлага: .env дотор ANTHROPIC_API_KEY
Сонголтоор: FIREBASE_DATABASE_URL + FIREBASE_SERVICE_ACCOUNT_PATH (session тракинг)
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const { positional, flags } = parseArgs(argv, { booleans: ["git", "push"] });
const requirement = positional.join(" ").trim();

if (!requirement) {
  console.log(HELP);
  fail("Кодын шаардлагаа өгнө үү");
}

try {
  requireEnv("ANTHROPIC_API_KEY");
  const goal = typeof flags.name === "string" ? `${requirement} (project name: ${flags.name})` : requirement;
  await runAgenticAgent({
    agentType: "code-agent",
    label: "CODE AGENT",
    goal,
    toolRegistry: createToolRegistry(),
    ...loopFlags(flags),
  });
} catch (err) {
  handleError(err);
}
