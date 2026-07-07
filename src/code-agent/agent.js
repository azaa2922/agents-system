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
import { GoogleGenAI, Type, ApiError } from "@google/genai";
import fse from "fs-extra";
import { runAgent } from "../core/runner.js";

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
const CODE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    project_name: { type: Type.STRING, description: "Short kebab-case project folder name" },
    description: { type: Type.STRING, description: "One-sentence project description" },
    files: {
      type: Type.ARRAY,
      description: "Every file the project needs, including README.md",
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING, description: "Relative file path inside the project, e.g. src/App.jsx" },
          content: { type: Type.STRING, description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  required: ["project_name", "description", "files"],
  propertyOrdering: ["project_name", "description", "files"],
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
  requireEnv("GEMINI_API_KEY");
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
          description: "Gemini writes the full project",
          run: async () => {
            const { result, tokens } = await callGemini(SYSTEM, `Requirement: ${requirement}`, { schema: CODE_SCHEMA });
            if (!result.files?.length) fail("Gemini нэг ч файл үүсгэсэнгүй");
            generated = result;
            logStep(1, `Gemini "${result.project_name}" төслийн ${result.files.length} файлыг бэлдлээ`);
            return {
              result: `${result.files.length} файл — ${result.project_name}`,
              tokens,
              context: {
                accumulated_knowledge: result.description,
                decisions_made: [`Generate project: ${result.project_name}`],
                last_gemini_response: result.description,
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
