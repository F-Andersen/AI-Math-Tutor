// Runs the assignment's test scenario against the real model, no browser needed:
//   npm run scenario
// A scripted "student" makes the distribution mistake, then follows the tutor
// and solves the follow-up practice problem correctly.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-scenario-"));
const { tutorTurn, aiConfigured, MODEL } = await import("../src/tutor/agent.js");
const { createExercise, activeExercise } = await import("../src/tutor/tools.js");
const { getStudent, snapshot } = await import("../src/store.js");
const { analyzeEquation } = await import("../src/math/engine.js");

if (!aiConfigured()) {
  console.error("Set ANTHROPIC_API_KEY (in .env or the environment) to run the live scenario.");
  process.exit(1);
}

const student = getStudent("st_scenario01");
const session = { id: "s_scenario", studentId: student.id, messages: [], activeExerciseId: null };
const ex = createExercise(student, { problem: "3(x + 4) = 2x + 19", source: "student" });
session.activeExerciseId = ex.id;

async function say(text) {
  console.log(`\n\x1b[2mSTUDENT\x1b[0m  ${text}`);
  const r = await tutorTurn({ student, session, text });
  for (const t of r.trace) console.log(`\x1b[2m  · ${t.tool}: ${t.summary}\x1b[0m`);
  console.log(`\x1b[1mTUTOR\x1b[0m    ${r.reply}`);
  return r;
}

console.log(`Model: ${MODEL}\nExercise: ${ex.problem}`);
await say("3x + 4 = 2x + 19");
await say("Oh, the 3 multiplies the 4 too. So 3x + 12 = 2x + 19");
await say("x + 12 = 19");
await say("x = 7");

// Follow-up practice problem (if the tutor assigned one), solved step by step.
let practice = activeExercise(student, session);
if (!practice) await say("Ok, what's next?"), (practice = activeExercise(student, session));
if (practice) {
  console.log(`\n--- practice problem: ${practice.problem} ---`);
  const a = analyzeEquation(practice.problem);
  await say(a.simplified);
  await say(a.solutions[0]);
} else {
  console.log("\n(no practice problem was assigned)");
}

const p = snapshot(student);
console.log("\n=== Progress ===");
console.log(p.totals);
console.log("Skills:", p.skills);
console.log("Mistakes:", p.mistakes.map((m) => `${m.skill}/${m.error_type} verified=${m.verified}`));
