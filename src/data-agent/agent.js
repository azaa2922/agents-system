/**
 * Data Agent — CSV/JSON өгөгдлийг уншиж, Claude-оор шинжилгээ хийлгээд
 * ASCII chart бүхий Markdown тайланг /output руу хадгална.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import chalk from "chalk";
import Anthropic from "@anthropic-ai/sdk";
import fse from "fs-extra";
import Papa from "papaparse";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
export const OUTPUT_DIR = path.join(ROOT, "output");

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const MODEL = "claude-opus-4-8";
const SAMPLE_ROWS = 100;

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
  log(`${chalk.cyan("Claude")} ${MODEL} · ${sec}s · in ${response.usage.input_tokens} / out ${response.usage.output_tokens} tokens`);

  if (response.stop_reason === "refusal") {
    throw new Error("Claude хүсэлтийг аюулгүй байдлын үүднээс гүйцэтгэхээс татгалзлаа");
  }
  if (response.stop_reason === "max_tokens") {
    log(chalk.yellow("⚠ Хариу max_tokens хязгаарт тулсан тул тасарсан байж болзошгүй"));
  }

  const textBlocks = response.content.filter((b) => b.type === "text");
  if (schema) return JSON.parse(textBlocks[0].text);
  return textBlocks.map((b) => b.text).join("\n");
}

/* ---------- main flow ---------- */
const SYSTEM = `You are a data-analysis agent. You receive a dataset profile, a sample of rows and an instruction.
Write a clear analysis report in Markdown that:
- answers the instruction directly,
- lists key findings as bullets with concrete numbers,
- includes at least one ASCII table and, where a trend or comparison exists, an ASCII bar chart inside a \`\`\` code block (use █ characters scaled to the values),
- notes data-quality caveats when relevant.
Base every number strictly on the provided profile/sample — if the sample is partial, say so.
Write the report in the same language as the instruction (Mongolian instruction → Mongolian report).`;

function loadData(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") {
    const parsed = Papa.parse(text.trim(), { header: true, dynamicTyping: true, skipEmptyLines: true });
    if (parsed.errors?.length) {
      log(chalk.yellow(`⚠ CSV parse анхааруулга: ${parsed.errors[0].message}`));
    }
    return parsed.data;
  }
  if (ext === ".json") {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  }
  throw new Error(`Дэмжигдээгүй өргөтгөл: ${ext || "(байхгүй)"} — .csv эсвэл .json ашиглана уу`);
}

function profileData(rows) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const numeric = {};
  for (const col of columns) {
    const values = rows
      .map((r) => r[col])
      .filter((v) => typeof v === "number" && Number.isFinite(v));
    if (values.length === 0 || values.length < rows.length / 2) continue;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    numeric[col] = {
      count: values.length,
      min,
      max,
      mean: +(sum / values.length).toFixed(4),
      sum: +sum.toFixed(4),
    };
  }
  return { rows: rows.length, columns, numeric };
}

export async function processRequest(instruction, filePath) {
  requireEnv("ANTHROPIC_API_KEY");
  log(`📊 Starting Data Agent — "${instruction}"`);

  // Step 1 — өгөгдлийг унших, профайл гаргах
  const full = path.resolve(process.cwd(), filePath);
  const text = await fse.readFile(full, "utf8");
  if (!text.trim()) fail(`${filePath} файл хоосон байна`);
  const rows = loadData(full, text);
  if (rows.length === 0) fail("Өгөгдлийн мөр олдсонгүй");
  const profile = profileData(rows);
  logStep(1, `Уншлаа: ${filePath} — ${profile.rows} мөр, ${profile.columns.length} багана (${profile.columns.join(", ")})`);

  // Step 2 — Claude-д өгөх дээж бэлтгэх
  const sample = rows.slice(0, SAMPLE_ROWS);
  const sampled = rows.length > SAMPLE_ROWS;
  if (sampled) {
    log(chalk.yellow(`⚠ Том өгөгдөл: эхний ${SAMPLE_ROWS} мөрийг дээж болгож, бүрэн профайлын хамт илгээнэ`));
  }
  logStep(2, `Дээж бэлэн — ${sample.length} мөр + тоон баганын статистик`);

  // Step 3 — Claude шинжилгээ хийнэ
  const userMsg = [
    `Instruction: ${instruction}`,
    `Dataset file: ${path.basename(full)}`,
    `Profile (computed over ALL ${profile.rows} rows):`,
    JSON.stringify(profile, null, 2),
    sampled
      ? `Sample (first ${SAMPLE_ROWS} of ${rows.length} rows):`
      : `All rows (${rows.length}):`,
    JSON.stringify(sample, null, 2),
  ].join("\n\n");
  const report = await callClaude(SYSTEM, userMsg);
  logStep(3, "Claude шинжилгээ, ASCII chart бүхий тайлан бичлээ");

  // Step 4 — тайланг хадгалах
  await fse.ensureDir(OUTPUT_DIR);
  const file = path.join(OUTPUT_DIR, `analysis_${timestamp()}.md`);
  const doc = [
    "# Data Analysis Report",
    "",
    `- **Хүсэлт:** ${instruction}`,
    `- **Файл:** ${path.basename(full)}`,
    `- **Огноо:** ${new Date().toISOString()}`,
    `- **Хэмжээ:** ${profile.rows} мөр × ${profile.columns.length} багана${sampled ? ` (Claude-д эхний ${SAMPLE_ROWS} мөрийн дээж + бүрэн статистик өгсөн)` : ""}`,
    "",
    report,
    "",
  ].join("\n");
  await fse.writeFile(file, doc, "utf8");
  logStep(4, "Тайланг файлд хадгаллаа");

  logDone(`Done — ${path.relative(process.cwd(), file)}`);
  return file;
}
