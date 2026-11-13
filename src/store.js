// Progress store: one JSON document per student, persisted to data/progress.json.
// Small and dependency-free on purpose; the interface (getStudent / save /
// snapshot) is what a real database (Postgres, Firestore) would sit behind.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const FILE = path.join(DATA_DIR, "progress.json");

// No prototype: ids such as "__proto__" or "constructor" are ordinary keys.
let db = Object.create(null);
if (fs.existsSync(FILE)) {
  try {
    Object.assign(db, JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch (err) {
    // Keep the unreadable file for recovery instead of silently overwriting it.
    const backup = `${FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(FILE, backup); } catch { /* best effort */ }
    console.error(`[store] ${FILE} could not be read (${err.message}); starting empty, old file kept as ${backup}`);
  }
}

let writeTimer = null;
function writeNow() {
  writeTimer = null;
  // A failed write (read-only disk, antivirus lock, disk full) must not take
  // the server down: progress stays in memory and the next change retries.
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(db, null, 2));
    fs.renameSync(FILE + ".tmp", FILE);
  } catch (err) {
    console.error(`[store] could not save progress to ${FILE}: ${err.message}`);
  }
}
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeNow, 100);
}
/** Write pending changes synchronously (called on shutdown). */
export function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeNow();
  }
}

export const newId = (prefix, bytes = 4) => `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;

export function getStudent(id) {
  if (!Object.hasOwn(db, id)) {
    db[id] = { id, createdAt: new Date().toISOString(), exercises: [], mistakes: [], skills: {} };
    persist();
  }
  return db[id];
}

export function save() {
  persist();
}

export function resetStudent(id) {
  delete db[id];
  persist();
}

/** Mastery: exponential moving average of outcomes (independent = 1, guided = 0.5, revealed = 0). */
export function updateSkill(student, skill, score) {
  const s = (student.skills[skill] ??= { attempts: 0, independent: 0, mistakes: 0, mastery: 0 });
  s.attempts += 1;
  if (score === 1) s.independent += 1;
  s.mastery = s.attempts === 1 ? score : Math.round((0.6 * score + 0.4 * s.mastery) * 100) / 100;
}

export function addMistakeToSkill(student, skill) {
  const s = (student.skills[skill] ??= { attempts: 0, independent: 0, mistakes: 0, mastery: 0 });
  s.mistakes += 1;
}

/** Exercise as the browser may see it: never the solution or tutor-only notes. */
export function publicExercise(e) {
  if (!e) return null;
  return {
    id: e.id,
    problem: e.problem,
    skill: e.skill,
    source: e.source,
    status: e.status,
    outcome: e.outcome,
    steps: e.steps.map((s) => ({ line: s.line, equivalent: s.equivalent })),
    practiceFor: e.targets_mistake_id,
  };
}

function publicMistake(m) {
  return { id: m.id, skill: m.skill, error_type: m.error_type, description: m.description, student_work: m.student_work, verified: m.verified };
}

const TRACE_SUMMARIES = {
  check_step: "Step checked against the previous equation.",
  check_answer: "Answer checked by substitution.",
  solve_equation: "Equation analyzed privately for the tutor.",
  record_mistake: "Reasoning mistake recorded.",
  complete_exercise: "Exercise completed.",
  start_exercise: "Exercise started.",
  assign_practice_problem: "Practice problem assigned.",
  refusal: "The tutor declined this turn.",
};

/** Raw tool arguments and summaries can contain solutions or private notes,
 * even when the tutor's reply does not. Publish only operation and status.
 */
export function publicTrace(trace) {
  return trace.map(entry => {
    const tool = Object.hasOwn(TRACE_SUMMARIES, entry.tool) ? entry.tool : "unknown";
    const ok = entry.ok === true;
    let summary = ok ? TRACE_SUMMARIES[tool] : "Tool request rejected.";
    if (ok && tool === "check_step")
      summary = entry.summary.includes(" — INVALID (") ? "Step changes the solution set." : "Step preserves the solution set.";
    return { tool, summary, ok };
  });
}

/** Compact view for the UI (sanitised: no answers). */
export function snapshot(student) {
  const done = student.exercises.filter((e) => e.status === "completed");
  return {
    totals: {
      exercises_completed: done.length,
      solved_independently: done.filter((e) => e.outcome === "independent").length,
      mistakes_found: student.mistakes.length,
      mistakes_verified_fixed: student.mistakes.filter((m) => m.verified).length,
      steps_checked: student.exercises.reduce((n, e) => n + e.steps.length, 0),
    },
    skills: student.skills,
    mistakes: student.mistakes.slice(-12).reverse().map(publicMistake),
    exercises: student.exercises.slice(-12).reverse().map(publicExercise),
  };
}

/** Short natural-language profile given to the tutor at the start of a session. */
export function profileForTutor(student) {
  const skills = Object.entries(student.skills);
  if (!skills.length && !student.mistakes.length) return "New student, no history yet.";
  const lines = skills.map(
    ([k, s]) => `- ${k}: ${s.attempts} exercise(s), ${s.mistakes} mistake(s), mastery ${Math.round(s.mastery * 100)}%`
  );
  const open = student.mistakes.filter((m) => !m.verified).slice(-5);
  if (open.length)
    lines.push(
      "Mistakes not yet verified as fixed:",
      ...open.map((m) => `- [${m.id}] ${m.skill} / ${m.error_type}: ${m.description}`)
    );
  return lines.join("\n");
}
