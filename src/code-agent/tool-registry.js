/**
 * Code Agent Tool Registry
 * Tools: code (Claude project generation), file, write, think
 */
import path from "node:path";
import fse from "fs-extra";
import { callClaude, OUTPUT_DIR, timestamp, log } from "./agent.js";
import { makeFileTool, makeWriteTool, makeThinkTool, safeJoin } from "../core/registry-helpers.js";

const CODE_SCHEMA = {
  type: "object",
  properties: {
    project_name: { type: "string", description: "Short kebab-case project folder name" },
    description: { type: "string", description: "One-sentence project description" },
    files: {
      type: "array",
      description: "Every file needed, including README.md",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path, e.g. src/App.jsx" },
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

const SYSTEM = `You are a code-generation agent. Given a requirement, produce complete, runnable code.
Rules:
- Return every file with FULL content (no placeholders, no "...").
- Use relative paths only; never absolute paths or "..".
- Keep the code minimal but working; include package.json / requirements.txt etc. when the stack needs it.`;

export function createToolRegistry() {
  return {
    /** Generate project code with Claude and write it under output/.
     *  params: { description|requirement, language?, name? } */
    async code(params) {
      const requirement = params.description || params.requirement || params.value;
      if (!requirement) throw new Error("code tool: 'description' параметр шаардлагатай");
      log(`[CodeGen] Generating: ${requirement}`);

      const prompt = params.language
        ? `Requirement: ${requirement}\nLanguage/stack: ${params.language}`
        : `Requirement: ${requirement}`;
      const result = await callClaude(SYSTEM, prompt, { schema: CODE_SCHEMA });
      if (!result.files?.length) throw new Error("Claude нэг ч файл үүсгэсэнгүй");

      const projectName =
        String(params.name || result.project_name || "project")
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^[-.]+|[-.]+$/g, "") || "project";
      let projectDir = path.join(OUTPUT_DIR, projectName);
      if (await fse.pathExists(projectDir)) {
        projectDir = path.join(OUTPUT_DIR, `${projectName}_${timestamp()}`);
      }
      await fse.ensureDir(projectDir);

      for (const file of result.files) {
        const dest = safeJoin(projectDir, file.path);
        await fse.ensureDir(path.dirname(dest));
        await fse.writeFile(dest, file.content, "utf8");
        log(`   • ${path.relative(projectDir, dest)}`);
      }

      return `Generated ${result.files.length} files in ${projectDir}: ${result.files
        .map((f) => f.path)
        .join(", ")}`;
    },

    file: makeFileTool({ outputDir: OUTPUT_DIR, log }),
    write: makeWriteTool({ outputDir: OUTPUT_DIR, timestamp, log, prefix: "code_notes" }),
    think: makeThinkTool({ callClaude, label: "code-generation agent" }),
  };
}

export default createToolRegistry;
