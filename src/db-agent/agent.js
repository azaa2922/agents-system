/**
 * DB Agent — өгөгдлийн сангийн schema, migration, query-г Claude-оор
 * зохиолгож SQL / Prisma / TypeORM файлд хадгална.
 *
 * Санах ой: generate → save алхмуудаар явж, алхам бүр Firebase-д бүртгэгдэнэ.
 * Firebase тохируулаагүй бол санах ойгүйгээр адил ажиллана.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import chalk from "chalk";
import Anthropic from "@anthropic-ai/sdk";
import fse from "fs-extra";
import { runAgent } from "../core/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
export const OUTPUT_DIR = path.join(ROOT, "output");

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const MODEL = "claude-opus-4-8";

export const OUTPUT_FORMATS = {
  sql: { ext: ".sql", label: "raw SQL (PostgreSQL dialect unless the request says otherwise)" },
  prisma: { ext: ".prisma", label: "a Prisma schema (schema.prisma contents)" },
  typeorm: { ext: ".ts", label: "TypeORM entity classes in TypeScript" },
};

/* ---------- logging helpers ---------- */
const clock = () => new Date().toTimeString().slice(0, 8);
export const log = (msg) => console.log(`${chalk.gray(`[${clock()}]`)} ${msg}`);
export const logStep = (n, msg) => log(`${chalk.green("✓")} Step ${n} — ${msg}`);
export const logDone = (msg) => log(`✅ ${chalk.green(msg)}`);

export function fail(msg) {
  console.error(`${chalk.gray(`[${clock()}]`)} ${chalk.red(`✗ ${msg}`)}`);
  process.exit(1);
}

export function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

export function requireEnv(...names) {
  for (const name of names) {
    if (!process.env[name]) {
      fail(`${name} тохируулагдаагүй байна — "cp .env.example .env" хийгээд түлхүүрээ оруулна уу`);
    }
  }
}

export function handleError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    fail("ANTHROPIC_API_KEY буруу эсвэл хүчингүй байна — .env файлаа шалгана уу");
  } else if (err instanceof Anthropic.RateLimitError) {
    fail("Claude API rate limit — түр хүлээгээд дахин оролдоно уу");
  } else if (err instanceof Anthropic.APIError) {
    fail(`Claude API алдаа (${err.status}): ${err.message}`);
  } else if (err?.code === "ENOENT") {
    fail(`Файл олдсонгүй: ${err.path}`);
  } else {
    fail(err?.message || String(err));
  }
}

export function parseArgs(argv, { booleans = [], multi = [] } = {}) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (booleans.includes(name) || next === undefined || next.startsWith("--")) {
        flags[name] = true;
        continue;
      }
      i++;
      if (multi.includes(name)) (flags[name] ??= []).push(next);
      else flags[name] = next;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/* ---------- Claude ---------- */
let client;
const getClient = () => (client ??= new Anthropic());

export async function callClaude(systemPrompt, userMessage, { maxTokens = 16000, schema = null } = {}) {
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  if (schema) {
    params.output_config = { format: { type: "json_schema", schema } };
  }

  const t0 = Date.now();
  const response = await getClient().messages.create(params);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const tokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
  log(`${chalk.cyan("Claude")} ${MODEL} · ${sec}s · in ${response.usage.input_tokens} / out ${response.usage.output_tokens} tokens`);

  if (response.stop_reason === "refusal") {
    throw new Error("Claude хүсэлтийг аюулгүй байдлын үүднээс гүйцэтгэхээс татгалзлаа");
  }
  if (response.stop_reason === "max_tokens") {
    log(chalk.yellow("⚠ Хариу max_tokens хязгаарт тулсан тул тасарсан байж болзошгүй"));
  }

  const textBlocks = response.content.filter((b) => b.type === "text");
  const result = schema ? JSON.parse(textBlocks[0].text) : textBlocks.map((b) => b.text).join("\n");
  return { result, tokens };
}

/* ---------- prompts / schema ---------- */
const DB_SCHEMA = {
  type: "object",
  properties: {
    content: {
      type: "string",
      description: "Full content of the schema/migration/query file — code only, no markdown fences",
    },
    notes: {
      type: "string",
      description: "Short design notes in Mongolian (indexes, constraints, assumptions)",
    },
  },
  required: ["content", "notes"],
  additionalProperties: false,
};

const buildSystem = (label) => `You are a database design agent.
Generate ${label} for the user's request (table design, migration, or query — whatever the request asks for).
Rules:
- Output must be complete and immediately usable: proper data types, primary/foreign keys, sensible indexes, constraints and timestamps.
- Add brief inline comments where they aid understanding.
- "content" must contain ONLY the code — no markdown fences, no prose around it.`;

/* ---------- main flow ---------- */
export async function processRequest(request, { format = "sql", resume = null } = {}) {
  requireEnv("ANTHROPIC_API_KEY");
  const fmt = OUTPUT_FORMATS[format];
  if (!fmt) fail(`--format утга буруу: "${format}" (зөв: ${Object.keys(OUTPUT_FORMATS).join(" | ")})`);

  log(`🗄  Starting DB Agent — "${request}" (${format})`);

  let outPath = null;
  let generated = null;

  await runAgent({
    agentType: "db-agent",
    goal: `${request} [${format}]`,
    log,
    resume,
    buildSteps: async () => [
      {
        action: "generate",
        description: `Claude generates ${format.toUpperCase()}`,
        run: async () => {
          const { result, tokens } = await callClaude(buildSystem(fmt.label), request, { schema: DB_SCHEMA });
          generated = result;
          logStep(1, `${format.toUpperCase()} код бэлэн боллоо`);
          if (result.notes) log(`📝 ${result.notes}`);
          return {
            result: `${format} schema бэлэн`,
            tokens,
            context: {
              accumulated_knowledge: result.notes || `${format} generated`,
              last_claude_response: (result.notes || "").slice(0, 300),
              decisions_made: [`Output format: ${format}`],
            },
          };
        },
      },
      {
        action: "save",
        description: "Save schema file to /output",
        run: async (ctx) => {
          await fse.ensureDir(OUTPUT_DIR);
          const file = path.join(OUTPUT_DIR, `schema_${timestamp()}${fmt.ext}`);
          const rel = path.relative(process.cwd(), file);
          await fse.writeFile(file, generated.content.trimEnd() + "\n", "utf8");
          outPath = file;
          ctx.summary = `"${request}" — ${format} → ${path.basename(file)}`;
          logStep(2, "Файлд хадгаллаа");
          return { result: rel, context: { files_created: [rel] } };
        },
      },
    ],
  });

  logDone(`Done — ${outPath ? path.relative(process.cwd(), outPath) : "(файл үүсээгүй)"}`);
  return outPath;
}
