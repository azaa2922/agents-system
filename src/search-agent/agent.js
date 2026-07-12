/**
 * Search Agent — Gemini төлөвлөж, Tavily API-аар вэб хайлт хийж,
 * үр дүнг нэгтгэн дүгнээд /output руу хадгална.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import chalk from "chalk";
import axios from "axios";
import { GoogleGenAI, ApiError } from "@google/genai";
import fse from "fs-extra";
import { toGeminiSchema } from "../core/gemini-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
export const OUTPUT_DIR = path.join(ROOT, "output");

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

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

/* ---------- Tavily ---------- */
export async function tavilySearch(query, maxResults = 5) {
  try {
    const res = await axios.post(
      "https://api.tavily.com/search",
      { query, max_results: maxResults, search_depth: "basic" },
      {
        headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
        timeout: 30_000,
      },
    );
    return res.data.results ?? [];
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      if (status === 401 || status === 403) fail("TAVILY_API_KEY буруу байна — .env файлаа шалгана уу");
      fail(`Tavily хайлт амжилтгүй (${status ?? err.code}): ${err.message}`);
    }
    throw err;
  }
}

/* ---------- main flow ---------- */
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    strategy: { type: "string", description: "One-sentence search strategy" },
    queries: {
      type: "array",
      description: "1 to 4 focused web-search queries",
      items: { type: "string" },
    },
  },
  required: ["strategy", "queries"],
  additionalProperties: false,
};

const PLANNER_SYSTEM = `You are the planning module of a web-search agent.
Given a user's request, decide what to search for and how many queries are needed (1-4).
Queries must be focused, non-overlapping and in the language most likely to return good results (usually English).`;

const SUMMARY_SYSTEM = `You are the analysis module of a web-search agent.
You receive a user's request and raw web-search results.
Write a well-structured Markdown summary that directly answers the request:
- key findings as bullet points,
- cite source URLs inline,
- note conflicting or missing information honestly.
Answer in the same language as the user's request (Mongolian request → Mongolian summary).`;

export async function processRequest(userInput) {
  requireEnv("GEMINI_API_KEY", "TAVILY_API_KEY");
  log(`🔎 Starting Search Agent — "${userInput}"`);

  // Step 1 — Gemini хайлтын стратеги төлөвлөнө
  const plan = await callGemini(PLANNER_SYSTEM, userInput, { schema: PLAN_SCHEMA, maxTokens: 4000 });
  const queries = plan.queries.slice(0, 4);
  if (queries.length === 0) fail("Gemini хайлтын query гаргаж чадсангүй");
  logStep(1, `Төлөвлөгөө: ${plan.strategy} (${queries.length} query)`);

  // Step 2 — Tavily хайлтууд
  const allResults = [];
  for (const [i, query] of queries.entries()) {
    const t0 = Date.now();
    const results = await tavilySearch(query);
    const ms = Date.now() - t0;
    allResults.push({ query, results });
    logStep(2, `(${i + 1}/${queries.length}) "${query}" → ${results.length} үр дүн · ${ms}ms`);
  }

  // Step 3 — Gemini үр дүнг нэгтгэж дүгнэнэ
  const resultsText = allResults
    .map(
      ({ query, results }) =>
        `### Query: ${query}\n\n` +
        (results.length
          ? results
              .map((r, j) => `${j + 1}. **${r.title}**\n   - URL: ${r.url}\n   - ${(r.content ?? "").slice(0, 800)}`)
              .join("\n")
          : "_үр дүн олдсонгүй_"),
    )
    .join("\n\n");

  const summary = await callGemini(
    SUMMARY_SYSTEM,
    `Хэрэглэгчийн хүсэлт: ${userInput}\n\nХайлтын түүхий үр дүн:\n\n${resultsText}`,
  );
  logStep(3, "Gemini үр дүнг нэгтгэж дүгнэлт гаргалаа");

  // Step 4 — файлд хадгална
  await fse.ensureDir(OUTPUT_DIR);
  const file = path.join(OUTPUT_DIR, `search_${timestamp()}.md`);
  const doc = [
    "# Web Search Report",
    "",
    `- **Хүсэлт:** ${userInput}`,
    `- **Огноо:** ${new Date().toISOString()}`,
    `- **Стратеги:** ${plan.strategy}`,
    "",
    "## Дүгнэлт",
    "",
    summary,
    "",
    "## Түүхий үр дүн",
    "",
    resultsText,
    "",
  ].join("\n");
  await fse.writeFile(file, doc, "utf8");
  logStep(4, "Тайланг файлд хадгаллаа");

  logDone(`Done — ${path.relative(process.cwd(), file)}`);
  return file;
}
