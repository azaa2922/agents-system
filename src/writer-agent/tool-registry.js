/**
 * Writer Agent Tool Registry
 * Tools: write (Gemini content generation → output/), file, think
 */
import path from "node:path";
import fse from "fs-extra";
import {
  callGemini,
  OUTPUT_DIR,
  timestamp,
  log,
  TONES,
  LENGTHS,
  FORMATS,
} from "./agent.js";
import { makeFileTool, makeThinkTool } from "../core/registry-helpers.js";

const WRITE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short title for the piece" },
    content: { type: "string", description: "Full content in Markdown, WITHOUT YAML frontmatter" },
  },
  required: ["title", "content"],
  additionalProperties: false,
};

const buildSystem = (tone, length, format) => `You are a professional content writer.
Write a "${format}" piece with a ${tone} tone, ${LENGTHS[length]} long.
Formats: blog = blog post with headings; email = ready-to-send email (subject as title);
social = social-media post(s); docs = technical documentation.
Match the language of the user's request.
Return polished, publication-ready Markdown in "content" — no YAML frontmatter.`;

/** defaults come from the CLI flags (--tone/--length/--format) */
export function createToolRegistry(defaults = {}) {
  return {
    /**
     * Generate content with Gemini and save it.
     * params: { topic|brief|content, format?, tone?, length?, title? }
     * If 'content' is provided it is saved as-is (no generation).
     */
    async write(params) {
      const tone = TONES.includes(params.tone) ? params.tone : (defaults.tone ?? "professional");
      const length = LENGTHS[params.length] ? params.length : (defaults.length ?? "medium");
      const format = FORMATS.includes(params.format) ? params.format : (defaults.format ?? "blog");

      let title = params.title;
      let content = params.content;
      if (!content) {
        const brief = params.topic || params.brief || params.value;
        if (!brief) throw new Error("write tool: 'topic' эсвэл 'content' параметр шаардлагатай");
        log(`[Writer] Writing ${format} (${tone}/${length}): ${brief}`);
        const result = await callGemini(buildSystem(tone, length, format), String(brief), {
          schema: WRITE_SCHEMA,
        });
        title = result.title;
        content = result.content;
      }

      const frontmatter = [
        "---",
        `title: ${JSON.stringify(title ?? "Untitled")}`,
        `date: ${new Date().toISOString()}`,
        `format: ${format}`,
        `tone: ${tone}`,
        `length: ${length}`,
        "---",
        "",
      ].join("\n");

      await fse.ensureDir(OUTPUT_DIR);
      const file = path.join(OUTPUT_DIR, `content_${timestamp()}.md`);
      await fse.writeFile(file, frontmatter + content + "\n", "utf8");
      log(`[Writer] Saved → ${path.relative(process.cwd(), file)}`);
      return `Content "${title}" saved: ${file}`;
    },

    file: makeFileTool({ outputDir: OUTPUT_DIR, log }),
    think: makeThinkTool({ callLLM: callGemini, label: "content-writing agent" }),
  };
}

export default createToolRegistry;
