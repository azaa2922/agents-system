#!/usr/bin/env node
/**
 * Memory system-ийн тест.
 *   node src/core/test-memory.js
 *
 * 1) Firebase-гүйгээр: context нэгтгэх (mergeContext) цэвэр логикийг шалгана.
 * 2) FIREBASE_* тохируулсан үед: бүрэн integration тест —
 *    session үүсгэх → 3 алхам → алхмуудыг нэг нэгээр дуусгах → context хуримтлагдахыг
 *    шалгах → session дуусгах → жагсаах → сэргээх → цэвэрлэх.
 * Бүгд амжилттай бол "Memory system working!" гэж хэвлэнэ.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import * as memory from "./memory.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed — ${msg}`);
}

/* ---------- 1) offline pure-logic checks (always run) ---------- */
log("🧪 mergeContext логикийг шалгаж байна…");
assert(
  JSON.stringify(memory.mergeContext({}, { files_created: ["a"] }).files_created) === JSON.stringify(["a"]),
  "массив шинээр үүсэх",
);
assert(
  JSON.stringify(memory.mergeContext({ files_created: ["a"] }, { files_created: ["b", "a"] }).files_created) ===
    JSON.stringify(["a", "b"]),
  "массив нэмэгдэж давхардал арилах",
);
assert(
  memory.mergeContext({ accumulated_knowledge: "old" }, { accumulated_knowledge: "new" }).accumulated_knowledge ===
    "new",
  "скаляр солигдох",
);
assert(
  memory.mergeContext({ decisions_made: ["x"] }, { decisions_made: ["y"] }).decisions_made.length === 2,
  "decisions_made нэмэгдэх",
);
log("✓ mergeContext OK");

/* ---------- 2) Firebase integration (configured үед) ---------- */
const ready = await memory.initFromEnv({ log });
if (!ready) {
  log("");
  log("⏭  Firebase тохируулаагүй тул integration тестийг алгаслаа.");
  log("   .env дотор FIREBASE_DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_PATH тохируулаад дахин ажиллуулна уу.");
  log("✅ Offline logic checks passed.");
  process.exit(0);
}

let sessionId = null;
try {
  log("1) createSession…");
  sessionId = await memory.createSession("Test goal: verify memory system", "test-agent");
  assert(sessionId, "session id буцаах");

  log("2) addSteps (3)…");
  await memory.addSteps(sessionId, [
    { action: "plan", description: "Plan the work" },
    { action: "work", description: "Do the work" },
    { action: "save", description: "Save results" },
  ]);
  let session = await memory.getSession(sessionId);
  assert(session.total_steps === 3, "total_steps === 3");

  const facts = ["Found Next.js", "Found Remix", "Found Astro"];
  for (let i = 0; i < 3; i++) {
    log(`3.${i + 1}) step ${i} — start → context → complete…`);
    await memory.startStep(sessionId, i);
    await memory.updateContext(sessionId, {
      accumulated_knowledge: facts.slice(0, i + 1).join(" | "),
      files_created: [`output/test_${i}.txt`],
      decisions_made: [`Decision ${i}`],
    });
    await memory.completeStep(sessionId, i, `step ${i} done`, 100 * (i + 1));
  }

  log("4) context хуримтлагдсаныг шалгах…");
  const ctx = await memory.getContext(sessionId);
  assert((ctx.files_created || []).length === 3, "3 файл хуримтлагдах");
  assert((ctx.decisions_made || []).length === 3, "3 шийдвэр хуримтлагдах");
  assert(ctx.accumulated_knowledge.includes("Astro"), "мэдлэг хуримтлагдах");

  log("5) getCurrentStep → null (бүгд дууссан)…");
  assert((await memory.getCurrentStep(sessionId)) === null, "pending алхам үлдээгүй");

  log("6) completeSession…");
  await memory.completeSession(sessionId, "Test completed — 3 frameworks found");
  session = await memory.getSession(sessionId);
  assert(session.status === "completed", "статус completed");
  assert(session.metadata.total_tokens === 600, "токен нийлбэр 100+200+300 = 600");

  log("7) listSessions('test-agent')…");
  const list = await memory.listSessions("test-agent");
  assert(list.some((s) => s.id === sessionId), "session жагсаалтад байх");

  log("8) resumeSession…");
  const resumed = await memory.resumeSession(sessionId);
  assert(resumed && resumed.id === sessionId, "resume session буцаах");

  log("🧹 тест session-ийг цэвэрлэж байна…");
  await memory.removeSession(sessionId);

  log("");
  log("✅ Memory system working!");
} catch (e) {
  console.error(`❌ Test failed: ${e.message}`);
  if (sessionId) await memory.removeSession(sessionId).catch(() => {});
  process.exitCode = 1;
} finally {
  await memory.shutdown();
}
