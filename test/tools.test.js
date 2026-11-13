// Rules the server enforces on the tutor's tool calls, whatever the model does.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let runTool, createExercise, activeExercise, getStudent, snapshot;
let n = 0;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-tools-"));
  ({ runTool, createExercise, activeExercise } = await import("../src/tutor/tools.js"));
  ({ getStudent, snapshot } = await import("../src/store.js"));
});

function setup(problem = "3(x + 4) = 2x + 19") {
  const student = getStudent(`st_tools${String(++n).padStart(3, "0")}`);
  const session = { activeExerciseId: null };
  session.activeExerciseId = createExercise(student, { problem, source: "student" }).id;
  return { student, session };
}
const lines = (ctx) => activeExercise(ctx.student, ctx.session).steps.map((s) => s.line);

test("only lines the student wrote reach the notebook", () => {
  const ctx = setup();
  const studentText = "I think 3x+4 = 2x+19";
  const step = (student_equation) => runTool("check_step", { previous_equation: "3(x + 4) = 2x + 19", student_equation }, { ...ctx, studentText });
  step("3x + 4 = 2x + 19"); // the student's line (spacing differs)
  const own = step("3x + 12 = 2x + 19"); // the tutor checking the correct line for itself
  step("3x + 4 = 2x + 19"); // repeated call
  assert.deepEqual(lines(ctx), ["3x + 4 = 2x + 19"]);
  assert.equal(own.result.equivalent, true); // the check itself still works
});

test("a practice problem cannot replace an exercise that is still in progress", () => {
  const ctx = setup();
  const studentText = "3x + 4 = 2x + 19";
  runTool("check_step", { previous_equation: "3(x + 4) = 2x + 19", student_equation: studentText }, { ...ctx, studentText });
  const assign = (equation) => runTool("assign_practice_problem", { equation, skill: "distributive_property", targets_mistake_id: "", rationale: "r" }, { ...ctx, studentText });

  // Seen on live Haiku: practice assigned on the first wrong step, then the original re-created.
  assert.throws(() => assign("2(x + 5) = x + 14"), /has not finished/);
  assert.throws(() => runTool("start_exercise", { equation: "2(x + 5) = x + 14" }, { ...ctx, studentText }), /still in progress/);
  assert.equal(activeExercise(ctx.student, ctx.session).problem, "3(x + 4) = 2x + 19");
  assert.deepEqual(lines(ctx), ["3x + 4 = 2x + 19"]); // the notebook keeps the student's work
  assert.equal(ctx.student.exercises.length, 1);

  runTool("complete_exercise", { final_answer: "7", outcome: "with_guidance", skill: "distributive_property" }, { ...ctx, studentText: "x = 7" });
  assert.throws(() => assign("x + 1 = x + 1"), /definite solution/);
  assert.throws(() => assign("3(x+4) = 2x+19"), /change the numbers/);
  assert.equal(activeExercise(ctx.student, ctx.session), null);
  assign("4(x + 3) = 3x + 20");
  assert.equal(activeExercise(ctx.student, ctx.session).problem, "4(x + 3) = 3x + 20");
});

test("the same wrong line is logged as one mistake", () => {
  const ctx = setup();
  const m = { skill: "distributive_property", error_type: "first_term_only", description: "d", student_work: "3x + 4 = 2x + 19", correct_work: "3x + 12 = 2x + 19" };
  const a = runTool("record_mistake", m, ctx);
  const b = runTool("record_mistake", { ...m, student_work: "3x+4=2x+19" }, ctx);
  assert.equal(b.result.mistake_id, a.result.mistake_id);
  assert.equal(snapshot(ctx.student).totals.mistakes_found, 1);
});

test("completion is verified, honest, and a solved practice problem marks the mistake fixed", () => {
  const ctx = setup();
  const { result: logged } = runTool("record_mistake", { skill: "distributive_property", error_type: "e", description: "d", student_work: "3x + 4 = 2x + 19", correct_work: "c" }, ctx);

  const wrong = runTool("complete_exercise", { final_answer: "15", outcome: "independent", skill: "distributive_property" }, ctx);
  assert.equal(wrong.result.completed, false);

  const done = runTool("complete_exercise", { final_answer: "x = 7", outcome: "independent", skill: "distributive_property" }, { ...ctx, studentText: "x = 7" });
  assert.equal(done.result.outcome, "with_guidance"); // a mistake was logged, so not "independent"
  assert.equal(ctx.student.exercises[0].steps.at(-1).line, "x = 7");
  assert.equal(activeExercise(ctx.student, ctx.session), null);

  runTool("assign_practice_problem", { equation: "4(x + 3) = 3x + 20", skill: "distributive_property", targets_mistake_id: logged.mistake_id, rationale: "r" }, ctx);
  const practice = runTool("complete_exercise", { final_answer: "8", outcome: "independent", skill: "distributive_property" }, { ...ctx, studentText: "x = 8" });
  assert.equal(practice.result.verified_mistake_fixed, logged.mistake_id);
  const p = snapshot(ctx.student);
  assert.equal(p.totals.mistakes_verified_fixed, 1);
  assert.equal(p.totals.solved_independently, 1);
});

test("an equation the student brings up in chat becomes a tracked exercise", () => {
  const ctx = setup("2x = 8");
  const studentText = "can we do 5x - 7 = 2x + 8 instead?";
  assert.throws(() => runTool("start_exercise", { equation: "5x - 7 = 2x + 8" }, { ...ctx, studentText }), /new equation form/);
  runTool("complete_exercise", { final_answer: "4", outcome: "independent", skill: "inverse_operations" }, { ...ctx, studentText: "x = 4" });
  const r = runTool("start_exercise", { equation: "5x - 7 = 2x + 8" }, { ...ctx, studentText });
  assert.equal(r.result.now_active, true);
  assert.equal(activeExercise(ctx.student, ctx.session).problem, "5x - 7 = 2x + 8");
  assert.equal(ctx.student.exercises[0].status, "completed");
  assert.throws(() => runTool("start_exercise", { equation: "not an equation" }, { ...ctx, studentText: "not an equation" }));
  assert.equal(activeExercise(ctx.student, ctx.session).problem, "5x - 7 = 2x + 8");
  runTool("complete_exercise", { final_answer: "5", outcome: "independent", skill: "inverse_operations" }, { ...ctx, studentText: "5" });
  assert.equal(snapshot(ctx.student).skills.inverse_operations.attempts, 2); // not filed under "other"
  // With nothing in progress the tutor may start any equation the conversation calls for.
  assert.equal(runTool("start_exercise", { equation: "x + 2 = 5" }, { ...ctx, studentText: "another one please" }).result.now_active, true);
});

test("start_exercise cannot replace the notebook with a student's incorrect intermediate line", () => {
  const ctx = setup();
  const studentText = "3x + 4 = 2x + 19";
  runTool("check_step", { previous_equation: "3(x + 4) = 2x + 19", student_equation: studentText }, { ...ctx, studentText });
  const before = structuredClone(ctx);
  assert.throws(() => runTool("start_exercise", { equation: studentText }, { ...ctx, studentText }), /still in progress/);
  assert.deepEqual(ctx, before);
});

test("reserved object keys are ordinary student ids", () => {
  for (const id of ["__proto__", "constructor", "toString"]) {
    const s = getStudent(id);
    assert.equal(s.id, id);
    assert.deepEqual(s.exercises, []);
  }
  assert.equal({}.exercises, undefined); // nothing leaked onto Object.prototype
});

test("completion requires the student's final value, including when the model claims it revealed the answer", () => {
  for (const studentText of ["I don't know", "3x + 4 = 2x + 19", "17", "2x = 7", "3 + x = 7", "x = 7 + 1", "x = 7/2", "x = 7.5"]) {
    for (const outcome of ["independent", "revealed"]) {
      const ctx = setup();
      const before = structuredClone(ctx);
      const r = runTool("complete_exercise", { final_answer: "7", outcome, skill: "distributive_property" }, { ...ctx, studentText });
      assert.equal(r.result.completed, false, studentText);
      assert.deepEqual(ctx, before);
    }
  }
});

test("stated final answers accept prose, multiple lines, fractions, decimals and unicode minus", () => {
  for (const [problem, final_answer, studentText] of [
    ["2x = 14", "7", "X = 7"],
    ["2x = 14", "7", "Отже, x = 7."],
    ["2x = 14", "7", "My answer is 7"],
    ["2x = 14", "7", "2x = 14\nx = 14/2"],
    ["2x = 14", "7", "14/2"],
    ["2x = -14", "-7", "x = −7"],
    ["2x = 1", "1/2", "x = 0,5"],
  ]) {
    const ctx = setup(problem);
    const r = runTool("complete_exercise", { final_answer, outcome: "independent", skill: "arithmetic" }, { ...ctx, studentText });
    assert.equal(r.result.completed, true, studentText);
  }
});

test("Cyrillic х typed on a Ukrainian keyboard is the same variable as Latin x", () => {
  const ctx = setup();
  const CYR = "\u0445";
  // The tutor passes the line with a Latin x; the student's message has the Cyrillic letter.
  const studentText = `3${CYR} + 12 = 2${CYR} + 19`;
  runTool("check_step", { previous_equation: "3(x + 4) = 2x + 19", student_equation: "3x + 12 = 2x + 19" }, { ...ctx, studentText });
  assert.deepEqual(lines(ctx), ["3x + 12 = 2x + 19"]);
  // ...or the tutor copies the student's line exactly.
  runTool("check_step", { previous_equation: "3x + 12 = 2x + 19", student_equation: `${CYR} + 12 = 19` }, { ...ctx, studentText: `${CYR} + 12 = 19` });
  assert.equal(activeExercise(ctx.student, ctx.session).steps.at(-1).equivalent, true);
  for (const text of [`${CYR} = 7`, `отже ${CYR}=7`, `\u0425 = 7`]) {
    const c = setup();
    const done = runTool("complete_exercise", { final_answer: "7", outcome: "independent", skill: "distributive_property" }, { ...c, studentText: text });
    assert.equal(done.result.completed, true, text);
  }
});
