#!/usr/bin/env node
/**
 * Writer Agent CLI — autonomous agentic loop
 *   node src/writer-agent/index.js "write a blog post about AI" --tone professional --length medium
 */
import { handleError, fail, parseArgs, requireEnv, TONES, LENGTHS, FORMATS } from "./agent.js";
import { createToolRegistry } from "./tool-registry.js";
import { runAgenticAgent, loopFlags } from "../core/run-agent.js";

const HELP = `
✍️  Writer Agent — Claude-оор контент бичигч (agentic loop)

Хэрэглээ:
  node src/writer-agent/index.js "<сэдэв/заавар>" [--tone ...] [--length ...] [--format ...] [--max-iterations N] [--resume <sessionId>]

Жишээ:
  node src/writer-agent/index.js "write a 500-word blog post about AI" --tone professional
  node src/writer-agent/index.js "write 5 social media posts about Web3" --format social --tone casual

Сонголтууд:
  --tone    ${TONES.join(" | ")}  (default: professional)
  --length  ${Object.keys(LENGTHS).join(" | ")}  (default: medium)
  --format  ${FORMATS.join(" | ")}  (default: blog)

Tools: write (Claude контент → output/), file, think

Үр дүн: output/content_YYYYMMDDHHmm.md — YAML frontmatter-тэй
Шаардлага: .env дотор ANTHROPIC_API_KEY
Сонголтоор: FIREBASE_DATABASE_URL + FIREBASE_SERVICE_ACCOUNT_PATH (session тракинг)
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const { positional, flags } = parseArgs(argv);
const brief = positional.join(" ").trim();

if (!brief) {
  console.log(HELP);
  fail("Бичих сэдвээ өгнө үү");
}

try {
  requireEnv("ANTHROPIC_API_KEY");
  await runAgenticAgent({
    agentType: "writer-agent",
    label: "WRITER AGENT",
    goal: brief,
    toolRegistry: createToolRegistry({
      tone: typeof flags.tone === "string" ? flags.tone : undefined,
      length: typeof flags.length === "string" ? flags.length : undefined,
      format: typeof flags.format === "string" ? flags.format : undefined,
    }),
    ...loopFlags(flags),
  });
} catch (err) {
  handleError(err);
}
