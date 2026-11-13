// Plumbing test for the tutor loop: a local stub stands in for the Messages API,
// asks for check_step + record_mistake, then answers. Verifies tool execution,
// tool_result wiring, progress updates and append-only history. (The real
// teaching behaviour is exercised live with `npm run scenario`.)
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const requests = [];
let server;
let script;
const message = (content, stop_reason = "end_turn") => ({
  id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason,
  stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
});
const tool = (name, input) => message([{ type: "tool_use", id: "tu_test", name, input }], "tool_use");
const answer = () => message([{ type: "text", text: "Keep working on your equation." }]);
const complete = () => tool("complete_exercise", { final_answer: "7", outcome: "independent", skill: "distributive_property" });
const practice = () => tool("assign_practice_problem", { equation: "4(x + 3) = 3x + 20", skill: "distributive_property", targets_mistake_id: "", rationale: "Same structure." });

beforeEach(() => { requests.length = 0; script = null; });

before(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = JSON.parse(body);
    requests.push(json);
    if (script) {
      const next = script.shift();
      res.writeHead(next?.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(next?.body ?? next ?? answer()));
      return;
    }
    const step = requests.length;
    const msg = (content, stop_reason) => ({
      id: `msg_${step}`, type: "message", role: "assistant", model: json.model, content, stop_reason,
      stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
    });
    let out;
    if (step === 1)
      out = msg([{ type: "tool_use", id: "tu_1", name: "check_step", input: { previous_equation: "3(x + 4) = 2x + 19", student_equation: "3x + 4 = 2x + 19" } }], "tool_use");
    else if (step === 2)
      out = msg([{ type: "tool_use", id: "tu_2", name: "record_mistake", input: { skill: "distributive_property", error_type: "distributed_to_first_term_only", description: "Multiplied only x by 3.", student_work: "3x + 4 = 2x + 19", correct_work: "3x + 12 = 2x + 19" } }], "tool_use");
    else out = msg([{ type: "text", text: "Look at the left side: what does 3(x + 4) mean?" }], "end_turn");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-test-"));
});

let n = 0;
async function setup() {
  const { createExercise } = await import("../src/tutor/tools.js");
  const { getStudent } = await import("../src/store.js");
  const student = getStudent(`st_failure${++n}`);
  const session = { messages: [], activeExerciseId: createExercise(student, { problem: "3(x + 4) = 2x + 19", source: "student" }).id };
  return { student, session };
}

test("premature practice is rejected and the loop recovers without losing the notebook", async () => {
  const { tutorTurn } = await import("../src/tutor/agent.js");
  for (let i = 0; i < 4; i++) {
    const ctx = await setup();
    const originalId = ctx.session.activeExerciseId;
    script = [
      tool("check_step", { previous_equation: ctx.student.exercises[0].problem, student_equation: "3x + 4 = 2x + 19" }),
      practice(), answer(),
    ];
    const r = await tutorTurn({ ...ctx, text: "3x + 4 = 2x + 19" });
    assert.equal(r.trace[1].ok, false);
    assert.equal(ctx.session.activeExerciseId, originalId);
    assert.equal(ctx.student.exercises.length, 1);
    assert.deepEqual(ctx.student.exercises[0].steps.map(s => [s.line, s.equivalent]), [["3x + 4 = 2x + 19", false]]);
    assert.equal(requests.at(-1).messages.at(-1).content[0].is_error, true);
  }
});

test("the model cannot complete using its own answer and then assign practice", async () => {
  const { tutorTurn } = await import("../src/tutor/agent.js");
  const ctx = await setup();
  const originalId = ctx.session.activeExerciseId;
  script = [complete(), practice(), answer()];
  const r = await tutorTurn({ ...ctx, text: "3x + 4 = 2x + 19" });
  assert.equal(r.trace[0].ok, false);
  assert.equal(r.trace[1].ok, false);
  assert.equal(ctx.session.activeExerciseId, originalId);
  assert.equal(ctx.student.exercises.length, 1);
  assert.equal(ctx.student.exercises[0].status, "active");
});

for (const failure of ["api_error", "refusal", "max_tokens", "model_context_window_exceeded", "empty_reply", "iteration_limit"]) {
  test(`completion and practice are not committed after ${failure}; retry succeeds once`, async () => {
    const { tutorTurn, describeError } = await import("../src/tutor/agent.js");
    const { flush } = await import("../src/store.js");
    const ctx = await setup();
    ctx.session.messages.push({ role: "user", content: "Earlier question" }, { role: "assistant", content: [{ type: "text", text: "Earlier reply" }] });
    ctx.session.profileSent = true;
    ctx.session.announcedExerciseId = ctx.session.activeExerciseId;
    const beforeState = structuredClone(ctx);
    const stop = failure === "api_error"
      ? { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "stub failure" } } }
      : failure === "empty_reply" ? message([])
      : message([{ type: "text", text: "Partial response" }], failure);
    script = [complete(), practice(), ...(failure === "iteration_limit"
      ? Array.from({ length: 8 }, () => message([], "pause_turn")) : [stop])];
    if (failure === "refusal") await tutorTurn({ ...ctx, text: "x = 7" });
    else await assert.rejects(tutorTurn({ ...ctx, text: "x = 7" }), err => {
      assert.equal(describeError(err).status, 502);
      return true;
    });
    assert.deepEqual(ctx, beforeState);
    flush();
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "progress.json"), "utf8"));
    assert.deepEqual(saved[ctx.student.id], beforeState.student);

    script = [complete(), practice(), answer()];
    const r = await tutorTurn({ ...ctx, text: "x = 7" });
    assert.equal(r.reply, "Keep working on your equation.");
    assert.deepEqual(ctx.student.exercises.map(e => e.status), ["completed", "active"]);
    assert.equal(ctx.student.skills.distributive_property.attempts, 1);
  });
}

test("a truncated tool call is never executed", async () => {
  const { tutorTurn } = await import("../src/tutor/agent.js");
  const ctx = await setup();
  const beforeState = structuredClone(ctx);
  const truncated = complete();
  truncated.stop_reason = "max_tokens";
  script = [truncated];
  await assert.rejects(tutorTurn({ ...ctx, text: "x = 7" }));
  assert.deepEqual(ctx, beforeState);
});

test("an old answer cannot also complete a newly assigned practice problem with the same solution", async () => {
  const { tutorTurn } = await import("../src/tutor/agent.js");
  const ctx = await setup();
  script = [complete(), tool("assign_practice_problem", { equation: "4(x + 3) = 3x + 19", skill: "distributive_property", targets_mistake_id: "", rationale: "Same structure." }), complete(), answer()];
  const r = await tutorTurn({ ...ctx, text: "x = 7" });
  assert.equal(r.trace[2].ok, false);
  assert.deepEqual(ctx.student.exercises.map(e => e.status), ["completed", "active"]);
  assert.equal(ctx.student.skills.distributive_property.attempts, 1);
});

test("pause_turn resumes full content blocks before returning the final reply", async () => {
  const { tutorTurn } = await import("../src/tutor/agent.js");
  const ctx = await setup();
  const content = [{ type: "thinking", thinking: "private", signature: "test-signature" }];
  script = [message(content, "pause_turn"), answer()];
  const r = await tutorTurn({ ...ctx, text: "What next?" });
  assert.equal(r.reply, "Keep working on your equation.");
  assert.deepEqual(requests[1].messages.at(-1).content, content);
});

after(() => server.close());

test("tool loop checks the step, logs the mistake and returns the tutor reply", async () => {
  const { tutorTurn } = await import("../src/tutor/agent.js");
  const { createExercise } = await import("../src/tutor/tools.js");
  const { getStudent, snapshot } = await import("../src/store.js");

  const student = getStudent("st_test0001");
  const session = { messages: [], activeExerciseId: null };
  session.activeExerciseId = createExercise(student, { problem: "3(x + 4) = 2x + 19", source: "student" }).id;

  const r = await tutorTurn({ student, session, text: "3x + 4 = 2x + 19" });

  assert.equal(r.reply, "Look at the left side: what does 3(x + 4) mean?");
  assert.deepEqual(r.trace.map((t) => t.tool), ["check_step", "record_mistake"]);
  assert.match(r.trace[0].summary, /INVALID/);

  // The real engine result went back to the model.
  const toolResult = requests[1].messages.at(-1).content[0];
  assert.equal(toolResult.tool_use_id, "tu_1");
  assert.equal(JSON.parse(toolResult.content).equivalent, false);

  // The student's words are a plain user turn; context is a separate system message.
  const [userMsg, sysMsg] = requests[0].messages;
  assert.deepEqual(userMsg, { role: "user", content: "3x + 4 = 2x + 19" });
  assert.equal(sysMsg.role, "system");
  assert.match(sysMsg.content, /Active exercise \(chosen by the student\): 3\(x \+ 4\) = 2x \+ 19/);
  assert.match(sysMsg.content, /Student profile:/);

  // Request shape: Haiku 5.5 by default, no fallbacks (Haiku has none).
  assert.equal(requests[0].model, "claude-haiku-5-5");
  assert.equal(requests[0].output_config.effort, "medium");
  assert.equal(requests[0].fallbacks, undefined);
  assert.equal(requests[0].tools.length, 7);

  // History is append-only: each request extends the previous one.
  assert.equal(requests[2].messages.length, requests[1].messages.length + 2);

  const p = snapshot(student);
  assert.equal(p.totals.mistakes_found, 1);
  assert.equal(p.totals.steps_checked, 1);
  assert.equal(p.skills.distributive_property.mistakes, 1);
});
