/**
 * DB Agent — өгөгдлийн сангийн schema, migration, query-г Gemini-ээр
 * зохиолгож SQL / Prisma / TypeORM файлд хадгална.
 *
 * Санах ой: generate → save алхмуудаар явж, алхам бүр Firebase-д бүртгэгдэнэ.
 * Firebase тохируулаагүй бол санах ойгүйгээр адил ажиллана.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import chalk from "chalk";
import { GoogleGenAI, Type, ApiError } from "@google/genai";
import fse from "fs-extra";
import { runAgent } from "../core/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
export const OUTPUT_DIR = path.join(ROOT, "output");

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

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
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403 || (err.status === 400 && /api key/i.test(err.message))) {
      fail("GEMINI_API_KEY буруу эсвэл хүчингүй байна — .env файлаа шалгана уу");
    } else if (err.status === 429) {
      fail("Gemini API rate limit — түр хүлээгээд дахин оролдоно уу");
    } else {
      fail(`Gemini API алдаа (${err.status}): ${err.message}`);
    }
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

/* ---------- Gemini ---------- */
let client;
const getClient = () => (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

export async function callGemini(systemPrompt, userMessage, { schema = null } = {}) {
  const config = { systemInstruction: systemPrompt };
  if (schema) {
    config.responseMimeType = "application/json";
    config.responseSchema = schema;
  }

  const t0 = Date.now();
  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: userMessage,
    config,
  });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const usage = response.usageMetadata ?? {};
  const tokens = usage.totalTokenCount ?? 0;
  const thinking = usage.thoughtsTokenCount ? ` / thinking ${usage.thoughtsTokenCount}` : "";
  log(`${chalk.cyan("Gemini")} ${MODEL} · ${sec}s · in ${usage.promptTokenCount ?? 0} / out ${usage.candidatesTokenCount ?? 0}${thinking} tokens`);

  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    throw new Error(`Gemini хүсэлтийг блоклолоо (${blocked})`);
  }
  const finish = response.candidates?.[0]?.finishReason;
  if (["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"].includes(finish)) {
    throw new Error(`Gemini хариултыг аюулгүй байдлын үүднээс зогсоолоо (${finish})`);
  }
  if (finish === "MAX_TOKENS") {
    log(chalk.yellow("⚠ Хариу токены хязгаарт тулсан тул тасарсан байж болзошгүй"));
  }

  const text = response.text;
  if (!text) throw new Error(`Gemini хоосон хариу буцаалаа (finishReason: ${finish ?? "?"})`);
  const result = schema ? JSON.parse(text) : text;
  return { result, tokens };
}

/* ---------- prompts / schema ---------- */
const DB_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    content: {
      type: Type.STRING,
      description: "Full content of the schema/migration/query file — code only, no markdown fences",
    },
    notes: {
      type: Type.STRING,
      description: "Short design notes in Mongolian (indexes, constraints, assumptions)",
    },
  },
  required: ["content", "notes"],
  propertyOrdering: ["content", "notes"],
};

const buildSystem = (label) => `You are a database design agent.
Generate ${label} for the user's request (table design, migration, or query — whatever the request asks for).
Rules:
- Output must be complete and immediately usable: proper data types, primary/foreign keys, sensible indexes, constraints and timestamps.
- Add brief inline comments where they aid understanding.
- "content" must contain ONLY the code — no markdown fences, no prose around it.`;

/* ---------- main flow ---------- */
export async function processRequest(request, { format = "sql", resume = null } = {}) {
  requireEnv("GEMINI_API_KEY");
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
        description: `Gemini generates ${format.toUpperCase()}`,
        run: async () => {
          const { result, tokens } = await callGemini(buildSystem(fmt.label), request, { schema: DB_SCHEMA });
          generated = result;
          logStep(1, `${format.toUpperCase()} код бэлэн боллоо`);
          if (result.notes) log(`📝 ${result.notes}`);
          return {
            result: `${format} schema бэлэн`,
            tokens,
            context: {
              accumulated_knowledge: result.notes || `${format} generated`,
              last_gemini_response: (result.notes || "").slice(0, 300),
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
