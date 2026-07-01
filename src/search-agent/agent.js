/**
 * Search Agent — Claude төлөвлөж, Tavily API-аар вэб хайлт хийж,
 * үр дүнг нэгтгэн дүгнээд /output руу хадгална.
 *
 * Санах ой: алхам бүр Firebase-д бүртгэгдэж, хайлт бүрийн олдвор context-д
 * хуримтлагдана. Firebase тохируулаагүй бол санах ойгүйгээр адил ажиллана.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import chalk from "chalk";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";
import fse from "fs-extra";
import { runAgent } from "../core/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
export const OUTPUT_DIR = path.join(ROOT, "output");

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const MODEL = "claude-opus-4-8";

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

/* ---------- Tavily ---------- */
async function tavilySearch(query, maxResults = 5) {
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

/* ---------- prompts / schema ---------- */
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

/* ---------- main flow ---------- */
export async function processRequest(userInput, { resume = null } = {}) {
  requireEnv("ANTHROPIC_API_KEY", "TAVILY_API_KEY");
  log(`🔎 Starting Search Agent — "${userInput}"`);

  let outPath = null;

  await runAgent({
    agentType: "search-agent",
    goal: userInput,
    log,
    resume,
    buildSteps: async ({ resumed }) => {
      // Плейн: санах ойгоос сэргээх эсвэл Claude-аар шинээр төлөвлөх.
      let strategy;
      let queries;
      let planTokens = 0;
      if (resumed?.context?.plan?.queries?.length) {
        ({ strategy, queries } = resumed.context.plan);
        log(`↩️  Төлөвлөгөөг санах ойгоос сэргээв (${queries.length} query)`);
      } else {
        const { result: plan, tokens } = await callClaude(PLANNER_SYSTEM, userInput, {
          schema: PLAN_SCHEMA,
          maxTokens: 4000,
        });
        strategy = plan.strategy;
        queries = plan.queries.slice(0, 4);
        planTokens = tokens;
        if (queries.length === 0) fail("Claude хайлтын query гаргаж чадсангүй");
      }
      logStep(1, `Төлөвлөгөө: ${strategy} (${queries.length} query)`);

      const searchResults = [];
      let summaryText = "";
      let resultsText = "";

      const steps = [
        {
          action: "plan",
          description: `Break down the task — ${strategy}`,
          run: async () => ({
            result: `Planned ${queries.length} queries`,
            tokens: planTokens,
            context: {
              plan: { strategy, queries },
              decisions_made: [`Strategy: ${strategy}`],
            },
          }),
        },
        ...queries.map((query, idx) => ({
          action: "search",
          description: `Search: ${query}`,
          run: async (ctx) => {
            const t0 = Date.now();
            const results = await tavilySearch(query);
            const ms = Date.now() - t0;
            searchResults.push({ query, results });
            logStep(2, `(${idx + 1}/${queries.length}) "${query}" → ${results.length} үр дүн · ${ms}ms`);
            const titles = results.slice(0, 3).map((r) => r.title).join("; ");
            const prior = ctx.accumulated_knowledge ? `${ctx.accumulated_knowledge}\n` : "";
            return {
              result: `${results.length} results (${ms}ms)`,
              context: { accumulated_knowledge: `${prior}- "${query}" → ${results.length}: ${titles}` },
            };
          },
        })),
        {
          action: "summarize",
          description: "Summarize findings via Claude",
          run: async () => {
            resultsText = searchResults
              .map(
                ({ query, results }) =>
                  `### Query: ${query}\n\n` +
                  (results.length
                    ? results
                        .map(
                          (r, j) =>
                            `${j + 1}. **${r.title}**\n   - URL: ${r.url}\n   - ${(r.content ?? "").slice(0, 800)}`,
                        )
                        .join("\n")
                    : "_үр дүн олдсонгүй_"),
              )
              .join("\n\n");
            const { result: summary, tokens } = await callClaude(
              SUMMARY_SYSTEM,
              `Хэрэглэгчийн хүсэлт: ${userInput}\n\nХайлтын түүхий үр дүн:\n\n${resultsText}`,
            );
            summaryText = summary;
            logStep(3, "Claude үр дүнг нэгтгэж дүгнэлт гаргалаа");
            return {
              result: `Summary ready (${summary.length} chars)`,
              tokens,
              context: { last_claude_response: summary.slice(0, 500) },
            };
          },
        },
        {
          action: "save",
          description: "Save report to /output",
          run: async (ctx) => {
            await fse.ensureDir(OUTPUT_DIR);
            const file = path.join(OUTPUT_DIR, `search_${timestamp()}.md`);
            const rel = path.relative(process.cwd(), file);
            const doc = [
              "# Web Search Report",
              "",
              `- **Хүсэлт:** ${userInput}`,
              `- **Огноо:** ${new Date().toISOString()}`,
              `- **Стратеги:** ${strategy}`,
              "",
              "## Дүгнэлт",
              "",
              summaryText,
              "",
              "## Түүхий үр дүн",
              "",
              resultsText,
              "",
            ].join("\n");
            await fse.writeFile(file, doc, "utf8");
            outPath = file;
            ctx.summary = `"${userInput}" — ${searchResults.length} хайлт, ${path.basename(file)}-д хадгалав`;
            logStep(4, "Тайланг файлд хадгаллаа");
            return { result: rel, context: { files_created: [rel] } };
          },
        },
      ];
      return steps;
    },
  });

  logDone(`Done — ${outPath ? path.relative(process.cwd(), outPath) : "(файл үүсээгүй)"}`);
  return outPath;
}
