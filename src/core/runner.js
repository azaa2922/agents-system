/**
 * Step runner — санах ойд суурилсан алхмуудын гүйцэтгэлийг зохион байгуулна.
 *
 * Агент бүр өөрийн "steps" массивыг бүтээж (step бүр { action, description, run }),
 * runAgent-д дамжуулна. runAgent нь session үүсгэх/сэргээх, алхам бүрийг эхлүүлэх/
 * дуусгах, context нэгтгэх, session хаах зэрэг санах ойн бүх амьдралын мөчлөгийг
 * хариуцна. Firebase унтарсан үед бүх санах ойн дуудлага no-op болж, локал context
 * дээр тулгуурлан алхмууд яг адилхан ажиллана.
 */
import * as memory from "./memory.js";

/**
 * @param {string|null} sessionId
 * @param {Array<{action:string, description:string, run:Function}>} steps
 *   step.run(context) → string | { result?, context?, tokens? } | void
 * @param {{ log?: Function, resume?: boolean }} opts
 * @returns {Promise<object>} нэгтгэсэн context
 */
export async function runSteps(sessionId, steps, { log = () => {}, resume = false } = {}) {
  const context = {
    accumulated_knowledge: "",
    files_created: [],
    decisions_made: [],
    last_gemini_response: "",
  };

  // Шинэ ажиллагаанд алхмуудыг бүртгэнэ; resume үед аль хэдийн байгаа.
  if (!resume) {
    await memory.addSteps(sessionId, steps.map((s) => ({ action: s.action, description: s.description })));
  }

  // Resume: дууссан алхмуудыг тодорхойлж, хадгалсан context-ийг сэргээнэ.
  const doneSet = new Set();
  if (sessionId && resume) {
    const session = await memory.getSession(sessionId);
    for (const st of Object.values(session?.steps || {})) {
      if (st && st.status === "done") doneSet.add(st.index);
    }
    const saved = await memory.getContext(sessionId);
    if (saved) Object.assign(context, saved);
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (doneSet.has(i)) {
      log(`⏭  Step ${i + 1}/${steps.length} (${step.action}) аль хэдийн дууссан — алгасав`);
      continue;
    }

    await memory.startStep(sessionId, i);
    try {
      // Агент алхам бүрийн өмнө context-оо уншиж, юу мэддэгээ сэргээнэ.
      if (sessionId) {
        const fresh = await memory.getContext(sessionId);
        if (fresh) Object.assign(context, fresh);
      }

      const out = (await step.run(context)) || {};
      const result = typeof out === "string" ? out : out.result ?? null;
      const ctxUpdate = typeof out === "object" && out !== null ? out.context || null : null;
      const tokens = typeof out === "object" && out !== null ? out.tokens || 0 : 0;

      if (ctxUpdate && Object.keys(ctxUpdate).length) {
        Object.assign(context, memory.mergeContext(context, ctxUpdate));
        await memory.updateContext(sessionId, ctxUpdate);
      }
      await memory.completeStep(sessionId, i, result, tokens);
    } catch (err) {
      await memory.failStep(sessionId, i, err?.message ?? String(err));
      throw err;
    }
  }
  return context;
}

/**
 * Агентыг санах ойн бүрэн мөчлөгтэйгээр ажиллуулна.
 * @param {{
 *   agentType: string,
 *   goal: string,
 *   log?: Function,
 *   resume?: string|null,
 *   buildSteps: (ctx: { sessionId: string|null, resumed: object|null }) => Promise<Array>
 * }} params
 * @returns {Promise<object>} нэгтгэсэн context (агентын save алхам context.summary,
 *   context.result_path зэргийг тохируулж болно)
 */
export async function runAgent({ agentType, goal, log = () => {}, resume = null, buildSteps }) {
  await memory.initFromEnv({ log });

  let sessionId = null;
  let resumed = null;
  if (resume) {
    resumed = await memory.resumeSession(resume);
    if (resumed) sessionId = resume;
    else log(`⚠️  Resume ID олдсонгүй (${resume}) — шинэ session эхлүүлнэ`);
  }
  if (!sessionId) sessionId = await memory.createSession(goal, agentType);
  if (sessionId) log(`🆔 Session: ${sessionId}`);

  try {
    const steps = await buildSteps({ sessionId, resumed });
    const context = await runSteps(sessionId, steps, { log, resume: Boolean(resumed) });
    await memory.completeSession(sessionId, context.summary || `${agentType} дууслаа`);
    return context;
  } catch (err) {
    await memory.failSession(sessionId, err?.message ?? String(err));
    throw err;
  } finally {
    await memory.shutdown();
  }
}
