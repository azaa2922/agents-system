/**
 * src/core/registry-helpers.js
 *
 * Shared tool implementations composed into each agent's tool registry.
 * Every tool is loop-safe: it throws on bad input (failing the step) instead
 * of exiting the process, so the agentic loop can reflect and recover.
 */
import path from "node:path";
import fse from "fs-extra";

const READ_LIMIT = 4000; // chars returned to the loop from file reads

/** Resolve a path inside baseDir, rejecting traversal outside it. */
export function safeJoin(baseDir, relPath) {
  const cleaned = path.normalize(String(relPath)).replace(/^([/\\])+/, "");
  const full = path.resolve(baseDir, cleaned);
  if (full !== baseDir && !full.startsWith(baseDir + path.sep)) {
    throw new Error(`Аюултай файлын зам: ${relPath}`);
  }
  return full;
}

/**
 * Generic file tool. params:
 *   { operation: "read" | "create" | "append" | "list", file, content }
 * Reads are cwd-relative; writes are sandboxed into outputDir.
 */
export function makeFileTool({ outputDir, log }) {
  return async function file(params) {
    const operation = params.operation || (params.content ? "create" : "read");

    if (operation === "list") {
      await fse.ensureDir(outputDir);
      const entries = await fse.readdir(outputDir);
      return `output/ contains ${entries.length} entries:\n${entries.join("\n")}`;
    }

    const target = params.file || params.path || params.value;
    if (!target) throw new Error("file tool: 'file' параметр шаардлагатай");

    if (operation === "read") {
      const full = path.resolve(process.cwd(), target);
      const text = await fse.readFile(full, "utf8");
      log?.(`[FileOps] read ${target} (${text.length} chars)`);
      return text.length > READ_LIMIT
        ? `${text.slice(0, READ_LIMIT)}\n... (${text.length - READ_LIMIT} тэмдэгт хасагдав)`
        : text;
    }

    if (operation === "create" || operation === "append") {
      if (params.content == null) throw new Error("file tool: 'content' параметр шаардлагатай");
      const dest = safeJoin(outputDir, target);
      await fse.ensureDir(path.dirname(dest));
      if (operation === "append") await fse.appendFile(dest, String(params.content), "utf8");
      else await fse.writeFile(dest, String(params.content), "utf8");
      log?.(`[FileOps] ${operation} → ${path.relative(process.cwd(), dest)}`);
      return `File ${operation}d: ${dest}`;
    }

    throw new Error(`file tool: үл мэдэгдэх operation "${operation}" (read|create|append|list)`);
  };
}

/**
 * Generic write tool: saves a markdown document to outputDir.
 * params: { title?, content, filename? }
 */
export function makeWriteTool({ outputDir, timestamp, log, prefix = "note" }) {
  return async function write(params) {
    const content = params.content || params.value;
    if (!content) throw new Error("write tool: 'content' параметр шаардлагатай");
    await fse.ensureDir(outputDir);
    const name = params.filename
      ? path.basename(String(params.filename)).replace(/[^\w.\-]/g, "_")
      : `${prefix}_${timestamp()}.md`;
    const dest = path.join(outputDir, name);
    const doc = params.title ? `# ${params.title}\n\n${content}\n` : `${content}\n`;
    await fse.writeFile(dest, doc, "utf8");
    log?.(`[Writer] Saved → ${path.relative(process.cwd(), dest)}`);
    return `Saved: ${dest}`;
  };
}

/**
 * Generic think tool: free-form reasoning via the agent's own callGemini.
 * params: { request | question }
 */
export function makeThinkTool({ callLLM, label = "agent" }) {
  return async function think(params) {
    const request = params.request || params.question || params.value;
    if (!request) return "Nothing to think about — provide a 'request' parameter.";
    return await callLLM(
      `You are the reasoning module of a ${label}. Think through the request and
answer concisely in the same language as the request. Do not use tools; just reason.`,
      String(request),
      { maxTokens: 4000 },
    );
  };
}
