/**
 * DB Agent — өгөгдлийн сангийн schema, migration, query-г Gemini-ээр
 * зохиолгож SQL / Prisma / TypeORM файлд хадгална.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import chalk from "chalk";
import { GoogleGenAI, ApiError } from "@google/genai";
import fse from "fs-extra";
import { toGeminiSchema } from "../core/gemini-schema.js";

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
    if (err.status === 400 && /API_KEY_INVALID/.test(err.message)) {
      fail("GEMINI_API_KEY буруу эсвэл хүчингүй байна — .env файлаа шалгана уу");
    } else if (err.status === 403) {
      fail("GEMINI_API_KEY-д хандах эрх байхгүй байна — .env файлаа шалгана уу");
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

export async function callGemini(systemPrompt, userMessage, { maxTokens = 16000, schema = null } = {}) {
  const config = {
    systemInstruction: systemPrompt,
    maxOutputTokens: maxTokens,
  };
  if (schema) {
    config.responseMimeType = "application/json";
    config.responseSchema = toGeminiSchema(schema);
  }

  const t0 = Date.now();
  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: userMessage,
    config,
  });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const usage = response.usageMetadata ?? {};
  log(`${chalk.cyan("Gemini")} ${MODEL} · ${sec}s · in ${usage.promptTokenCount ?? "?"} / out ${usage.candidatesTokenCount ?? "?"} tokens`);

  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
    throw new Error("Gemini хүсэлтийг аюулгүй байдлын үүднээс гүйцэтгэхээс татгалзлаа");
  }
  if (finishReason === "MAX_TOKENS") {
    log(chalk.yellow("⚠ Хариу max_tokens хязгаарт тулсан тул тасарсан байж болзошгүй"));
  }

  const text = response.text;
  if (!text) throw new Error("Gemini хариу буцаасангүй");
  return schema ? JSON.parse(text) : text;
}

/* ---------- main flow ---------- */
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

export async function processRequest(request, { format = "sql" } = {}) {
  requireEnv("GEMINI_API_KEY");
  const fmt = OUTPUT_FORMATS[format];
  if (!fmt) fail(`--format утга буруу: "${format}" (зөв: ${Object.keys(OUTPUT_FORMATS).join(" | ")})`);

  log(`🗄  Starting DB Agent — "${request}" (${format})`);

  // Step 1 — Gemini schema/query-г зохионо
  const result = await callGemini(buildSystem(fmt.label), request, { schema: DB_SCHEMA });
  logStep(1, `${format.toUpperCase()} код бэлэн боллоо`);

  // Step 2 — файлд хадгална
  await fse.ensureDir(OUTPUT_DIR);
  const file = path.join(OUTPUT_DIR, `schema_${timestamp()}${fmt.ext}`);
  await fse.writeFile(file, result.content.trimEnd() + "\n", "utf8");
  logStep(2, "Файлд хадгаллаа");
  if (result.notes) log(`📝 ${result.notes}`);

  logDone(`Done — ${path.relative(process.cwd(), file)}`);
  return file;
}
