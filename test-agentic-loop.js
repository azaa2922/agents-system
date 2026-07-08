#!/usr/bin/env node
/**
 * test-agentic-loop.js — Agentic loop validation suite
 *
 * Runs fully offline: the LLM is mocked via AgenticLoop's injectable
 * `llmCall`, so no API keys are needed. Covers:
 *   1. Module imports (core + all agent tool registries)
 *   2. Memory module (sessions, steps, context merge, iteration tracking)
 *   3. Tool registry execution
 *   4. Loop execution (plan → execute → reflect until complete)
 *   5. Error recovery (failed tools, max iterations, fatal aborts)
 *   6. Firebase tracking (graceful in-memory fallback without config)
 *
 * Run: node test-agentic-loop.js   (or: npm run test:agentic)
 */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

/* Mock LLM: dequeues scripted responses. Distinguishes plan vs reflect
 * calls by the schema shape the loop passes in. */
function mockLlm(planQueue, reflectQueue) {
  const calls = { plan: 0, reflect: 0 };
  const fn = async (_system, _user, { schema }) => {
    if (schema?.properties?.steps) {
      calls.plan++;
      const next = planQueue.shift();
      if (!next) throw new Error("mockLlm: plan queue exhausted");
      return next;
    }
    if (schema?.properties?.isGoalComplete) {
      calls.reflect++;
      const next = reflectQueue.shift();
      if (!next) throw new Error("mockLlm: reflect queue exhausted");
      return next;
    }
    throw new Error("mockLlm: unrecognized schema");
  };
  fn.calls = calls;
  return fn;
}

const reflectionDone = (reason) => ({
  analysis: "analyzed",
  isGoalComplete: true,
  completionReason: reason,
  nextAction: "none",
  updatedKnowledge: "learned things",
});
const reflectionContinue = (next) => ({
  analysis: "partial progress",
  isGoalComplete: false,
  completionReason: "not yet",
  nextAction: next,
  updatedKnowledge: "some knowledge",
});

console.log("🧪 Agentic Loop Test Suite");

/* ─────────────────── 1. Imports ─────────────────── */
section("1. Module imports");

const { AgenticLoop } = await import("./src/core/agentic-loop.js");
const memory = await import("./src/core/memory.js");
check("AgenticLoop class importable", typeof AgenticLoop === "function");
check("memory module importable", typeof memory.createSession === "function");

const registryExpectations = {
  "search-agent": ["search", "think", "write"],
  "code-agent": ["code", "file", "write", "think"],
  "data-agent": ["data", "file", "write", "think"],
  "file-agent": ["file", "write", "think"],
  "writer-agent": ["write", "file", "think"],
  "db-agent": ["db", "file", "write", "think"],
};
const registries = {};
for (const [agent, expectedTools] of Object.entries(registryExpectations)) {
  try {
    const mod = await import(`./src/${agent}/tool-registry.js`);
    const registry = mod.createToolRegistry();
    registries[agent] = registry;
    const keys = Object.keys(registry);
    const missing = expectedTools.filter((t) => !keys.includes(t));
    check(
      `${agent} tool registry maps [${expectedTools.join(", ")}]`,
      missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : "",
    );
    check(
      `${agent} tools are async functions`,
      keys.every((k) => typeof registry[k] === "function"),
    );
  } catch (err) {
    check(`${agent} tool registry importable`, false, err.message);
  }
}

/* ─────────────────── 2. Firebase / fallback ─────────────────── */
section("2. Firebase tracking (graceful fallback)");

const mode = await memory.initFirebase();
check("initFirebase resolves without crashing", mode === "firebase" || mode === "memory");
if (mode === "memory") {
  check("no Firebase config → in-memory fallback active", memory.isFirebaseEnabled() === false);
  console.log("  ℹ Firebase тохируулаагүй тул in-memory горимд тест хийж байна (агентууд ижил ажиллана)");
} else {
  check("Firebase connected", memory.isFirebaseEnabled() === true);
}

/* ─────────────────── 3. Memory module ─────────────────── */
section("3. Memory module");

const sid = await memory.createSession("test-agent", "test goal");
check("createSession returns sessionId", typeof sid === "string" && sid.startsWith("test-agent_"));

const snapshot0 = memory.getSession(sid);
check("session metadata initialized", snapshot0.metadata.goal === "test goal" && snapshot0.metadata.status === "running");

const offset = await memory.addSteps(sid, [
  { action: "search", description: "step one", params: { query: "q" } },
  { action: "write", description: "step two", params: {} },
]);
check("addSteps returns offset 0 for first batch", offset === 0);
check("steps stored as pending", memory.getSession(sid).steps.every((s) => s.status === "pending"));

await memory.startStep(sid, 0);
check("startStep marks running", memory.getSession(sid).steps[0].status === "running");

await memory.completeStep(sid, 0, "result-1", 42);
const afterComplete = memory.getSession(sid);
check("completeStep marks done with result", afterComplete.steps[0].status === "done" && afterComplete.steps[0].result === "result-1");
check("completeStep accumulates tokens", afterComplete.metadata.total_tokens === 42);

await memory.failStep(sid, 1, new Error("boom"));
check("failStep marks failed with error", memory.getSession(sid).steps[1].status === "failed" && memory.getSession(sid).steps[1].error === "boom");

// mergeContext semantics
const merged = memory.mergeContext(
  { a: 1, list: ["x"], nested: { keep: true, val: 1 } },
  { a: 2, list: ["x", "y"], nested: { val: 2 }, fresh: "new" },
);
check("mergeContext: scalars overwrite", merged.a === 2);
check("mergeContext: arrays dedupe", merged.list.length === 2 && merged.list.includes("y"));
check("mergeContext: nested objects merge", merged.nested.keep === true && merged.nested.val === 2);
check("mergeContext: new keys added", merged.fresh === "new");

await memory.updateContext(sid, { accumulated_knowledge: "k1", decisions_made: ["d1"] });
await memory.updateContext(sid, { accumulated_knowledge: "k2", decisions_made: ["d1", "d2"] });
const ctx = await memory.getContext(sid);
check("updateContext: knowledge overwrites", ctx.accumulated_knowledge === "k2");
check("updateContext: decisions deduplicated", ctx.decisions_made.length === 2);

await memory.recordIteration(sid, 3);
check("recordIteration updates metadata", memory.getSession(sid).metadata.iterations === 3);

await memory.completeSession(sid, { success: true, completionReason: "done!", iterations: 3 });
const doneMeta = memory.getSession(sid).metadata;
check("completeSession sets status done", doneMeta.status === "done");
check("completeSession stores summary", doneMeta.summary.completionReason === "done!");

const resumed = await memory.resumeSession(sid);
check("resumeSession returns completed steps + context", resumed.completedSteps.length === 1 && resumed.context.accumulated_knowledge === "k2");

/* ─────────────────── 4. Tool registry execution ─────────────────── */
section("4. Tool registry execution");

const echoRegistry = {
  echo: async (params) => `echo:${params.msg}`,
  boom: async () => {
    throw new Error("tool exploded");
  },
};
check("registry tool executes with params", (await echoRegistry.echo({ msg: "hi" })) === "echo:hi");

try {
  new AgenticLoop("x", memory, null, {});
  check("empty registry rejected", false);
} catch {
  check("empty registry rejected", true);
}

/* ─────────────────── 5. Loop execution (mock LLM) ─────────────────── */
section("5. Loop execution — plan → execute → reflect");

{
  const sid5 = await memory.createSession("loop-test", "echo twice");
  const llm = mockLlm(
    [
      {
        reasoning: "need two echoes",
        steps: [
          { action: "echo", description: "first echo", params: '{"msg":"one"}' },
          { action: "echo", description: "second echo", params: '{"msg":"two"}' },
        ],
      },
    ],
    [reflectionDone("both echoes ran")],
  );
  const loop = new AgenticLoop(sid5, memory, null, echoRegistry, { llmCall: llm });
  const result = await loop.run("echo twice", 5);

  check("loop completes successfully", result.success === true);
  check("loop reports 1 iteration", result.iterations === 1);
  check("completion reason from reflection", result.result === "both echoes ran");

  const snap = memory.getSession(sid5);
  check("steps recorded and done", snap.steps.length === 2 && snap.steps.every((s) => s.status === "done"));
  check("step result stored", snap.steps[0].result === "echo:one");
  check("params JSON-string decoded before execution", snap.steps[1].result === "echo:two");
  check("iterations tracked in session metadata", snap.metadata.iterations === 1);
  check("session marked done", snap.metadata.status === "done");
  check("context accumulated knowledge", (await memory.getContext(sid5)).accumulated_knowledge === "learned things");
}

/* multi-iteration: reflection says continue, then complete */
{
  const sid5b = await memory.createSession("loop-test", "two rounds");
  const llm = mockLlm(
    [
      { reasoning: "round 1", steps: [{ action: "echo", description: "r1", params: '{"msg":"r1"}' }] },
      { reasoning: "round 2", steps: [{ action: "echo", description: "r2", params: '{"msg":"r2"}' }] },
    ],
    [reflectionContinue("do round 2"), reflectionDone("all rounds done")],
  );
  const loop = new AgenticLoop(sid5b, memory, null, echoRegistry, { llmCall: llm });
  const result = await loop.run("two rounds", 5);

  check("multi-iteration loop completes", result.success === true);
  check("iterations increment across rounds", result.iterations === 2);
  check("metadata.iterations matches", memory.getSession(sid5b).metadata.iterations === 2);
  check("planner called per iteration", llm.calls.plan === 2 && llm.calls.reflect === 2);
}

/* empty plan = already complete */
{
  const sid5c = await memory.createSession("loop-test", "nothing to do");
  const llm = mockLlm([{ reasoning: "goal already satisfied", steps: [] }], []);
  const loop = new AgenticLoop(sid5c, memory, null, echoRegistry, { llmCall: llm });
  const result = await loop.run("nothing to do", 5);
  check("empty plan → complete", result.success === true && result.result === "goal already satisfied");
}

/* ─────────────────── 6. Error recovery ─────────────────── */
section("6. Error recovery");

/* failed tool → recorded, loop continues and still succeeds */
{
  const sid6 = await memory.createSession("recovery-test", "survive a tool failure");
  const llm = mockLlm(
    [
      { reasoning: "try the flaky tool", steps: [{ action: "boom", description: "will fail", params: "{}" }] },
      { reasoning: "fall back to echo", steps: [{ action: "echo", description: "recovers", params: '{"msg":"ok"}' }] },
    ],
    [reflectionContinue("boom failed, try echo"), reflectionDone("recovered")],
  );
  const loop = new AgenticLoop(sid6, memory, null, echoRegistry, { llmCall: llm });
  const result = await loop.run("survive a tool failure", 5);

  const snap = memory.getSession(sid6);
  check("failed tool recorded as failed step", snap.steps[0].status === "failed" && snap.steps[0].error === "tool exploded");
  check("loop recovers after tool failure", result.success === true && result.iterations === 2);
}

/* unknown action from planner → step fails, loop keeps going */
{
  const sid6b = await memory.createSession("recovery-test", "unknown action");
  const llm = mockLlm(
    [{ reasoning: "hallucinated tool", steps: [{ action: "echo", description: "ok", params: '{"msg":"x"}' }] }],
    [reflectionDone("fine")],
  );
  const loop = new AgenticLoop(sid6b, memory, null, echoRegistry, { llmCall: llm });
  const badStep = await loop._executeSteps(
    [{ action: "no_such_tool", description: "bad", params: {} }],
    await memory.addSteps(sid6b, [{ action: "no_such_tool", description: "bad", params: {} }]),
  );
  check("unknown action fails the step, not the process", badStep[0].success === false && /Unknown action/.test(badStep[0].error));
  await loop.run("unknown action", 5); // finish the session cleanly
}

/* max iterations reached → success false, session failed */
{
  const sid6c = await memory.createSession("recovery-test", "never done");
  const plans = Array.from({ length: 3 }, (_, i) => ({
    reasoning: `round ${i}`,
    steps: [{ action: "echo", description: `r${i}`, params: '{"msg":"x"}' }],
  }));
  const reflections = Array.from({ length: 3 }, () => reflectionContinue("keep going"));
  const loop = new AgenticLoop(sid6c, memory, null, echoRegistry, { llmCall: mockLlm(plans, reflections) });
  const result = await loop.run("never done", 2);
  check("max iterations stops the loop", result.success === false && result.iterations === 2);
  check("result explains max iterations", result.result === "Max iterations reached");
  check("session marked failed", memory.getSession(sid6c).metadata.status === "failed");
}

/* fatal LLM error (e.g. missing API key) aborts instead of spinning */
{
  const sid6d = await memory.createSession("recovery-test", "fatal");
  const fatalLlm = async () => {
    const err = new Error("no api key");
    err.fatal = true;
    throw err;
  };
  const loop = new AgenticLoop(sid6d, memory, null, echoRegistry, { llmCall: fatalLlm });
  let threw = false;
  try {
    await loop.run("fatal", 5);
  } catch {
    threw = true;
  }
  check("fatal error aborts the loop", threw === true);
  check("fatal error marks session failed", memory.getSession(sid6d).metadata.status === "failed");
  check("fatal error message stored", memory.getSession(sid6d).metadata.summary.error === "no api key");
}

/* transient LLM errors → retries, then hard-stops after 3 consecutive failures */
{
  const sid6e = await memory.createSession("recovery-test", "flaky llm");
  const flakyLlm = async () => {
    throw new Error("transient parse error");
  };
  const loop = new AgenticLoop(sid6e, memory, null, echoRegistry, { llmCall: flakyLlm });
  let message = "";
  try {
    await loop.run("flaky", 10);
  } catch (err) {
    message = err.message;
  }
  check("3 consecutive LLM failures stop the loop early", /дараалсан алдаа/.test(message));
  check("error iterations were tracked", memory.getSession(sid6e).metadata.iterations === 3);
}

/* ─────────────────── 7. Orchestrator ─────────────────── */
section("7. Orchestrator — coordinates all 6 agents");

const orch = await import("./src/core/orchestrator.js");
const AGENT_NAMES = ["search", "code", "data", "file", "write", "db"];

check("AGENTS roster has all 6 specialist agents", AGENT_NAMES.every((a) => a in orch.AGENTS) && Object.keys(orch.AGENTS).length === 6);
check(
  "each agent has createRegistry + description",
  AGENT_NAMES.every(
    (a) => typeof orch.AGENTS[a].createRegistry === "function" && typeof orch.AGENTS[a].description === "string",
  ),
);
check(
  "ORCHESTRATOR_TOOL_DESCRIPTIONS covers every agent",
  AGENT_NAMES.every((a) => typeof orch.ORCHESTRATOR_TOOL_DESCRIPTIONS[a] === "string" && orch.ORCHESTRATOR_TOOL_DESCRIPTIONS[a].length > 0),
);

/* Registry with injected fake child loops → no real API/agent calls */
{
  const parentSid = await memory.createSession("orchestrator", "big goal");
  const registry = orch.createOrchestratorRegistry({
    memory,
    apiKey: null,
    parentSessionId: parentSid,
    maxSubIterations: 5,
    makeLoop: (agentName, childSessionId, subGoal) => ({
      run: async () => ({ success: true, result: `${agentName} handled: ${subGoal}`, iterations: 2 }),
    }),
  });

  check("registry exposes one tool per agent", AGENT_NAMES.every((a) => typeof registry[a] === "function"));

  const codeResult = await registry.code({ goal: "scaffold a React app" });
  check("delegation returns a summary string", /code agent/.test(codeResult) && /completed/.test(codeResult));

  const parent = memory.getSession(parentSid);
  check("child session created + linked to parent", Array.isArray(parent.children) && parent.children.length === 1);
  const childSid = parent.children[0];
  check("child records parent session id", memory.getSession(childSid).metadata.parent === parentSid);
  check("child agentType is the routed agent", memory.getSession(childSid).metadata.agentType === "code");
  check("parent context records the delegation", (await memory.getContext(parentSid)).delegations.some((d) => d.agent === "code" && d.success === true));

  let threwNoGoal = false;
  try {
    await registry.search({});
  } catch {
    threwNoGoal = true;
  }
  check("delegation requires a 'goal' param", threwNoGoal === true);

  let threwUnknown = false;
  try {
    orch.createOrchestratorRegistry({ memory, parentSessionId: parentSid, agents: ["nope"] });
  } catch {
    threwUnknown = true;
  }
  check("unknown agent name rejected", threwUnknown === true);
}

/* Full orchestrator loop: mock planner routes to 2 agents, child loops stubbed */
{
  const orchGoal = "research frameworks then scaffold an app";
  const sid = await memory.createSession("orchestrator", orchGoal);
  const registry = orch.createOrchestratorRegistry({
    memory,
    apiKey: null,
    parentSessionId: sid,
    makeLoop: (agentName) => ({
      run: async () => ({ success: true, result: `${agentName} done`, iterations: 1 }),
    }),
  });
  const llm = mockLlm(
    [
      {
        reasoning: "search, then code",
        steps: [
          { action: "search", description: "research frameworks", params: '{"goal":"find top React frameworks"}' },
          { action: "code", description: "scaffold app", params: '{"goal":"scaffold a React starter"}' },
        ],
      },
    ],
    [reflectionDone("both agents delivered")],
  );
  const loop = new AgenticLoop(sid, memory, null, registry, {
    llmCall: llm,
    toolDescriptions: orch.ORCHESTRATOR_TOOL_DESCRIPTIONS,
  });
  const result = await loop.run(orchGoal, 5);

  check("orchestrator loop completes across agents", result.success === true && result.iterations === 1);
  check("orchestrator spawned 2 child sessions", (memory.getSession(sid).children || []).length === 2);
  check("both delegations recorded on parent", (await memory.getContext(sid)).delegations.length === 2);
  check("child sessions use routed agent types", (() => {
    const kinds = memory.getSession(sid).children.map((c) => memory.getSession(c).metadata.agentType);
    return kinds.includes("search") && kinds.includes("code");
  })());
}

/* Orchestrator planner sees agent descriptions (routing context) */
{
  const sid = await memory.createSession("orchestrator", "descr check");
  let capturedSystem = "";
  const registry = orch.createOrchestratorRegistry({
    memory,
    parentSessionId: sid,
    makeLoop: () => ({ run: async () => ({ success: true, result: "ok", iterations: 1 }) }),
  });
  const llm = async (system, _user, { schema }) => {
    if (schema?.properties?.steps) {
      capturedSystem = system;
      return { reasoning: "done", steps: [] };
    }
    return reflectionDone("n/a");
  };
  const loop = new AgenticLoop(sid, memory, null, registry, {
    llmCall: llm,
    toolDescriptions: orch.ORCHESTRATOR_TOOL_DESCRIPTIONS,
  });
  await loop.run("descr check", 2);
  check("planner prompt embeds agent descriptions", /Web search/.test(capturedSystem) && /database schemas/.test(capturedSystem));
}

/* ─────────────────── Summary ─────────────────── */
console.log("\n" + "=".repeat(50));
if (failed === 0) {
  console.log(`✅ Бүх тест амжилттай — ${passed} passed`);
  console.log("\nNext steps:");
  console.log("  1. .env дотор ANTHROPIC_API_KEY, TAVILY_API_KEY тохируулна");
  console.log('  2. node src/search-agent/index.js "Find React frameworks"');
  console.log("  3. Firebase тохируулбал session тракинг автоматаар идэвхжинэ");
  process.exit(0);
} else {
  console.log(`❌ ${failed} тест унасан / ${passed} passed`);
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
