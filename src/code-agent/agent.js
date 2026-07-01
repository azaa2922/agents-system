/**
 * Code Agent — шаардлагаас бүрэн төслийн код үүсгэж /output/PROJECT_NAME/
 * хавтсанд бичээд, сонголтоор git commit + push хийнэ.
 *
 * Санах ой: generate → write → (publish) алхмуудаар явж, алхам бүр Firebase-д
 * бүртгэгдэнэ. Firebase тохируулаагүй бол санах ойгүйгээр адил ажиллана.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
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
const CODE_SCHEMA = {
  type: "object",
  properties: {
    project_name: { type: "string", description: "Short kebab-case project folder name" },
    description: { type: "string", description: "One-sentence project description" },
    files: {
      type: "array",
      description: "Every file the project needs, including README.md",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path inside the project, e.g. src/App.jsx" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["project_name", "description", "files"],
  additionalProperties: false,
};

const SYSTEM = `You are a code-generation agent. Given a requirement, produce a complete, runnable project.
Rules:
- Return every file the project needs with FULL content (no placeholders, no "...").
- Always include a README.md with setup and run instructions.
- Use relative paths only (e.g. "src/App.jsx"); never absolute paths or "..".
- Keep the project minimal but working; include package.json / requirements.txt etc. when the stack needs it.`;

function safeJoin(baseDir, relPath) {
  const cleaned = path.normalize(relPath).replace(/^([/\\])+/, "");
  const full = path.resolve(baseDir, cleaned);
  if (full !== baseDir && !full.startsWith(baseDir + path.sep)) {
    throw new Error(`Аюултай файлын зам: ${relPath}`);
  }
  return full;
}

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/* ---------- main flow ---------- */
export async function processRequest(requirement, { name, useGit = false, push = false, resume = null } = {}) {
  requireEnv("ANTHROPIC_API_KEY");
  log(`🛠  Starting Code Agent — "${requirement}"`);

  let projectDir = null;
  let generated = null;

  await runAgent({
    agentType: "code-agent",
    goal: requirement,
    log,
    resume,
    buildSteps: async () => {
      const steps = [
        {
          action: "generate",
          description: "Claude writes the full project",
          run: async () => {
            const { result, tokens } = await callClaude(SYSTEM, `Requirement: ${requirement}`, { schema: CODE_SCHEMA });
            if (!result.files?.length) fail("Claude нэг ч файл үүсгэсэнгүй");
            generated = result;
            logStep(1, `Claude "${result.project_name}" төслийн ${result.files.length} файлыг бэлдлээ`);
            return {
              result: `${result.files.length} файл — ${result.project_name}`,
              tokens,
              context: {
                accumulated_knowledge: result.description,
                decisions_made: [`Generate project: ${result.project_name}`],
                last_claude_response: result.description,
              },
            };
          },
        },
        {
          action: "write",
          description: "Create folder structure and write files",
          run: async (ctx) => {
            let projectName =
              (name || generated.project_name || "project")
                .toLowerCase()
                .replace(/[^a-z0-9._-]+/g, "-")
                .replace(/^[-.]+|[-.]+$/g, "") || "project";
            projectDir = path.join(OUTPUT_DIR, projectName);
            if (await fse.pathExists(projectDir)) {
              projectDir = path.join(OUTPUT_DIR, `${projectName}_${timestamp()}`);
            }
            await fse.ensureDir(projectDir);

            const written = [];
            for (const file of generated.files) {
              const dest = safeJoin(projectDir, file.path);
              await fse.ensureDir(path.dirname(dest));
              await fse.writeFile(dest, file.content, "utf8");
              written.push(path.relative(projectDir, dest));
              log(`   • ${path.relative(projectDir, dest)}`);
            }
            if (!generated.files.some((f) => path.basename(f.path).toLowerCase() === "readme.md")) {
              await fse.writeFile(
                path.join(projectDir, "README.md"),
                `# ${projectName}\n\n${generated.description}\n`,
                "utf8",
              );
              written.push("README.md");
              log("   • README.md (нэмж үүсгэв)");
            }
            const rel = path.relative(process.cwd(), projectDir);
            logStep(2, `Файлуудыг бичлээ → ${rel}/`);
            ctx.summary = `"${generated.project_name}" — ${written.length} файл, ${rel}/`;
            return {
              result: `${written.length} файл → ${rel}/`,
              context: { files_created: [`${rel}/`], decisions_made: [`Wrote ${written.length} files`] },
            };
          },
        },
      ];

      if (useGit || push) {
        steps.push({
          action: "publish",
          description: push ? "git init + commit + push" : "git init + commit",
          run: async () => {
            const projectName = path.basename(projectDir);
            git(["init"], projectDir);
            git(["add", "-A"], projectDir);
            git(
              ["-c", "user.email=code-agent@local", "-c", "user.name=code-agent", "commit", "-m", `Generate ${projectName}`],
              projectDir,
            );
            logStep(3, "Git repo үүсгэж commit хийлээ");

            const decisions = ["git init + commit"];
            if (push) {
              const remote = process.env.GIT_REMOTE_URL;
              if (!remote) {
                log(chalk.yellow("⚠ GIT_REMOTE_URL тохируулаагүй тул push алгасав (.env дотор нэмнэ үү)"));
              } else {
                git(["branch", "-M", "main"], projectDir);
                git(["remote", "add", "origin", remote], projectDir);
                git(["push", "-u", "origin", "main"], projectDir);
                logStep(3, `Push хийлээ → ${remote}`);
                decisions.push(`Pushed to ${remote}`);
              }
            }
            return { result: decisions.join("; "), context: { decisions_made: decisions } };
          },
        });
      }
      return steps;
    },
  });

  logDone(`Done — ${projectDir ? path.relative(process.cwd(), projectDir) + "/" : "(төсөл үүсээгүй)"}`);
  return projectDir;
}
