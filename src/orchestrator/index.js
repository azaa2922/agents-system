#!/usr/bin/env node
/**
 * Orchestrator CLI — coordinates all 6 specialist agents via one big goal.
 *   node src/orchestrator/index.js "research React frameworks, then scaffold a starter app and write a launch blog post"
 *
 * Урсгал (plan → delegate → reflect, зорилго биелтэл давтана):
 *   1. Orchestrator том зорилгыг задалж, аль агентад юу шилжүүлэхээ төлөвлөнө
 *   2. Сонгосон агент бүр өөрийн agentic loop-оор ажиллана (child session)
 *   3. Үр дүнг эргэцүүлж, дараагийн агентыг сонгоно — зорилго биелтэл давтана
 *   4. Parent + child session бүр Firebase RTDB-д хадгалагдана (тохируулсан үед)
 */
import { runAgenticAgent } from "../core/run-agent.js";
import { createOrchestratorRegistry, AGENTS } from "../core/orchestrator.js";
import * as memory from "../core/memory.js";

const ALL = Object.keys(AGENTS);

const HELP = `
🧭 Orchestrator — 6 агентыг зохицуулагч (agentic loop)

Хэрэглээ:
  node src/orchestrator/index.js "<том зорилго>" [--agents a,b,c] [--max-iterations N] [--sub-iterations N] [--resume <sessionId>]

Жишээ:
  node src/orchestrator/index.js "research the top React frameworks, scaffold a starter app, and write a launch blog post"
  node src/orchestrator/index.js "analyze sales.csv and design a database schema for the findings" --agents data,db

Зохицуулах агентууд (${ALL.length}):
${ALL.map((n) => `  • ${n.padEnd(7)} ${AGENTS[n].description.split(".")[0]}.`).join("\n")}

Сонголтууд:
  --agents a,b,c       Зөвхөн эдгээр агентыг ашиглах (default: бүгд)
  --max-iterations N   Orchestrator-ийн давталтын дээд хязгаар (default: 15)
  --sub-iterations N   Агент тус бүрийн дэд давталтын хязгаар (default: 10)
  --resume <id>        Тасалдсан orchestrator session-ийг үргэлжлүүлэх

Шаардлага: .env дотор GEMINI_API_KEY (search агентад нэмж TAVILY_API_KEY)
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

const agentsFlag = takeOption("--agents");
const maxIterationsFlag = takeOption("--max-iterations");
const subIterationsFlag = takeOption("--sub-iterations");
const resumeId = takeOption("--resume") ?? null;

const goal = argv.filter((a) => !a.startsWith("-")).join(" ").trim();
if (!goal) {
  console.log(HELP);
  console.error("✗ Зохицуулах том зорилгоо өгнө үү");
  process.exit(1);
}

// Resolve the agent subset (usage validation first, before env checks).
let agents = ALL;
if (agentsFlag) {
  agents = agentsFlag.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = agents.filter((a) => !ALL.includes(a));
  if (unknown.length) {
    console.error(`✗ Үл мэдэгдэх агент: ${unknown.join(", ")} (боломжит: ${ALL.join(", ")})`);
    process.exit(1);
  }
}

if (!process.env.GEMINI_API_KEY) {
  console.error('✗ GEMINI_API_KEY тохируулаагүй байна — "cp .env.example .env" хийгээд түлхүүрээ оруулна уу');
  process.exit(1);
}
if (agents.includes("search") && !process.env.TAVILY_API_KEY) {
  console.warn("⚠ TAVILY_API_KEY тохируулаагүй тул 'search' агент хайлт хийх үедээ алдаа өгч болзошгүй.");
}

const maxIterations = maxIterationsFlag ? Number(maxIterationsFlag) : 15;
const maxSubIterations = subIterationsFlag ? Number(subIterationsFlag) : 10;
const toolDescriptions = Object.fromEntries(agents.map((n) => [n, AGENTS[n].description]));

try {
  await runAgenticAgent({
    agentType: "orchestrator",
    label: "ORCHESTRATOR",
    goal,
    // Factory: child sessions link to the orchestrator's parent session id.
    toolRegistryFactory: (parentSessionId) =>
      createOrchestratorRegistry({
        memory,
        apiKey: process.env.GEMINI_API_KEY,
        parentSessionId,
        agents,
        maxSubIterations,
      }),
    toolDescriptions,
    maxIterations,
    resumeId,
  });
} catch (err) {
  console.error(`\n✗ Orchestrator алдаа: ${err?.message || err}`);
  process.exit(1);
}
