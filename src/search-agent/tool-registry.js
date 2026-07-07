/**
 * Search Agent Tool Registry
 * Maps agentic-loop actions to real implementations (Tavily + Claude + output/).
 */
import path from "node:path";
import fse from "fs-extra";
import {
  tavilySearch,
  callClaude,
  OUTPUT_DIR,
  timestamp,
  log,
} from "./agent.js";

export function createToolRegistry() {
  const collected = []; // search results accumulated across loop iterations

  return {
    /** Web search via Tavily. params: { query, max_results? } */
    async search(params) {
      const query = params.query || params.value;
      if (!query) throw new Error("search tool: 'query' параметр шаардлагатай");
      log(`[Tavily] Searching: "${query}"`);
      const results = await tavilySearch(query, params.max_results ?? 5);
      collected.push({ query, results });
      const digest = results
        .map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${(r.content ?? "").slice(0, 300)}`)
        .join("\n");
      return `Query "${query}" → ${results.length} results\n${digest || "(no results)"}`;
    },

    /** Summarize collected results with Claude. params: { request } */
    async think(params) {
      const request = params.request || params.value || "Summarize the findings so far";
      if (collected.length === 0) return "No search results collected yet — run a search first.";
      const resultsText = collected
        .map(
          ({ query, results }) =>
            `### Query: ${query}\n` +
            results
              .map((r, i) => `${i + 1}. **${r.title}** (${r.url})\n   ${(r.content ?? "").slice(0, 600)}`)
              .join("\n"),
        )
        .join("\n\n");
      return await callClaude(
        `You are the analysis module of a web-search agent. Write a well-structured
Markdown summary that directly answers the request, citing source URLs inline.
Answer in the same language as the request.`,
        `Request: ${request}\n\nRaw search results:\n\n${resultsText}`,
      );
    },

    /** Save a markdown report to output/. params: { title, content } */
    async write(params) {
      const content = params.content || params.value;
      if (!content) throw new Error("write tool: 'content' параметр шаардлагатай");
      await fse.ensureDir(OUTPUT_DIR);
      const file = path.join(OUTPUT_DIR, `search_${timestamp()}.md`);
      const doc = [
        `# ${params.title || "Web Search Report"}`,
        "",
        `- **Огноо:** ${new Date().toISOString()}`,
        "",
        content,
        "",
      ].join("\n");
      await fse.writeFile(file, doc, "utf8");
      log(`[Writer] Saved report → ${path.relative(process.cwd(), file)}`);
      return `Report saved: ${file}`;
    },
  };
}

export default createToolRegistry;
