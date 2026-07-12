/**
 * src/core/orchestrator.js
 *
 * The Orchestrator is a meta-agent that coordinates the six specialist agents
 * (search, code, data, file, write, db). It reuses the SAME AgenticLoop engine:
 *
 *   ┌─ Orchestrator (AgenticLoop) ─────────────────────────────┐
 *   │  plan → pick which agent(s) to run → reflect → repeat     │
 *   │      │                                                    │
 *   │      ├─ delegate "search" ─▶ Search Agent (child loop)    │
 *   │      ├─ delegate "code"   ─▶ Code Agent   (child loop)    │
 *   │      └─ ...                                               │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Each specialist agent is exposed to the orchestrator's planner as a single
 * tool. When the planner picks an agent, the orchestrator spins up a nested
 * AgenticLoop for that agent (using the agent's own tool registry) inside a
 * CHILD session that is linked to the orchestrator's parent session in the
 * shared Firebase memory structure. This gives hierarchical, resumable
 * tracking: sessions/<orchestrator>/children/<agent-session>.
 */
import { AgenticLoop } from "./agentic-loop.js";
import * as memory from "./memory.js";

import { createToolRegistry as searchRegistry } from "../search-agent/tool-registry.js";
import { createToolRegistry as codeRegistry } from "../code-agent/tool-registry.js";
import { createToolRegistry as dataRegistry } from "../data-agent/tool-registry.js";
import { createToolRegistry as fileRegistry } from "../file-agent/tool-registry.js";
import { createToolRegistry as writerRegistry } from "../writer-agent/tool-registry.js";
import { createToolRegistry as dbRegistry } from "../db-agent/tool-registry.js";

/**
 * The agent roster. Each entry:
 *   - createRegistry: builds that agent's own tool registry for a child loop
 *   - description:    tells the orchestrator's planner when to route here
 *                     (and the {"goal": "..."} param contract)
 *   - requiresEnv:    env vars the agent needs at runtime
 */
export const AGENTS = {
  search: {
    createRegistry: searchRegistry,
    requiresEnv: ["GEMINI_API_KEY", "TAVILY_API_KEY"],
    description:
      'Web search & research via Tavily + Gemini. Use to find current information, ' +
      'compare options, or gather documentation. Call with params {"goal": "<what to research>"}.',
  },
  code: {
    createRegistry: codeRegistry,
    requiresEnv: ["GEMINI_API_KEY"],
    description:
      'Generate runnable project code (any stack) into output/. Use to scaffold apps, APIs, ' +
      'or scripts. Call with params {"goal": "<what to build, incl. stack/name>"}.',
  },
  data: {
    createRegistry: dataRegistry,
    requiresEnv: ["GEMINI_API_KEY"],
    description:
      'Analyze a CSV/JSON dataset and produce a report with stats and tables. ' +
      'Call with params {"goal": "<analysis incl. the data file path, e.g. sales.csv>"}.',
  },
  file: {
    createRegistry: fileRegistry,
    requiresEnv: ["GEMINI_API_KEY"],
    description:
      'Read, convert, and transform files (CSV/JSON/TXT/Markdown). ' +
      'Call with params {"goal": "<transformation incl. the input file path>"}.',
  },
  write: {
    createRegistry: writerRegistry,
    requiresEnv: ["GEMINI_API_KEY"],
    description:
      'Write content: blog posts, emails, social posts, or documentation, saved to output/. ' +
      'Call with params {"goal": "<what to write, tone/format if relevant>"}.',
  },
  db: {
    createRegistry: dbRegistry,
    requiresEnv: ["GEMINI_API_KEY"],
    description:
      'Design database schemas, migrations, and queries (SQL/Prisma/TypeORM) into output/. ' +
      'Call with params {"goal": "<schema/query to design, format if relevant>"}.',
  },
};

/** Planner-facing description for each agent tool (name → description). */
export const ORCHESTRATOR_TOOL_DESCRIPTIONS = Object.fromEntries(
  Object.entries(AGENTS).map(([name, spec]) => [name, spec.description]),
);

/**
 * Build the orchestrator's tool registry: one tool per specialist agent.
 * Each tool delegates a sub-goal to that agent by running a nested AgenticLoop
 * in a child session linked to `parentSessionId`.
 *
 * @param {object} opts
 * @param {object} [opts.memory]          memory module (defaults to core memory)
 * @param {string|null} [opts.apiKey]     Gemini key for child loops
 * @param {string} opts.parentSessionId   orchestrator session that owns the children
 * @param {string[]} [opts.agents]        subset of agent names to expose
 * @param {number} [opts.maxSubIterations] iteration cap for each child agent loop
 * @param {Function} [opts.makeLoop]      (agentName, childSessionId, subGoal) => loop
 *                                        — injectable for testing (no real API calls)
 */
export function createOrchestratorRegistry({
  memory: mem = memory,
  apiKey = process.env.GEMINI_API_KEY ?? null,
  parentSessionId,
  agents = Object.keys(AGENTS),
  maxSubIterations = 10,
  makeLoop = null,
} = {}) {
  const registry = {};

  for (const name of agents) {
    const spec = AGENTS[name];
    if (!spec) throw new Error(`Orchestrator: үл мэдэгдэх агент "${name}"`);

    registry[name] = async (params) => {
      const subGoal = params.goal || params.task || params.instruction || params.value;
      if (!subGoal) {
        throw new Error(`${name} agent: 'goal' параметр шаардлагатай (энэ агентад өгөх дэд зорилго)`);
      }

      const childSessionId = await mem.createSession(name, subGoal, parentSessionId);
      console.log(`\n    ╭─ Delegating to [${name}] agent → session ${childSessionId}`);
      console.log(`    │  Sub-goal: ${subGoal}`);

      const loop = makeLoop
        ? makeLoop(name, childSessionId, subGoal)
        : new AgenticLoop(childSessionId, mem, apiKey, spec.createRegistry(), {
            maxIterations: maxSubIterations,
          });

      // A single agent's hard failure should not throw a raw exception into
      // the orchestrator — capture it as an incomplete result so the planner
      // can reflect and route around it.
      let result;
      try {
        result = await loop.run(subGoal, maxSubIterations);
      } catch (err) {
        result = { success: false, result: `agent error: ${err.message}`, iterations: loop.iterationCount ?? 0 };
      }

      console.log(
        `    ╰─ [${name}] ${result.success ? "✓ complete" : "✗ incomplete"} ` +
          `(${result.iterations} iters, session ${childSessionId})`,
      );

      // Record the delegation on the parent session for a full audit trail
      // (both successes and failures).
      if (parentSessionId) {
        await mem.updateContext(parentSessionId, {
          delegations: [
            {
              agent: name,
              childSessionId,
              subGoal,
              success: result.success,
              summary: result.result,
              iterations: result.iterations,
            },
          ],
        });
      }

      return `[${name} agent] ${result.success ? "completed" : "incomplete"} after ${result.iterations} iteration(s). Result: ${result.result}`;
    };
  }

  return registry;
}

/**
 * Programmatic orchestrator: create a parent session, then run the top-level
 * AgenticLoop with the agent-delegation registry. The CLI (src/orchestrator/
 * index.js) uses the shared runner instead, but this class is handy for tests
 * and embedding.
 */
export class Orchestrator {
  constructor({
    memory: mem = memory,
    apiKey = process.env.GEMINI_API_KEY ?? null,
    agents = Object.keys(AGENTS),
    maxIterations = 15,
    maxSubIterations = 10,
  } = {}) {
    this.memory = mem;
    this.apiKey = apiKey;
    this.agents = agents;
    this.maxIterations = maxIterations;
    this.maxSubIterations = maxSubIterations;
    this.sessionId = null;
  }

  async run(goal, maxIterations = this.maxIterations) {
    await this.memory.initFirebase();
    this.sessionId = await this.memory.createSession("orchestrator", goal);

    const registry = createOrchestratorRegistry({
      memory: this.memory,
      apiKey: this.apiKey,
      parentSessionId: this.sessionId,
      agents: this.agents,
      maxSubIterations: this.maxSubIterations,
    });
    const toolDescriptions = Object.fromEntries(
      this.agents.map((n) => [n, AGENTS[n].description]),
    );

    const loop = new AgenticLoop(this.sessionId, this.memory, this.apiKey, registry, {
      maxIterations,
      toolDescriptions,
    });

    const result = await loop.run(goal, maxIterations);
    return { ...result, sessionId: this.sessionId };
  }
}

export default Orchestrator;
