// Tools the tutor model can call. Math tools give it verified ground truth
// (it never has to trust its own mental arithmetic); progress tools are the
// only way state changes, so tracking reflects what the tutor actually did.
import { analyzeEquation, checkStep, checkAnswer, MathError, latinVariables } from "../math/engine.js";
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
        student_equation: {
          type: "string",
          description: "The student's new line, copied exactly as they wrote it, e.g. '3x + 4 = 2x + 19'. Only lines found in the student's message are added to their notebook.",
        },
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
        description: {
          type: "string",
          description:
            "One sentence describing the misconception, addressed to the student in the second person (the student reads it in their progress page), e.g. 'You multiplied only the x by 3 and left the 4 unchanged.' Do not include the correct line or the answer.",
        },
        student_work: { type: "string", description: "The incorrect line the student wrote." },
        correct_work: { type: "string", description: "What the line should have been (kept private, for the record)." },
      },
      required: ["skill", "error_type", "description", "student_work", "correct_work"],
    },
  },
  {
    name: "complete_exercise",
    description:
      "Mark the active exercise as finished only after the student states its final answer in their current message. The server verifies that the student wrote this value and that it satisfies the original equation. Never use your own computed solution to finish an exercise. outcome: 'independent' = solved with no help on this exercise, 'with_guidance' = solved after hints/corrections, 'revealed' = you had to give the answer.",
    input_schema: {
      type: "object",
      properties: {
        final_answer: { type: "string", description: "Student's final value, e.g. '7'" },
        outcome: { type: "string", enum: ["independent", "with_guidance", "revealed"] },
        skill: { type: "string", enum: SKILLS, description: "The main skill this exercise practised." },
      },
      required: ["final_answer", "outcome", "skill"],
    },
  },
  {
    name: "start_exercise",
    description:
      "When no exercise is active, make an equation the student brought up in chat the active exercise, so their work is tracked. This cannot replace an unfinished exercise: the student must use the new equation form to switch. Never start an intermediate line as a new exercise. Not for problems you invent: use assign_practice_problem for those.",
    input_schema: {
      type: "object",
      properties: { equation: { type: "string", description: "The student's equation, e.g. '2x + 3 = 11'" } },
      required: ["equation"],
    },
  },
  {
    name: "assign_practice_problem",
    description:
      "Only after complete_exercise has succeeded (it is rejected while an exercise is still in progress): create a follow-up practice problem that targets the same skill/misconception as a mistake the student just corrected (same structure, different numbers, integer solution). It becomes the active exercise and is shown to the student. Returns the solution for your reference only.",
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
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

/** Canonical form of a line of work, for comparing what was written (not its value). */
const canon = (s) =>
  latinVariables(s ?? "")
    .toLowerCase()
    .replace(/[−–—]/g, "-")
    .replace(/[×·∙⋅*]/g, "")
    .replace(/÷/g, "/")
    .replace(/,/g, ".")
    .replace(/\s+/g, "");

/** Did the student write this line in their current message? */
const writtenByStudent = (line, studentText) => canon(studentText).includes(canon(line));

/** Require a stated value, not a digit buried in an intermediate equation.
 * Compare exact fractions through the engine, so 14/2 and 7 are the same answer.
 */
function answerWrittenByStudent(problem, check, studentText) {
  const text = latinVariables(studentText).replace(/[−–—]/g, "-").replace(/÷/g, "/");
  const variable = check.substituted.split(" = ")[0];
  const literal = "[+-]?\\s*(?:\\d+(?:[.,]\\d+)?|[.,]\\d+)(?:\\s*/\\s*[+-]?\\s*\\d+(?:[.,]\\d+)?)?";
  const candidates = [];
  const assignments = new RegExp(`\\b${variable}\\s*=\\s*(${literal})(?![\\p{L}\\p{N}_/]|[.,]\\d)`, "giu");
  for (const match of text.matchAll(assignments)) {
    const before = text.slice(0, match.index).split("\n").at(-1).trimEnd();
    const after = text.slice(match.index + match[0].length).trimStart();
    // Exclude 2x = 7, 3 + x = 7, and x = 7 + 1.
    if (/[\d+*/^=(\-]$/.test(before) || /^[+*/^=)\-]/.test(after)) continue;
    candidates.push(match[1]);
  }
  // Bare values and prose such as "my answer is 7" must contain no other math.
  const plain = text.match(new RegExp(`^[\\p{L}\\p{M}\\s,:]*?(${literal})[\\p{L}\\p{M}\\s.!?,;]*$`, "u"));
  if (plain) candidates.push(plain[1]);
  return candidates.some(value => {
    try { return checkAnswer(problem, value).substituted === check.substituted; }
    catch (err) { if (err instanceof MathError) return false; throw err; }
  });
}

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

/** Replace the session's active exercise. The new one must already be created (validated). */
function activate(student, session, created) {
  const prev = activeExercise(student, session);
  if (prev && prev.id !== created.id) prev.status = "abandoned";
  session.activeExerciseId = created.id;
  save();
}

/** Add a verified line to the student's notebook (no consecutive duplicates). */
function addStep(ex, line, equivalent, transformation) {
  const last = ex.steps.at(-1);
  if (last && canon(last.line) === canon(line)) return;
  ex.steps.push({ line: clip(line, 120), equivalent, transformation });
  save();
}

/**
 * Execute one tool call. Returns { result, summary }. Throws MathError for bad input.
 * studentText is the student's current message: only lines found in it are
 * written to their notebook, so a line the tutor checks for itself (for
 * example the correct one) can never appear there.
 */
export function runTool(name, input, { student, session, studentText = "", answerExerciseId = session.activeExerciseId }) {
  const ex = activeExercise(student, session);
  switch (name) {
    case "check_step": {
      requireFields(input, ["previous_equation", "student_equation"]);
      const r = checkStep(input.previous_equation, input.student_equation);
      if (ex && writtenByStudent(input.student_equation, studentText))
        addStep(ex, input.student_equation, r.equivalent, r.transformation);
      return {
        result: { ...r, reminder: "For your judgement only: do not tell the student any solution value from this report until they state the answer themselves." },
        summary: `${input.student_equation} — ${r.equivalent ? "valid" : "INVALID"} (${r.transformation})`,
      };
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
      // The same wrong line on the same exercise is one mistake (e.g. a retried turn).
      const dup = student.mistakes.find((x) => x.exerciseId === (ex?.id ?? null) && canon(x.student_work) === canon(input.student_work));
      if (dup) return { result: { mistake_id: dup.id, logged: true, already_logged: true }, summary: `${dup.skill} / ${dup.error_type} (already logged)` };
      const m = {
        id: newId("m"),
        exerciseId: ex?.id ?? null,
        problem: ex?.problem ?? null,
        skill,
        error_type: clip(input.error_type, 60),
        description: clip(input.description, 300),
        student_work: clip(input.student_work, 120),
        correct_work: clip(input.correct_work, 120),
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
      if (ex.id !== answerExerciseId && !(ex.source === "student" && writtenByStudent(ex.problem, studentText)))
        throw new MathError("This exercise was just assigned. Wait for the student's next message before completing it.");
      const check = checkAnswer(ex.problem, input.final_answer);
      if (!check.satisfies_equation)
        return {
          result: { completed: false, reason: "final_answer does not satisfy the equation", check },
          summary: `rejected: ${input.final_answer} is not a solution`,
        };
      if (!answerWrittenByStudent(ex.problem, check, studentText))
        return {
          result: { completed: false, reason: "The student has not stated this final answer. Continue the current exercise; ask them to write their answer as x = value before completing it." },
          summary: "rejected: the student has not stated the final answer",
        };
      let outcome = ["independent", "with_guidance", "revealed"].includes(input.outcome) ? input.outcome : "with_guidance";
      // Progress must stay honest: an exercise with a logged mistake was not solved independently.
      if (outcome === "independent" && ex.mistakes > 0) outcome = "with_guidance";
      if (ex.skill === "other" && SKILLS.includes(input.skill)) ex.skill = input.skill;
      if (outcome !== "revealed") addStep(ex, check.substituted, true, "final answer verified by substitution");
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
        result: {
          completed: true,
          outcome,
          ...(outcome !== input.outcome ? { note: `recorded as ${outcome}: a mistake was logged on this exercise` } : {}),
          verified_mistake_fixed: verifiedMistake, skill: ex.skill, mastery: student.skills[ex.skill]?.mastery },
        summary: `${ex.problem} completed (${outcome})${verifiedMistake ? `, mistake ${verifiedMistake} verified fixed` : ""}`,
      };
    }
    case "assign_practice_problem": {
      requireFields(input, ["equation", "skill"]);
      // Practice comes after the exercise, never instead of it.
      if (ex)
        throw new MathError(
          `The student has not finished "${ex.problem}" yet. Keep guiding them on it; assign a practice problem only after complete_exercise has succeeded.`
        );
      if (student.exercises.slice(-6).some((e) => canon(e.problem) === canon(input.equation)))
        throw new MathError("The student has already worked on this exact equation; keep the structure but change the numbers");
      const mistakeId = str(input.targets_mistake_id) && student.mistakes.some((m) => m.id === input.targets_mistake_id) ? input.targets_mistake_id : null;
      // createExercise validates first and throws without touching the exercise in progress.
      const created = createExercise(student, {
        problem: clip(input.equation, 120),
        skill: SKILLS.includes(input.skill) ? input.skill : "other",
        source: "tutor",
        targets_mistake_id: mistakeId,
        rationale: clip(input.rationale, 300) || null,
      });
      activate(student, session, created);
      return {
        result: { exercise_id: created.id, now_active: true, solution_for_tutor_only: created.solutions },
        summary: `${created.problem} (targets ${mistakeId ?? "—"})`,
      };
    }
    case "start_exercise": {
      requireFields(input, ["equation"]);
      if (ex && canon(ex.problem) === canon(input.equation))
        return { result: { exercise_id: ex.id, now_active: true, note: "this is already the active exercise" }, summary: `${ex.problem} (already active)` };
      // A written equation may be an incorrect intermediate step, not consent
      // to abandon the notebook. Only the explicit HTTP exercise action switches.
      if (ex)
        throw new MathError(`"${ex.problem}" is still in progress. Continue with the active exercise. If the student wants to switch, ask them to use the new equation form.`);
      const created = createExercise(student, { problem: clip(input.equation, 120), source: "student" });
      activate(student, session, created);
      return { result: { exercise_id: created.id, now_active: true, solution_for_tutor_only: created.solutions }, summary: created.problem };
    }
    default:
      throw new MathError(`Unknown tool ${name}`);
  }
}
