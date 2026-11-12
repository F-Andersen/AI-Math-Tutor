import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEquation, checkStep, checkAnswer } from "../src/math/engine.js";

test("solves the scenario equation", () => {
  const r = analyzeEquation("3(x + 4) = 2x + 19");
  assert.deepEqual(r.solutions, ["x = 7"]);
  assert.equal(r.simplified, "3x + 12 = 2x + 19");
});

test("detects the distribution error in the test scenario", () => {
  const r = checkStep("3(x + 4) = 2x + 19", "3x + 4 = 2x + 19");
  assert.equal(r.equivalent, false);
  assert.match(r.transformation, /INVALID/);
  const [left, right] = r.sides;
  assert.equal(left.value_preserved, false);
  assert.equal(left.before_simplified, "3x + 12");
  assert.equal(left.after_simplified, "3x + 4");
  assert.equal(left.change, "-8");
  assert.equal(right.value_preserved, true);
  assert.deepEqual(r.student.solutions, ["x = 15"]);
});

test("accepts a correct expansion", () => {
  const r = checkStep("3(x + 4) = 2x + 19", "3x + 12 = 2x + 19");
  assert.equal(r.equivalent, true);
  assert.match(r.transformation, /rewrite_only/);
});

test("recognises subtracting from both sides", () => {
  const r = checkStep("3x + 12 = 2x + 19", "x + 12 = 19");
  assert.equal(r.equivalent, true);
  assert.match(r.transformation, /same_quantity_added_to_both_sides \(added -2x\)/);
});

test("recognises scaling both sides", () => {
  const r = checkStep("2x = 14", "x = 7");
  assert.equal(r.equivalent, true);
  assert.match(r.transformation, /multiplied_by 1\/2/);
});

test("flags a sign error when moving a term", () => {
  const r = checkStep("x + 12 = 19", "x = 31");
  assert.equal(r.equivalent, false);
});

test("handles unicode symbols, decimals and fractions", () => {
  assert.deepEqual(analyzeEquation("0.5x − 1 = 2").solutions, ["x = 6"]);
  assert.deepEqual(analyzeEquation("2x = 7").solutions, ["x = 7/2"]);
  assert.deepEqual(analyzeEquation("x/3 + 1 = 2").solutions, ["x = 3"]);
});

test("solves quadratics and special cases", () => {
  assert.deepEqual(analyzeEquation("x^2 = 9").solutions, ["x = -3", "x = 3"]);
  assert.equal(analyzeEquation("x + 1 = x + 1").solution_kind, "all_real_numbers");
  assert.equal(analyzeEquation("x + 1 = x + 2").solution_kind, "no_solution");
});

test("checks a proposed answer by substitution", () => {
  assert.equal(checkAnswer("3(x + 4) = 2x + 19", "7").satisfies_equation, true);
  const wrong = checkAnswer("3(x + 4) = 2x + 19", "x = 15");
  assert.equal(wrong.satisfies_equation, false);
  assert.equal(wrong.left_value, "57");
  assert.equal(wrong.right_value, "49");
});

test("rejects malformed input with a clear error", () => {
  assert.throws(() => analyzeEquation("3x + 4"), /exactly one "="/);
  assert.throws(() => analyzeEquation("x + y = 3"), /one variable/);
});
