/**
 * Shared memory module — Firebase Realtime Database.
 *
 * Бүх агент импортлон ашигладаг санах ойн давхарга.
 * Firebase тохируулагдаагүй (эсвэл холбогдож чадаагүй) үед бүх функц
 * найдвартайгаар no-op болж null/undefined буцаана — агент санах ойгүйгээр
 * хэвийн ажиллана. Firebase-ийн бүх үйлдэл try-catch дотор бөгөөд алдаа гарвал
 * агентыг унагахгүй, зөвхөн анхааруулга бичнэ.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

let app = null;
let db = null; // root reference
let ServerValue = null;
let getDatabaseFn = null;
let deleteAppFn = null;
let enabled = false;
let logger = () => {};

/* ---------- helpers ---------- */
export function setLogger(fn) {
  if (typeof fn === "function") logger = fn;
}
export function isEnabled() {
  return enabled;
}
const nowIso = () => new Date().toISOString();
const sanitize = (v) => JSON.parse(JSON.stringify(v ?? null));
const agentRef = (id) => db.child("agents").child(id);

/**
 * Context-ийг ухаалгаар нэгтгэнэ:
 *  - массив талбар (files_created, decisions_made) → нэмээд давхардлыг арилгана
 *  - объект талбар → гүехэн merge
 *  - бусад (accumulated_knowledge, last_claude_response) → шинэ утгаар солино
 */
export function mergeContext(existing = {}, update = {}) {
  const out = { ...(existing || {}) };
  for (const [key, value] of Object.entries(update || {})) {
    if (Array.isArray(value)) {
      const prev = Array.isArray(out[key]) ? out[key] : [];
      out[key] = Array.from(new Set([...prev, ...value]));
    } else if (value && typeof value === "object") {
      out[key] = { ...(out[key] && typeof out[key] === "object" ? out[key] : {}), ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/* ---------- init / teardown ---------- */
export async function initFirebase(serviceAccountPath, databaseURL) {
  if (enabled) return true; // idempotent
  if (!serviceAccountPath || !databaseURL) {
    throw new Error("initFirebase-д serviceAccountPath болон databaseURL шаардлагатай");
  }
  // firebase-admin v13+ modular ESM entry points (namespaced default export
  // doesn't expose `credential`/`apps` under ESM interop).
  let initializeApp;
  let cert;
  let getApps;
  let getApp;
  let getDatabase;
  try {
    ({ initializeApp, cert, getApps, getApp, deleteApp: deleteAppFn } = await import("firebase-admin/app"));
    ({ getDatabase, ServerValue } = await import("firebase-admin/database"));
    getDatabaseFn = getDatabase;
  } catch (e) {
    throw new Error(`firebase-admin олдсонгүй — "npm install firebase-admin" ажиллуулна уу (${e.message})`);
  }
  let serviceAccount;
  const full = path.resolve(process.cwd(), serviceAccountPath);
  try {
    serviceAccount = JSON.parse(await readFile(full, "utf8"));
  } catch (e) {
    throw new Error(`Service account JSON уншиж чадсангүй "${serviceAccountPath}": ${e.message}`);
  }
  try {
    app = getApps().length ? getApp() : initializeApp({ credential: cert(serviceAccount), databaseURL });
    db = getDatabase(app).ref();
    enabled = true;
    return true;
  } catch (e) {
    throw new Error(`Firebase холбогдож чадсангүй: ${e.message}`);
  }
}

/** .env-ийн FIREBASE_* хувьсагчаас автоматаар холбоно. Тохируулаагүй бол no-op. */
export async function initFromEnv({ log } = {}) {
  if (log) setLogger(log);
  const url = process.env.FIREBASE_DATABASE_URL;
  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!url || !keyPath) {
    logger("⚠️  Firebase not configured — running without memory");
    enabled = false;
    return false;
  }
  try {
    await initFirebase(keyPath, url);
    logger("💾 Firebase холбогдлоо — санах ой идэвхтэй");
    return true;
  } catch (e) {
    logger(`⚠️  Firebase холбогдож чадсангүй — санах ойгүй үргэлжлүүлнэ (${e.message})`);
    enabled = false;
    return false;
  }
}

/** Firebase холболтыг хааж процессыг цэвэрхэн гаргана. */
export async function shutdown() {
  if (!enabled || !app) {
    enabled = false;
    return;
  }
  try {
    try {
      getDatabaseFn?.(app).goOffline();
    } catch {
      /* ignore */
    }
    if (deleteAppFn) await deleteAppFn(app);
  } catch (e) {
    logger(`⚠️  Firebase-ийг хаах үед алдаа: ${e.message}`);
  } finally {
    enabled = false;
    app = null;
    db = null;
  }
}

/* ---------- sessions ---------- */
export async function createSession(goal, agentType) {
  if (!enabled) return null;
  const id = `agent_session_${randomUUID()}`;
  const session = {
    id,
    created_at: nowIso(),
    goal: goal ?? "",
    agent_type: agentType ?? "unknown",
    status: "running",
    current_step: 0,
    total_steps: 0,
    steps: [],
    context: {
      accumulated_knowledge: "",
      files_created: [],
      decisions_made: [],
      last_claude_response: "",
    },
    metadata: {
      total_tokens: 0,
      total_api_calls: 0,
      total_duration_ms: 0,
      errors_count: 0,
    },
  };
  try {
    await agentRef(id).set(sanitize(session));
    logger(`💾 Firebase: session үүсгэв (…${id.slice(-12)})`);
    return id;
  } catch (e) {
    logger(`⚠️  Session үүсгэж чадсангүй: ${e.message}`);
    return null;
  }
}

export async function addSteps(sessionId, stepsArray) {
  if (!enabled || !sessionId) return null;
  const steps = (stepsArray || []).map((s, i) => ({
    index: i,
    action: s.action ?? "step",
    description: s.description ?? "",
    status: "pending",
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    duration_ms: null,
    tokens_used: 0,
  }));
  try {
    await agentRef(sessionId).update({ steps: sanitize(steps), total_steps: steps.length });
    logger(`💾 Firebase: ${steps.length} алхам төлөвлөв`);
    return steps.length;
  } catch (e) {
    logger(`⚠️  addSteps алдаа: ${e.message}`);
    return null;
  }
}

export async function startStep(sessionId, stepIndex) {
  if (!enabled || !sessionId) return;
  try {
    await agentRef(sessionId).child("steps").child(String(stepIndex)).update({
      status: "running",
      started_at: nowIso(),
    });
    await agentRef(sessionId).update({ status: "running", current_step: stepIndex });
    logger(`💾 Firebase: Step ${stepIndex + 1} started`);
  } catch (e) {
    logger(`⚠️  startStep алдаа: ${e.message}`);
  }
}

export async function completeStep(sessionId, stepIndex, result, tokensUsed = 0) {
  if (!enabled || !sessionId) return;
  try {
    const stepRef = agentRef(sessionId).child("steps").child(String(stepIndex));
    const snap = await stepRef.once("value");
    const step = snap.val() || {};
    const startedAt = step.started_at ? Date.parse(step.started_at) : Date.now();
    const duration = Math.max(0, Date.now() - startedAt);
    await stepRef.update({
      status: "done",
      completed_at: nowIso(),
      result: result ?? null,
      duration_ms: duration,
      tokens_used: tokensUsed || 0,
    });
    const updates = {
      current_step: stepIndex + 1,
      "metadata/total_tokens": ServerValue.increment(tokensUsed || 0),
    };
    if (tokensUsed > 0) updates["metadata/total_api_calls"] = ServerValue.increment(1);
    await agentRef(sessionId).update(updates);
    logger(`💾 Firebase: Step ${stepIndex + 1} completed (${(duration / 1000).toFixed(1)}s)`);
  } catch (e) {
    logger(`⚠️  completeStep алдаа: ${e.message}`);
  }
}

export async function failStep(sessionId, stepIndex, error) {
  if (!enabled || !sessionId) return;
  const msg = typeof error === "string" ? error : error?.message ?? String(error);
  try {
    const stepRef = agentRef(sessionId).child("steps").child(String(stepIndex));
    const snap = await stepRef.once("value");
    const step = snap.val() || {};
    const startedAt = step.started_at ? Date.parse(step.started_at) : Date.now();
    await stepRef.update({
      status: "failed",
      completed_at: nowIso(),
      error: msg,
      duration_ms: Math.max(0, Date.now() - startedAt),
    });
    await agentRef(sessionId).update({
      status: "failed",
      "metadata/errors_count": ServerValue.increment(1),
    });
    logger(`💾 Firebase: Step ${stepIndex + 1} failed — ${msg}`);
  } catch (e) {
    logger(`⚠️  failStep алдаа: ${e.message}`);
  }
}

/** Алхмуудаас status === "pending" эхнийхийг буцаана, байхгүй бол null (бүгд дууссан). */
export async function getCurrentStep(sessionId) {
  if (!enabled || !sessionId) return null;
  try {
    const snap = await agentRef(sessionId).child("steps").once("value");
    const raw = snap.val() || [];
    const steps = Array.isArray(raw) ? raw : Object.values(raw);
    return steps.find((s) => s && s.status === "pending") || null;
  } catch (e) {
    logger(`⚠️  getCurrentStep алдаа: ${e.message}`);
    return null;
  }
}

/** Шинэ context-ийг байгаа дээр нь merge хийнэ — агентын "санах ой". */
export async function updateContext(sessionId, contextUpdate) {
  if (!enabled || !sessionId) return null;
  try {
    const ref = agentRef(sessionId).child("context");
    const snap = await ref.once("value");
    const merged = mergeContext(snap.val() || {}, contextUpdate || {});
    await ref.set(sanitize(merged));
    const knowledge = typeof merged.accumulated_knowledge === "string" ? merged.accumulated_knowledge : "";
    const preview = knowledge.slice(0, 60);
    logger(`🧠 Context updated${preview ? `: "${preview}${knowledge.length > 60 ? "…" : ""}"` : ""}`);
    return merged;
  } catch (e) {
    logger(`⚠️  updateContext алдаа: ${e.message}`);
    return null;
  }
}

/** Бүх context объектыг буцаана — агент алхам бүрийн өмнө уншина. */
export async function getContext(sessionId) {
  if (!enabled || !sessionId) return null;
  try {
    const snap = await agentRef(sessionId).child("context").once("value");
    return snap.val() || {};
  } catch (e) {
    logger(`⚠️  getContext алдаа: ${e.message}`);
    return null;
  }
}

export async function getSession(sessionId) {
  if (!enabled || !sessionId) return null;
  try {
    const snap = await agentRef(sessionId).once("value");
    return snap.val() || null;
  } catch (e) {
    logger(`⚠️  getSession алдаа: ${e.message}`);
    return null;
  }
}

export async function completeSession(sessionId, summary) {
  if (!enabled || !sessionId) return;
  try {
    const session = await getSession(sessionId);
    if (!session) return;
    const created = session.created_at ? Date.parse(session.created_at) : Date.now();
    const totalDuration = Math.max(0, Date.now() - created);
    await agentRef(sessionId).update({
      status: "completed",
      completed_at: nowIso(),
      "metadata/total_duration_ms": totalDuration,
    });
    const historyId = `history_${randomUUID()}`;
    await db.child("agent_history").child(historyId).set(
      sanitize({
        agent_id: sessionId,
        agent_type: session.agent_type ?? "unknown",
        goal: session.goal ?? "",
        status: "completed",
        completed_at: nowIso(),
        summary: summary ?? "",
      }),
    );
    logger(`💾 Firebase: session completed → agent_history (${(totalDuration / 1000).toFixed(1)}s)`);
  } catch (e) {
    logger(`⚠️  completeSession алдаа: ${e.message}`);
  }
}

/** Алхмуудын дундуур унасан session-ийг "failed" болгоно (алхам эхлээгүй үеийн алдаанд). */
export async function failSession(sessionId, error) {
  if (!enabled || !sessionId) return;
  const msg = typeof error === "string" ? error : error?.message ?? String(error);
  try {
    const session = await getSession(sessionId);
    if (session && session.status === "failed") return; // failStep аль хэдийн тэмдэглэсэн
    await agentRef(sessionId).update({ status: "failed", last_error: msg });
  } catch (e) {
    logger(`⚠️  failSession алдаа: ${e.message}`);
  }
}

/** Session-ийг олж current_step-ийг нь буцаана — crash-аас сэргээхэд ашиглана. */
export async function resumeSession(sessionId) {
  if (!enabled || !sessionId) return null;
  try {
    const session = await getSession(sessionId);
    if (!session) {
      logger(`⚠️  Resume: session олдсонгүй (${sessionId})`);
      return null;
    }
    await agentRef(sessionId).update({ status: "running" });
    const current = await getCurrentStep(sessionId);
    logger(`💾 Firebase: session сэргээв — алхам ${session.current_step ?? 0}/${session.total_steps ?? 0}`);
    return { ...session, current, resumed_at: nowIso() };
  } catch (e) {
    logger(`⚠️  resumeSession алдаа: ${e.message}`);
    return null;
  }
}

/** Агентын төрөл ба/эсвэл статусаар шүүж session-үүдийг жагсаана (dashboard-д). */
export async function listSessions(agentType = null, status = null) {
  if (!enabled) return [];
  try {
    const snap = await db.child("agents").once("value");
    let sessions = Object.values(snap.val() || {});
    if (agentType) sessions = sessions.filter((s) => s?.agent_type === agentType);
    if (status) sessions = sessions.filter((s) => s?.status === status);
    return sessions;
  } catch (e) {
    logger(`⚠️  listSessions алдаа: ${e.message}`);
    return [];
  }
}

/** Session болон түүнтэй холбоотой history-г устгана (гол төлөв тестийн цэвэрлэгээнд). */
export async function removeSession(sessionId) {
  if (!enabled || !sessionId) return;
  try {
    await agentRef(sessionId).remove();
    const snap = await db.child("agent_history").once("value");
    const history = snap.val() || {};
    const removals = {};
    for (const [hid, entry] of Object.entries(history)) {
      if (entry && entry.agent_id === sessionId) removals[hid] = null;
    }
    if (Object.keys(removals).length) await db.child("agent_history").update(removals);
  } catch (e) {
    logger(`⚠️  removeSession алдаа: ${e.message}`);
  }
}
