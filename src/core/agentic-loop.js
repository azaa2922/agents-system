/**
 * src/core/agentic-loop.js
 *
 * Core autonomy engine: the plan → execute → reflect loop.
 * The agent loops until the goal is complete, max iterations are reached,
 * or a fatal error occurs — no human intervention needed.
 *
 * LLM: Anthropic Claude (same stack as the rest of this repo). For tests or
 * alternative providers, inject `options.llmCall(systemPrompt, userMessage,
 * { schema })` — it must return the parsed object when a schema is given.
 *
 * Tool registry: a plain object mapping action names to async functions,
 * e.g. { search: async (params) => "...", write: async (params) => "..." }.
 * The planner may only choose actions that exist in the registry.
 */
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.AGENTIC_LOOP_MODEL || "claude-opus-4-8";
const MAX_CONSECUTIVE_FAILURES = 3;

const clock = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => console.log(`[${clock()}] ${msg}`);

/* ---------- structured output schemas ----------
 * `params` is a JSON-encoded string because structured outputs require
 * closed object schemas (additionalProperties: false) and tool params are
 * free-form. The loop parses it back into an object before execution. */
const planSchema = (actions) => ({
  type: "object",
  properties: {
    reasoning: {
      type: "string",
      description: "Why these steps are planned, or why the goal is already complete",
    },
    steps: {
      type: "array",
      description: "The next 1-3 concrete steps. Empty array = goal is complete.",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: actions },
          description: { type: "string", description: "What this step does" },
          params: {
            type: "string",
            description: 'Parameters for the tool as a JSON-encoded object, e.g. "{\\"query\\": \\"react frameworks\\"}"',
          },
        },
        required: ["action", "description", "params"],
        additionalProperties: false,
      },
    },
  },
  required: ["reasoning", "steps"],
  additionalProperties: false,
});

const REFLECT_SCHEMA = {
  type: "object",
  properties: {
    analysis: { type: "string", description: "Brief analysis of progress" },
    isGoalComplete: { type: "boolean" },
    completionReason: { type: "string", description: "Why the goal is or is not complete" },
    nextAction: { type: "string", description: "What to do in the next iteration if not complete" },
    updatedKnowledge: { type: "string", description: "New insights to carry into the next iteration" },
  },
  required: ["analysis", "isGoalComplete", "completionReason", "nextAction", "updatedKnowledge"],
  additionalProperties: false,
};

export class AgenticLoop {
  /**
   * @param {string} sessionId    session created via memory.createSession()
   * @param {object} memory       the src/core/memory.js module (or compatible)
   * @param {string|null} apiKey  Anthropic API key (falls back to ANTHROPIC_API_KEY)
   * @param {object} toolRegistry action name → async function(params)
   * @param {object} [options]    { model, maxIterations, llmCall }
   */
  constructor(sessionId, memory, apiKey, toolRegistry, options = {}) {
    if (!toolRegistry || Object.keys(toolRegistry).length === 0) {
      throw new Error("AgenticLoop: toolRegistry хоосон байна — дор хаяж нэг tool бүртгэнэ үү");
    }
    this.sessionId = sessionId;
    this.memory = memory;
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
    this.tools = toolRegistry;
    this.model = options.model || MODEL;
    this.maxIterations = options.maxIterations ?? 20;
    this.iterationCount = 0;
    this._llmCall = options.llmCall || null; // injectable for tests
    this._client = null;
  }

  async run(goal, maxIterations = this.maxIterations) {
    this.maxIterations = maxIterations;
    console.log(`\n🎯 Starting agentic loop for goal: "${goal}"\n`);

    let isComplete = false;
    let completionReason = "";
    let consecutiveFailures = 0;

    try {
      let context = await this.memory.getContext(this.sessionId);

      while (this.iterationCount < this.maxIterations && !isComplete) {
        console.log(`\n━━━ ITERATION ${this.iterationCount + 1} ━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        try {
          // PHASE 1: PLAN
          const plan = await this._plan(goal, context);
          if (!plan.steps || plan.steps.length === 0) {
            isComplete = true;
            completionReason = plan.reasoning || "Planner returned no further steps";
            console.log(`\n🎉 Goal complete: ${completionReason}`);
            this.iterationCount++;
            await this.memory.recordIteration(this.sessionId, this.iterationCount);
            break;
          }

          const stepOffset = await this.memory.addSteps(this.sessionId, plan.steps);
          console.log(`📋 Planned ${plan.steps.length} steps`);
          plan.steps.forEach((step, i) => {
            console.log(`  ${i + 1}. [${step.action}] ${step.description}`);
          });

          // PHASE 2: EXECUTE
          const executionResults = await this._executeSteps(plan.steps, stepOffset);
          const succeeded = executionResults.filter((r) => r.success).length;
          console.log(`\n✅ Executed ${executionResults.length} steps (${succeeded} succeeded)`);

          // PHASE 3: REFLECT
          const reflection = await this._reflect(goal, plan, executionResults, context);

          context = await this.memory.updateContext(this.sessionId, {
            accumulated_knowledge: reflection.updatedKnowledge,
            last_reflection: reflection.analysis,
            steps_executed: (context.steps_executed ?? 0) + executionResults.length,
          });

          if (reflection.isGoalComplete) {
            isComplete = true;
            completionReason = reflection.completionReason;
            console.log(`\n🎉 Goal complete: ${completionReason}`);
          } else {
            console.log(`\n🔄 Not yet complete. ${reflection.nextAction}`);
          }

          consecutiveFailures = 0;
          this.iterationCount++;
          await this.memory.recordIteration(this.sessionId, this.iterationCount);
        } catch (iterError) {
          if (this._isFatal(iterError)) throw iterError;
          consecutiveFailures++;
          this.iterationCount++;
          console.error(`❌ Error during iteration ${this.iterationCount}: ${iterError.message}`);
          await this.memory.updateContext(this.sessionId, {
            last_error: iterError.message,
            error_iteration: this.iterationCount,
          });
          await this.memory.recordIteration(this.sessionId, this.iterationCount);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            throw new Error(
              `${MAX_CONSECUTIVE_FAILURES} дараалсан алдаа гарлаа, loop зогслоо: ${iterError.message}`,
            );
          }
        }
      }

      if (!isComplete && this.iterationCount >= this.maxIterations) {
        console.log(`\n⚠️  Max iterations (${this.maxIterations}) reached.`);
        completionReason = "Max iterations reached";
      }

      await this.memory.completeSession(this.sessionId, {
        success: isComplete,
        ...(isComplete ? { completionReason } : { reason: completionReason }),
        iterations: this.iterationCount,
      });

      return { success: isComplete, result: completionReason, iterations: this.iterationCount };
    } catch (error) {
      console.error("Fatal error in agentic loop:", error.message);
      await this.memory.completeSession(this.sessionId, {
        success: false,
        error: error.message,
        iterations: this.iterationCount,
      });
      throw error;
    }
  }

  /* ---------- PLAN ---------- */
  async _plan(goal, context) {
    const actions = Object.keys(this.tools);
    const system = `You are the planning module of an autonomous agent.
Available actions: ${actions.join(", ")}.
Plan the NEXT 1-3 concrete steps toward the goal. Each step's "params" field
must be a JSON-encoded object with the arguments the tool needs.
If the goal is already complete, return an empty steps array and explain why in "reasoning".`;

    const user = `Goal: "${goal}"

Accumulated knowledge so far:
${context?.accumulated_knowledge || "(none yet)"}

Last reflection:
${context?.last_reflection || "(none yet)"}
${context?.last_error ? `\nLast error:\n${context.last_error}` : ""}`;

    const parsed = await this._llm(system, user, planSchema(actions));
    return {
      reasoning: parsed.reasoning,
      steps: (parsed.steps || []).map((step) => ({
        ...step,
        params: this._parseParams(step.params),
      })),
    };
  }

  _parseParams(params) {
    if (params && typeof params === "object") return params;
    if (typeof params !== "string" || params.trim() === "") return {};
    try {
      const parsed = JSON.parse(params);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return { value: params };
    }
  }

  /* ---------- EXECUTE ---------- */
  async _executeSteps(steps, stepOffset) {
    const results = [];
    for (const [i, step] of steps.entries()) {
      const stepIndex = stepOffset + i;
      console.log(`\n  → Executing: [${step.action}] ${step.description}`);
      await this.memory.startStep(this.sessionId, stepIndex);
      const t0 = Date.now();
      try {
        const result = await this._executeAction(step.action, step.params || {});
        const duration = ((Date.now() - t0) / 1000).toFixed(2);
        await this.memory.completeStep(this.sessionId, stepIndex, result);
        results.push({ action: step.action, description: step.description, success: true, result, duration: `${duration}s` });
        console.log(`    ✓ Success (${duration}s)`);
      } catch (error) {
        await this.memory.failStep(this.sessionId, stepIndex, error);
        results.push({ action: step.action, description: step.description, success: false, error: error.message });
        console.log(`    ✗ Failed: ${error.message}`);
      }
    }
    return results;
  }

  async _executeAction(action, params) {
    const tool = this.tools[action];
    if (!tool) throw new Error(`Unknown action: ${action}`);
    return await tool(params);
  }

  /* ---------- REFLECT ---------- */
  async _reflect(goal, plan, executionResults, context) {
    const executionSummary = executionResults
      .map((r) => {
        const outcome = r.success
          ? `✓ ${String(r.result ?? "done").slice(0, 300)}`
          : `✗ ${r.error}`;
        return `[${r.action}] ${r.description}: ${outcome}`;
      })
      .join("\n");

    const system = `You are the reflection module of an autonomous agent.
Analyze the execution results and decide whether the goal is COMPLETE.
Be strict: only mark complete when the results genuinely satisfy the goal.`;

    const user = `Goal: "${goal}"

Plan reasoning: ${plan.reasoning}

Execution results:
${executionSummary}

Current knowledge:
${context?.accumulated_knowledge || "(none)"}`;

    return await this._llm(system, user, REFLECT_SCHEMA);
  }

  /* ---------- LLM plumbing ---------- */
  async _llm(systemPrompt, userMessage, schema) {
    if (this._llmCall) return await this._llmCall(systemPrompt, userMessage, { schema });

    if (!this.apiKey) {
      const err = new Error("ANTHROPIC_API_KEY тохируулаагүй байна — .env файлаа шалгана уу");
      err.fatal = true;
      throw err;
    }
    this._client ??= new Anthropic({ apiKey: this.apiKey });

    const t0 = Date.now();
    const response = await this._client.messages.create({
      model: this.model,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: systemPrompt,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: userMessage }],
    });
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    log(`Claude ${this.model} · ${sec}s · in ${response.usage.input_tokens} / out ${response.usage.output_tokens} tokens`);

    if (response.stop_reason === "refusal") {
      throw new Error("Claude хүсэлтийг аюулгүй байдлын үүднээс гүйцэтгэхээс татгалзлаа");
    }
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) throw new Error("Claude хариунд text блок алга");
    return JSON.parse(textBlock.text);
  }

  _isFatal(error) {
    return (
      error?.fatal === true ||
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    );
  }
}

export default AgenticLoop;
