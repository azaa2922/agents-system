#!/usr/bin/env node
/**
 * Code Agent CLI
 *   node src/code-agent/index.js "generate React todo app with useState"
 */
import { processRequest, handleError, fail, parseArgs } from "./agent.js";

const HELP = `
🛠  Code Agent — Claude-оор төслийн код үүсгэгч

Хэрэглээ:
  node src/code-agent/index.js "<шаардлага>" [--name <төслийн-нэр>] [--git] [--push]

Жишээ:
  node src/code-agent/index.js "generate a React todo app with useState"
  node src/code-agent/index.js "create a Node.js Express server with 3 routes" --name my-api
  node src/code-agent/index.js "generate HTML/CSS landing page" --git

Сонголтууд:
  --name <нэр>   Төслийн хавтасны нэрийг гараар өгөх
  --git          Үүсгэсэн төсөл дотор git init + commit хийх
  --push         Дээрх + GIT_REMOTE_URL (.env) руу push хийх

Үр дүн: output/PROJECT_NAME/ — бүх эх файл + README.md

Шаардлага: .env дотор ANTHROPIC_API_KEY (push-д GIT_REMOTE_URL)
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
  await processRequest(requirement, {
    name: typeof flags.name === "string" ? flags.name : undefined,
    useGit: Boolean(flags.git),
    push: Boolean(flags.push),
  });
} catch (err) {
  handleError(err);
}
