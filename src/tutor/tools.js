// Tools the tutor model can call. Math tools give it verified ground truth
// (it never has to trust its own mental arithmetic); progress tools are the
// only way state changes, so tracking reflects what the tutor actually did.
import { analyzeEquation, checkStep, checkAnswer, MathError } from "../math/engine.js";
import { newId, save, updateSkill, addMistakeToSkill } from "../store.js";

export const SKILLS = [
  "distributive_property",
  "combining_like_terms",
  "inverse_operations",
  "sign_handling",
  "arithmetic",
  "fractions",
  "equation_balance",
  "other",
];

export const TOOLS = [
  {
    name: "check_step",
    description:
      "Verify one step of the student's work. Compares the previous line (the exercise or the last correct line) with the student's new line, reports whether the solution set is preserved, what transformation was applied and, side by side, how each side's value changed. Call this for EVERY new equation line the student writes before judging it.",
    input_schema: {
      type: "object",
      properties: {
        previous_equation: { type: "string", description: "Last line known to be correct, e.g. '3(x + 4) = 2x + 19'" },
        student_equation: { type: "string", description: "The student's new line, e.g. '3x + 4 = 2x + 19'" },
      },
      required: ["previous_equation", "student_equation"],
    },
  },
  {
    name: "check_answer",
    description: "Substitute a proposed value into an equation and report both sides. Use when the student states a final answer.",
    input_schema: {
      type: "object",
      properties: {
        equation: { type: "string" },
        value: { type: "string", description: "e.g. '7' or 'x = 7'" },
      },
      required: ["equation", "value"],
    },
  },
  {
    name: "solve_equation",
    description: "Simplify and solve an equation (for your own reference; do not reveal the solution to the student).",
    input_schema: {
      type: "object",
      properties: { equation: { type: "string" } },
      required: ["equation"],
    },
  },
  {
    name: "record_mistake",
    description:
      "Log a reasoning mistake in the student's progress record once check_step has confirmed it. Describe the misconception, not just the wrong number.",
    input_schema: {
      type: "object",
      properties: {
        skill: { type: "string", enum: SKILLS },
        error_type: { type: "string", description: "Short snake_case label, e.g. 'distributed_to_first_term_only'" },
        description: { type: "string", description: "One sentence describing the misconception." },
        student_work: { type: "string", description: "The incorrect line the student wrote." },
        correct_work: { type: "string", description: "What the line should have been (kept private, for the record)." },
      },
      required: ["skill", "error_type", "description", "student_work", "correct_work"],
    },
  },
  {
    name: "complete_exercise",
    description:
      "Mark the active exercise as finished. The server verifies the final answer by substitution and rejects completion if it is wrong. outcome: 'independent' = solved with no help on this exercise, 'with_guidance' = solved after hints/corrections, 'revealed' = you had to give the answer.",
    input_schema: {
      type: "object",
      properties: {
        final_answer: { type: "string", description: "Student's final value, e.g. '7'" },
        outcome: { type: "string", enum: ["independent", "with_guidance", "revealed"] },
      },
      required: ["final_answer", "outcome"],
    },
  },
  {
    name: "assign_practice_problem",
    description:
      "Create a follow-up practice problem that targets the same skill/misconception as a mistake the student just corrected (same structure, different numbers, integer solution). It becomes the active exercise and is shown to the student. Returns the solution for your reference only.",
    input_schema: {
      type: "object",
      properties: {
        equation: { type: "string", description: "e.g. '4(x + 3) = 3x + 20'" },
        skill: { type: "string", enum: SKILLS },
        targets_mistake_id: { type: "string", description: "id returned by record_mistake, or '' if none" },
        rationale: { type: "string", description: "Why this problem checks the misconception (one sentence)." },
      },
      required: ["equation", "skill", "targets_mistake_id", "rationale"],
    },
  },
];

const str = (v) => typeof v === "string" && v.trim().length > 0;

function requireFields(input, fields) {
  for (const f of fields) if (!str(input?.[f])) throw new MathError(`Missing field "${f}"`);
}

export function activeExercise(student, session) {
  return student.exercises.find((e) => e.id === session.activeExerciseId && e.status === "active") ?? null;
}

export function createExercise(student, { problem, skill = "other", source, targets_mistake_id = null, rationale = null }) {
  const analysis = analyzeEquation(problem);
  if (analysis.solution_kind !== "finite")
    throw new MathError(`"${problem}" has ${analysis.solution_kind.replace(/_/g, " ")}; choose an equation with a definite solution`);
  const ex = {
    id: newId("ex"),
    problem,
    solutions: analysis.solutions,
    skill,
    source,
    targets_mistake_id,
    rationale,
    status: "active",
    outcome: null,
    steps: [],
    mistakes: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  student.exercises.push(ex);
  save();
  return ex;
}

/** Execute one tool call. Returns { result, uiEvent }. Throws MathError for bad input. */
export function runTool(name, input, { student, session }) {
  const ex = activeExercise(student, session);
  switch (name) {
    case "check_step": {
      requireFields(input, ["previous_equation", "student_equation"]);
      const r = checkStep(input.previous_equation, input.student_equation);
      if (ex) {
        ex.steps.push({ line: input.student_equation, equivalent: r.equivalent, transformation: r.transformation });
        save();
      }
      return { result: r, summary: `${input.student_equation} — ${r.equivalent ? "valid" : "INVALID"} (${r.transformation})` };
    }
    case "check_answer": {
      requireFields(input, ["equation", "value"]);
      const r = checkAnswer(input.equation, input.value);
      return { result: r, summary: `${r.substituted}: ${r.left_value} vs ${r.right_value} → ${r.satisfies_equation ? "correct" : "wrong"}` };
    }
    case "solve_equation": {
      requireFields(input, ["equation"]);
      const r = analyzeEquation(input.equation);
      return { result: r, summary: `${r.simplified} → ${r.solutions.join(", ") || r.solution_kind}` };
    }
    case "record_mistake": {
      requireFields(input, ["skill", "error_type", "description", "student_work"]);
      const skill = SKILLS.includes(input.skill) ? input.skill : "other";
      const m = {
        id: newId("m"),
        exerciseId: ex?.id ?? null,
        problem: ex?.problem ?? null,
        skill,
        error_type: input.error_type,
        description: input.description,
        student_work: input.student_work,
        correct_work: input.correct_work ?? "",
        verified: false,
        at: new Date().toISOString(),
      };
      student.mistakes.push(m);
      addMistakeToSkill(student, skill);
      if (ex) {
        ex.mistakes += 1;
        if (ex.skill === "other") ex.skill = skill;
      }
      save();
      return { result: { mistake_id: m.id, logged: true }, summary: `${skill} / ${m.error_type}` };
    }
    case "complete_exercise": {
      requireFields(input, ["final_answer", "outcome"]);
      if (!ex) throw new MathError("There is no active exercise to complete");
      const check = checkAnswer(ex.problem, input.final_answer);
      if (!check.satisfies_equation)
        return {
          result: { completed: false, reason: "final_answer does not satisfy the equation", check },
          summary: `rejected: ${input.final_answer} is not a solution`,
        };
      const outcome = ["independent", "with_guidance", "revealed"].includes(input.outcome) ? input.outcome : "with_guidance";
      // A practice problem solved with zero logged mistakes counts as independent evidence.
      ex.status = "completed";
      ex.outcome = outcome;
      ex.completedAt = new Date().toISOString();
      updateSkill(student, ex.skill, outcome === "independent" ? 1 : outcome === "with_guidance" ? 0.5 : 0);
      let verifiedMistake = null;
      if (ex.targets_mistake_id && outcome === "independent") {
        const m = student.mistakes.find((x) => x.id === ex.targets_mistake_id);
        if (m) { m.verified = true; m.verifiedBy = ex.id; verifiedMistake = m.id; }
      }
      session.activeExerciseId = null;
      save();
      return {
        result: { completed: true, outcome, verified_mistake_fixed: verifiedMistake, skill: ex.skill, mastery: student.skills[ex.skill]?.mastery },
        summary: `${ex.problem} completed (${outcome})${verifiedMistake ? `, mistake ${verifiedMistake} verified fixed` : ""}`,
      };
    }
    case "assign_practice_problem": {
      requireFields(input, ["equation", "skill"]);
      if (ex) { ex.status = "abandoned"; }
      const mistakeId = str(input.targets_mistake_id) && student.mistakes.some((m) => m.id === input.targets_mistake_id) ? input.targets_mistake_id : null;
      const created = createExercise(student, {
        problem: input.equation,
        skill: SKILLS.includes(input.skill) ? input.skill : "other",
        source: "tutor",
        targets_mistake_id: mistakeId,
        rationale: input.rationale ?? null,
      });
      session.activeExerciseId = created.id;
      return {
        result: { exercise_id: created.id, now_active: true, solution_for_tutor_only: created.solutions },
        summary: `${created.problem} (targets ${mistakeId ?? "—"})`,
      };
    }
    default:
      throw new MathError(`Unknown tool ${name}`);
  }
}
