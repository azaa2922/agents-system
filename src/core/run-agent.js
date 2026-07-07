/**
 * src/core/run-agent.js
 *
 * Shared CLI runner: session bookkeeping + AgenticLoop execution + summary.
 * Every agent's index.js parses its own flags, builds its tool registry,
 * then delegates here.
 */
import { AgenticLoop } from "./agentic-loop.js";
import * as memory from "./memory.js";

/**
 * @param {object} opts
 * @param {string} opts.agentType      e.g. "search-agent"
 * @param {string} opts.label          banner label, e.g. "SEARCH AGENT"
 * @param {string} opts.goal           the user's goal
 * @param {object} opts.toolRegistry   action → async fn
 * @param {number} [opts.maxIterations]
 * @param {string|null} [opts.resumeId] session to resume
 * @returns {Promise<never>} exits the process with 0 (success) or 1
 */
export async function runAgenticAgent({
  agentType,
  label,
  goal,
  toolRegistry,
  maxIterations = 20,
  resumeId = null,
}) {
  console.log(`\n📊 ${label} Starting`);
  console.log(`Goal: ${goal}\n`);

  await memory.initFirebase();

  let sessionId;
  if (resumeId) {
    const resumed = await memory.resumeSession(resumeId);
    if (!resumed) {
      console.error(`✗ Session олдсонгүй: ${resumeId}`);
      process.exit(1);
    }
    sessionId = resumeId;
    console.log(`↻ Session сэргээлээ: ${resumeId} (${resumed.completedSteps.length} алхам гүйцэтгэсэн)`);
  } else {
    sessionId = await memory.createSession(agentType, goal);
    console.log(`• Session: ${sessionId}`);
  }

  const loop = new AgenticLoop(
    sessionId,
    memory,
    process.env.ANTHROPIC_API_KEY,
    toolRegistry,
  );

  const result = await loop.run(goal, maxIterations);

  console.log("\n" + "=".repeat(60));
  console.log(`${label} COMPLETE`);
  console.log("=".repeat(60));
  console.log(`Session:    ${sessionId}`);
  console.log(`Success:    ${result.success}`);
  console.log(`Iterations: ${result.iterations}`);
  console.log(`Result:     ${result.result}`);
  process.exit(result.success ? 0 : 1);
}

/** Pull `--max-iterations N` and `--resume <id>` out of a parsed flags object. */
export function loopFlags(flags) {
  return {
    maxIterations: typeof flags["max-iterations"] === "string" ? Number(flags["max-iterations"]) : 20,
    resumeId: typeof flags.resume === "string" ? flags.resume : null,
  };
}
