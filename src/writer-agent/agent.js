/**
 * Writer Agent — блог, имэйл, сошиал пост, баримтжуулалт зэрэг контентыг
 * Gemini-ээр бичүүлж, YAML frontmatter-тай Markdown болгож хадгална.
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

export const TONES = ["casual", "professional", "humorous"];
export const LENGTHS = { short: "about 200 words", medium: "about 500 words", long: "at least 1000 words" };
export const FORMATS = ["blog", "email", "social", "docs"];

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
const WRITE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short title for the piece" },
    content: { type: "string", description: "The full content in Markdown, WITHOUT YAML frontmatter" },
  },
  required: ["title", "content"],
  additionalProperties: false,
};

const buildSystem = (tone, length, format) => `You are a professional content writer.
Write a "${format}" piece with a ${tone} tone, ${LENGTHS[length]} long.
Formats: blog = blog post with headings; email = ready-to-send email (subject as title);
social = social-media post(s); docs = technical documentation.
Match the language of the user's request (Mongolian request → Mongolian content).
Return polished, publication-ready Markdown in "content" — no YAML frontmatter, it is added separately.`;

export async function processRequest(brief, { tone = "professional", length = "medium", format = "blog" } = {}) {
  requireEnv("GEMINI_API_KEY");
  if (!TONES.includes(tone)) fail(`--tone утга буруу: "${tone}" (зөв: ${TONES.join(" | ")})`);
  if (!LENGTHS[length]) fail(`--length утга буруу: "${length}" (зөв: ${Object.keys(LENGTHS).join(" | ")})`);
  if (!FORMATS.includes(format)) fail(`--format утга буруу: "${format}" (зөв: ${FORMATS.join(" | ")})`);

  log(`✍️  Starting Writer Agent — "${brief}" (${format} / ${tone} / ${length})`);

  // Step 1 — Gemini контентыг бичнэ
  const result = await callGemini(buildSystem(tone, length, format), brief, { schema: WRITE_SCHEMA });
  logStep(1, `"${result.title}" бэлэн боллоо (${result.content.split(/\s+/).length} орчим үг)`);

  // Step 2 — frontmatter-тэй markdown болгож хадгална
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(result.title)}`,
    `date: ${new Date().toISOString()}`,
    `format: ${format}`,
    `tone: ${tone}`,
    `length: ${length}`,
    "---",
    "",
  ].join("\n");

  await fse.ensureDir(OUTPUT_DIR);
  const file = path.join(OUTPUT_DIR, `content_${timestamp()}.md`);
  await fse.writeFile(file, frontmatter + result.content + "\n", "utf8");
  logStep(2, "Frontmatter-тэй Markdown файлд хадгаллаа");

  logDone(`Done — ${path.relative(process.cwd(), file)}`);
  return file;
}
