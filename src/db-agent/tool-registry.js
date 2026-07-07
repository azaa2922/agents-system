/**
 * DB Agent Tool Registry
 * Tools: db (Claude schema generation → output/), file, write, think
 */
import path from "node:path";
import fse from "fs-extra";
import { callClaude, OUTPUT_DIR, OUTPUT_FORMATS, timestamp, log } from "./agent.js";
import { makeFileTool, makeWriteTool, makeThinkTool } from "../core/registry-helpers.js";

const DB_SCHEMA = {
  type: "object",
  properties: {
    content: {
      type: "string",
      description: "Full content of the schema/migration/query file — code only, no markdown fences",
    },
    notes: {
      type: "string",
      description: "Short design notes (indexes, constraints, assumptions)",
    },
  },
  required: ["content", "notes"],
  additionalProperties: false,
};

const buildSystem = (label) => `You are a database design agent.
Generate ${label} for the user's request (table design, migration, or query — whatever the request asks for).
Rules:
- Output must be complete and immediately usable: proper data types, primary/foreign keys, sensible indexes, constraints and timestamps.
- Add brief inline comments where they aid understanding.
- "content" must contain ONLY the code — no markdown fences, no prose around it.`;

/** defaults come from the CLI flags (--format) */
export function createToolRegistry(defaults = {}) {
  return {
    /**
     * Generate a database schema/migration/query and save it.
     * params: { request|description, format? (sql|prisma|typeorm) }
     */
    async db(params) {
      const request = params.request || params.description || params.value;
      if (!request) throw new Error("db tool: 'request' параметр шаардлагатай");
      const format = OUTPUT_FORMATS[params.format] ? params.format : (defaults.format ?? "sql");
      const fmt = OUTPUT_FORMATS[format];

      log(`[DBGen] ${format.toUpperCase()}: ${request}`);
      const result = await callClaude(buildSystem(fmt.label), String(request), { schema: DB_SCHEMA });

      await fse.ensureDir(OUTPUT_DIR);
      const file = path.join(OUTPUT_DIR, `schema_${timestamp()}${fmt.ext}`);
      await fse.writeFile(file, result.content.trimEnd() + "\n", "utf8");
      log(`[DBGen] Saved → ${path.relative(process.cwd(), file)}`);

      return `Schema saved: ${file}\nNotes: ${result.notes}`;
    },

    file: makeFileTool({ outputDir: OUTPUT_DIR, log }),
    write: makeWriteTool({ outputDir: OUTPUT_DIR, timestamp, log, prefix: "db_notes" }),
    think: makeThinkTool({ callClaude, label: "database design agent" }),
  };
}

export default createToolRegistry;
