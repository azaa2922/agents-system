/**
 * File Agent — файлуудыг уншиж, Gemini-ээр хувиргаад (CSV↔JSON, markdown
 * heading задлах, JSON нэгтгэх г.м.) үр дүнг /output руу хадгална.
 *
 * Санах ой: load → transform → save алхмуудаар явж, алхам бүр Firebase-д
 * бүртгэгдэнэ. Firebase тохируулаагүй бол санах ойгүйгээр адил ажиллана.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import chalk from "chalk";
import { GoogleGenAI, Type, ApiError } from "@google/genai";
import fse from "fs-extra";
import { parse as parseCsv } from "csv-parse/sync";
import { runAgent } from "../core/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
export const OUTPUT_DIR = path.join(ROOT, "output");

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_INPUT_CHARS = 200_000;

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
const TRANSFORM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    output_filename: {
      type: Type.STRING,
      description: "Suggested output file name with the correct extension, e.g. data.json",
    },
    output_content: {
      type: Type.STRING,
      description: "The COMPLETE content of the transformed output file",
    },
    explanation: {
      type: Type.STRING,
      description: "1-2 sentence summary in Mongolian of what was done",
    },
  },
  required: ["output_filename", "output_content", "explanation"],
  propertyOrdering: ["output_filename", "output_content", "explanation"],
};

const SYSTEM = `You are a file-processing agent. You receive one or more input files (CSV, JSON, TXT or Markdown) and an instruction.
Decide the transformation steps yourself, apply them precisely, and return the complete transformed result.
Rules:
- output_content must contain the ENTIRE output file and be valid in its format (e.g. valid JSON for .json, valid CSV for .csv).
- Choose a sensible output_filename with the correct extension for the result format.
- Never invent data that is not derivable from the input files.
- Preserve all rows/entries unless the instruction says to filter.`;

function describeFile(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") {
    const records = parseCsv(text, { columns: true, skip_empty_lines: true, relax_column_count: true });
    const cols = records.length ? Object.keys(records[0]) : [];
    return `CSV · ${records.length} мөр · баганууд: ${cols.join(", ") || "—"}`;
  }
  if (ext === ".json") {
    JSON.parse(text);
    return "JSON (хүчинтэй)";
  }
  if (ext === ".md" || ext === ".markdown") return "Markdown";
  return "Текст";
}

/* ---------- main flow ---------- */
export async function processRequest(instruction, files, { resume = null } = {}) {
  requireEnv("GEMINI_API_KEY");
  log(`📂 Starting File Agent — "${instruction}"`);

  let outPath = null;
  const loaded = [];
  let transformed = null;

  await runAgent({
    agentType: "file-agent",
    goal: `${instruction} [${files.join(", ")}]`,
    log,
    resume,
    buildSteps: async () => [
      {
        action: "load",
        description: `Read ${files.length} file(s)`,
        run: async () => {
          for (const f of files) {
            const full = path.resolve(process.cwd(), f);
            const text = await fse.readFile(full, "utf8");
            if (!text.trim()) fail(`${f} файл хоосон байна`);
            let info;
            try {
              info = describeFile(full, text);
            } catch (e) {
              fail(`${f} файлыг задлахад алдаа гарлаа: ${e.message}`);
            }
            loaded.push({ name: path.basename(full), text, info });
            logStep(1, `Уншлаа: ${f} (${info})`);
          }
          const totalChars = loaded.reduce((s, f) => s + f.text.length, 0);
          if (totalChars > MAX_INPUT_CHARS) {
            fail(`Оролтын файлууд хэт том байна (${totalChars} тэмдэгт > ${MAX_INPUT_CHARS}). Файлаа хувааж өгнө үү.`);
          }
          return {
            result: `${loaded.length} файл, ${totalChars} тэмдэгт`,
            context: { decisions_made: [`Loaded ${loaded.length} file(s): ${loaded.map((l) => l.name).join(", ")}`] },
          };
        },
      },
      {
        action: "transform",
        description: "Gemini decides & applies the transformation",
        run: async () => {
          const userMsg = [
            `Instruction: ${instruction}`,
            ...loaded.map((f, i) => `--- FILE ${i + 1}: ${f.name} (${f.info}) ---\n${f.text}`),
          ].join("\n\n");
          const { result, tokens } = await callGemini(SYSTEM, userMsg, { schema: TRANSFORM_SCHEMA });
          transformed = result;
          logStep(2, `Хувиргалт дууслаа — ${result.explanation}`);
          return {
            result: result.explanation,
            tokens,
            context: {
              accumulated_knowledge: result.explanation,
              last_gemini_response: `→ ${result.output_filename}`,
            },
          };
        },
      },
      {
        action: "save",
        description: "Write transformed file to /output",
        run: async (ctx) => {
          await fse.ensureDir(OUTPUT_DIR);
          const safe = path.basename(transformed.output_filename).replace(/[^\w.\-]/g, "_");
          const ext = path.extname(safe);
          const base = safe.slice(0, safe.length - ext.length) || "output";
          const out = path.join(OUTPUT_DIR, `${base}_${timestamp()}${ext || ".txt"}`);
          await fse.writeFile(out, transformed.output_content, "utf8");
          outPath = out;
          const rel = path.relative(process.cwd(), out);
          ctx.summary = `${transformed.explanation} → ${path.basename(out)}`;
          logStep(3, "Үр дүнг файлд хадгаллаа");
          return { result: rel, context: { files_created: [rel] } };
        },
      },
    ],
  });

  logDone(`Done — ${outPath ? path.relative(process.cwd(), outPath) : "(файл үүсээгүй)"}`);
  return outPath;
}
