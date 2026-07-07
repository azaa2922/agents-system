/**
 * src/core/memory.js
 *
 * Session persistence for the agentic loop.
 *
 * Two modes:
 *   - Firebase RTDB mode: enabled when FIREBASE_DATABASE_URL is set and the
 *     service account file (FIREBASE_SERVICE_ACCOUNT_PATH, default
 *     ./firebase-service-account.json) exists. Every write is mirrored to
 *     sessions/<sessionId>/... in the Realtime Database.
 *   - In-memory mode (no-op fallback): used automatically when Firebase is
 *     not configured. Agents behave identically; nothing crashes.
 *
 * The in-memory store is always maintained (it is the fast source of truth
 * within a process); Firebase mirrors it for crash recovery and inspection.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

/* ---------- state ---------- */
const store = new Map(); // sessionId → { metadata, steps: [], context: {} }
let db = null; // firebase database handle (null = in-memory mode)
let initTried = false;

/* ---------- firebase (optional) ---------- */
export async function initFirebase() {
  if (initTried) return db ? "firebase" : "memory";
  initTried = true;

  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  const saPath = path.resolve(
    ROOT,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./firebase-service-account.json",
  );

  if (!databaseURL) {
    console.log("[memory] FIREBASE_DATABASE_URL тохируулаагүй — in-memory горимд ажиллана");
    return "memory";
  }
  if (!fs.existsSync(saPath)) {
    console.log(`[memory] Service account файл олдсонгүй (${saPath}) — in-memory горимд ажиллана`);
    return "memory";
  }

  try {
    const { default: admin } = await import("firebase-admin");
    const serviceAccount = JSON.parse(fs.readFileSync(saPath, "utf8"));
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL,
      });
    }
    db = admin.database();
    console.log("[memory] Firebase RTDB холбогдлоо — session тракинг идэвхтэй");
    return "firebase";
  } catch (err) {
    db = null;
    console.log(`[memory] Firebase холбогдож чадсангүй (${err.message}) — in-memory горимд ажиллана`);
    return "memory";
  }
}

export function isFirebaseEnabled() {
  return db !== null;
}

/** Fire-and-forget mirror write; Firebase errors never crash the agent. */
async function fb(refPath, method, value) {
  if (!db) return;
  try {
    const ref = db.ref(refPath);
    if (method === "set") await ref.set(value);
    else if (method === "update") await ref.update(value);
  } catch (err) {
    console.warn(`[memory] Firebase бичилт амжилтгүй (${refPath}): ${err.message}`);
  }
}

/* ---------- context merge ---------- */
/**
 * Deep merge with array deduplication:
 *   - arrays are concatenated and deduplicated (Set semantics on JSON identity)
 *   - nested objects are merged recursively
 *   - scalars overwrite
 */
export function mergeContext(existing = {}, incoming = {}) {
  const out = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const prev = out[key];
    if (Array.isArray(prev) && Array.isArray(value)) {
      const seen = new Set(prev.map((v) => JSON.stringify(v)));
      out[key] = [...prev];
      for (const v of value) {
        const sig = JSON.stringify(v);
        if (!seen.has(sig)) {
          seen.add(sig);
          out[key].push(v);
        }
      }
    } else if (
      prev && value &&
      typeof prev === "object" && typeof value === "object" &&
      !Array.isArray(prev) && !Array.isArray(value)
    ) {
      out[key] = mergeContext(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/* ---------- sessions ---------- */
export async function createSession(agentType, goal) {
  const sessionId = `${agentType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const metadata = {
    agentType,
    goal,
    timestamp_start: Date.now(),
    status: "running",
    iterations: 0,
    total_tokens: 0,
  };
  store.set(sessionId, { metadata, steps: [], context: {} });
  await fb(`sessions/${sessionId}/metadata`, "set", metadata);
  return sessionId;
}

function mustGet(sessionId) {
  const session = store.get(sessionId);
  if (!session) throw new Error(`Session олдсонгүй: ${sessionId}`);
  return session;
}

/** Append planned steps; returns the index of the first appended step. */
export async function addSteps(sessionId, steps) {
  const session = mustGet(sessionId);
  const offset = session.steps.length;
  const updates = {};
  steps.forEach((step, i) => {
    const record = {
      action: step.action,
      description: step.description ?? "",
      params: step.params ?? {},
      status: "pending",
    };
    session.steps.push(record);
    updates[offset + i] = record;
  });
  await fb(`sessions/${sessionId}/steps`, "update", updates);
  return offset;
}

export async function startStep(sessionId, stepIndex) {
  const session = mustGet(sessionId);
  const step = session.steps[stepIndex];
  if (!step) throw new Error(`Step олдсонгүй: ${sessionId}[${stepIndex}]`);
  step.status = "running";
  step.timestamp_start = Date.now();
  await fb(`sessions/${sessionId}/steps/${stepIndex}`, "update", {
    status: "running",
    timestamp_start: step.timestamp_start,
  });
  return step.timestamp_start;
}

export async function completeStep(sessionId, stepIndex, result, tokensUsed = 0) {
  const session = mustGet(sessionId);
  const step = session.steps[stepIndex];
  if (!step) throw new Error(`Step олдсонгүй: ${sessionId}[${stepIndex}]`);
  step.status = "done";
  step.result = typeof result === "string" ? result : JSON.stringify(result);
  step.timestamp_end = Date.now();
  session.metadata.total_tokens += tokensUsed;
  await fb(`sessions/${sessionId}/steps/${stepIndex}`, "update", {
    status: "done",
    result: step.result,
    timestamp_end: step.timestamp_end,
  });
  await fb(`sessions/${sessionId}/metadata`, "update", {
    total_tokens: session.metadata.total_tokens,
  });
}

export async function failStep(sessionId, stepIndex, error) {
  const session = mustGet(sessionId);
  const step = session.steps[stepIndex];
  if (!step) throw new Error(`Step олдсонгүй: ${sessionId}[${stepIndex}]`);
  step.status = "failed";
  step.error = String(error?.message ?? error);
  step.timestamp_end = Date.now();
  await fb(`sessions/${sessionId}/steps/${stepIndex}`, "update", {
    status: "failed",
    error: step.error,
    timestamp_end: step.timestamp_end,
  });
}

/* ---------- context ---------- */
export async function getContext(sessionId) {
  return mustGet(sessionId).context;
}

export async function updateContext(sessionId, patch) {
  const session = mustGet(sessionId);
  session.context = mergeContext(session.context, patch);
  await fb(`sessions/${sessionId}/context`, "set", session.context);
  return session.context;
}

/** Track loop iterations so progress is visible in Firebase while running. */
export async function recordIteration(sessionId, iteration) {
  const session = mustGet(sessionId);
  session.metadata.iterations = iteration;
  await fb(`sessions/${sessionId}/metadata`, "update", { iterations: iteration });
  return iteration;
}

/* ---------- completion / resumption ---------- */
export async function completeSession(sessionId, summary = {}) {
  const session = mustGet(sessionId);
  Object.assign(session.metadata, {
    status: summary.success ? "done" : "failed",
    timestamp_end: Date.now(),
    ...("iterations" in summary ? { iterations: summary.iterations } : {}),
    summary: {
      success: !!summary.success,
      ...(summary.completionReason ? { completionReason: summary.completionReason } : {}),
      ...(summary.reason ? { reason: summary.reason } : {}),
      ...(summary.error ? { error: summary.error } : {}),
    },
  });
  await fb(`sessions/${sessionId}/metadata`, "set", session.metadata);
  return session.metadata;
}

/**
 * Fetch a session for crash recovery: completed steps + merged context.
 * Reads Firebase when connected (survives process restarts), otherwise the
 * in-memory store.
 */
export async function resumeSession(sessionId) {
  if (db) {
    try {
      const snap = await db.ref(`sessions/${sessionId}`).get();
      if (snap.exists()) {
        const raw = snap.val();
        const steps = Array.isArray(raw.steps) ? raw.steps : Object.values(raw.steps ?? {});
        const session = {
          metadata: raw.metadata ?? {},
          steps,
          context: raw.context ?? {},
        };
        store.set(sessionId, session); // rehydrate local cache
        return {
          metadata: session.metadata,
          completedSteps: steps.filter((s) => s.status === "done"),
          context: session.context,
        };
      }
    } catch (err) {
      console.warn(`[memory] Firebase унших амжилтгүй: ${err.message}`);
    }
  }
  const session = store.get(sessionId);
  if (!session) return null;
  return {
    metadata: session.metadata,
    completedSteps: session.steps.filter((s) => s.status === "done"),
    context: session.context,
  };
}

/** Full in-memory snapshot — used by tests and debugging. */
export function getSession(sessionId) {
  return store.get(sessionId) ?? null;
}
