/**
 * File Agent Tool Registry
 * Tools: file (read/create/append/list/transform), write, think
 */
import path from "node:path";
import fse from "fs-extra";
import { callGemini, OUTPUT_DIR, timestamp, log } from "./agent.js";
import { makeFileTool, makeWriteTool, makeThinkTool } from "../core/registry-helpers.js";

const MAX_INPUT_CHARS = 150_000;

const TRANSFORM_SCHEMA = {
  type: "object",
  properties: {
    output_filename: { type: "string", description: "Output file name with correct extension" },
    output_content: { type: "string", description: "COMPLETE content of the transformed output file" },
    explanation: { type: "string", description: "1-2 sentence summary of what was done" },
  },
  required: ["output_filename", "output_content", "explanation"],
  additionalProperties: false,
};

const SYSTEM = `You are a file-processing agent. You receive an input file (CSV, JSON, TXT or Markdown) and an instruction.
Apply the transformation precisely and return the complete transformed result.
Rules:
- output_content must contain the ENTIRE output file and be valid in its format.
- Never invent data that is not derivable from the input.
- Preserve all rows/entries unless the instruction says to filter.`;

export function createToolRegistry() {
  const baseFileTool = makeFileTool({ outputDir: OUTPUT_DIR, log });

  return {
    /**
     * File operations. params:
     *   { operation: "read"|"create"|"append"|"list", file, content }
     *   { operation: "transform", file, instruction } → Gemini transforms, saves to output/
     */
    async file(params) {
      if (params.operation !== "transform") return baseFileTool(params);

      const file = params.file || params.path;
      const instruction = params.instruction || params.value;
      if (!file) throw new Error("file tool: 'file' параметр шаардлагатай");
      if (!instruction) throw new Error("file transform: 'instruction' параметр шаардлагатай");

      const full = path.resolve(process.cwd(), file);
      const text = await fse.readFile(full, "utf8");
      if (!text.trim()) throw new Error(`${file} файл хоосон байна`);
      if (text.length > MAX_INPUT_CHARS) {
        throw new Error(`Оролтын файл хэт том (${text.length} > ${MAX_INPUT_CHARS} тэмдэгт)`);
      }

      log(`[Transform] ${file}: ${instruction}`);
      const result = await callGemini(
        SYSTEM,
        `Instruction: ${instruction}\n\n--- FILE: ${path.basename(full)} ---\n${text}`,
        { schema: TRANSFORM_SCHEMA },
      );

      await fse.ensureDir(OUTPUT_DIR);
      const safe = path.basename(result.output_filename).replace(/[^\w.\-]/g, "_");
      const ext = path.extname(safe);
      const base = safe.slice(0, safe.length - ext.length) || "output";
      const outPath = path.join(OUTPUT_DIR, `${base}_${timestamp()}${ext || ".txt"}`);
      await fse.writeFile(outPath, result.output_content, "utf8");
      log(`[Transform] ${result.explanation} → ${path.relative(process.cwd(), outPath)}`);

      return `Transformed ${file} → ${outPath}. ${result.explanation}`;
    },

    write: makeWriteTool({ outputDir: OUTPUT_DIR, timestamp, log, prefix: "file_notes" }),
    think: makeThinkTool({ callLLM: callGemini, label: "file-processing agent" }),
  };
}

export default createToolRegistry;
