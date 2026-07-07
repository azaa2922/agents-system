#!/usr/bin/env node
/**
 * Writer Agent CLI
 *   node src/writer-agent/index.js "write a blog post about AI" --tone professional --length medium
 */
import { processRequest, handleError, fail, parseArgs, TONES, LENGTHS, FORMATS } from "./agent.js";

const HELP = `
✍️  Writer Agent — Gemini-ээр контент бичигч

Хэрэглээ:
  node src/writer-agent/index.js "<сэдэв/заавар>" [--tone ...] [--length ...] [--format ...]

Жишээ:
  node src/writer-agent/index.js "write a 500-word blog post about AI" --tone professional
  node src/writer-agent/index.js "write a technical tutorial on Node.js streams" --format docs --length long
  node src/writer-agent/index.js "write 5 social media posts about Web3" --format social --tone casual

Сонголтууд:
  --tone    ${TONES.join(" | ")}  (default: professional)
  --length  ${Object.keys(LENGTHS).join(" | ")}  (short ≈200, medium ≈500, long 1000+ үг; default: medium)
  --format  ${FORMATS.join(" | ")}  (default: blog)
  --resume <sessionId>   Тасарсан session-ийг үргэлжлүүлэх (crash recovery)

Үр дүн: output/content_YYYYMMDDHHmm.md — YAML frontmatter (title, date, format, tone, length)

Шаардлага: .env дотор GEMINI_API_KEY
           (санах ойд нэмэлтээр FIREBASE_DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_PATH)
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
  await processRequest(brief, {
    tone: typeof flags.tone === "string" ? flags.tone : undefined,
    length: typeof flags.length === "string" ? flags.length : undefined,
    format: typeof flags.format === "string" ? flags.format : undefined,
    resume: typeof flags.resume === "string" ? flags.resume : null,
  });
} catch (err) {
  handleError(err);
}
