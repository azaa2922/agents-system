/**
 * Writer Agent — блог, имэйл, сошиал пост, баримтжуулалт зэрэг контентыг
 * Claude-оор бичүүлж, YAML frontmatter-тай Markdown болгож хадгална.
 *
 * Санах ой: write → save алхмуудаар явж, алхам бүр Firebase-д бүртгэгдэнэ.
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

/* ---------- main flow ---------- */
export async function processRequest(brief, { tone = "professional", length = "medium", format = "blog", resume = null } = {}) {
  requireEnv("ANTHROPIC_API_KEY");
  if (!TONES.includes(tone)) fail(`--tone утга буруу: "${tone}" (зөв: ${TONES.join(" | ")})`);
  if (!LENGTHS[length]) fail(`--length утга буруу: "${length}" (зөв: ${Object.keys(LENGTHS).join(" | ")})`);
  if (!FORMATS.includes(format)) fail(`--format утга буруу: "${format}" (зөв: ${FORMATS.join(" | ")})`);

  log(`✍️  Starting Writer Agent — "${brief}" (${format} / ${tone} / ${length})`);

  let outPath = null;
  let piece = null;

  await runAgent({
    agentType: "writer-agent",
    goal: `${brief} (${format}/${tone}/${length})`,
    log,
    resume,
    buildSteps: async () => [
      {
        action: "write",
        description: `Claude writes the ${format} piece`,
        run: async () => {
          const { result, tokens } = await callClaude(buildSystem(tone, length, format), brief, { schema: WRITE_SCHEMA });
          piece = result;
          logStep(1, `"${result.title}" бэлэн боллоо (${result.content.split(/\s+/).length} орчим үг)`);
          return {
            result: result.title,
            tokens,
            context: {
              accumulated_knowledge: `Wrote "${result.title}" (${format}/${tone}/${length})`,
              last_claude_response: result.title,
              decisions_made: [`Format=${format}, tone=${tone}, length=${length}`],
            },
          };
        },
      },
      {
        action: "save",
        description: "Save Markdown with YAML frontmatter",
        run: async (ctx) => {
          const frontmatter = [
            "---",
            `title: ${JSON.stringify(piece.title)}`,
            `date: ${new Date().toISOString()}`,
            `format: ${format}`,
            `tone: ${tone}`,
            `length: ${length}`,
            "---",
            "",
          ].join("\n");
          await fse.ensureDir(OUTPUT_DIR);
          const file = path.join(OUTPUT_DIR, `content_${timestamp()}.md`);
          const rel = path.relative(process.cwd(), file);
          await fse.writeFile(file, frontmatter + piece.content + "\n", "utf8");
          outPath = file;
          ctx.summary = `"${piece.title}" (${format}) → ${path.basename(file)}`;
          logStep(2, "Frontmatter-тэй Markdown файлд хадгаллаа");
          return { result: rel, context: { files_created: [rel] } };
        },
      },
    ],
  });

  logDone(`Done — ${outPath ? path.relative(process.cwd(), outPath) : "(файл үүсээгүй)"}`);
  return outPath;
}
