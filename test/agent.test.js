// Plumbing test for the tutor loop: a local stub stands in for the Messages API,
// asks for check_step + record_mistake, then answers. Verifies tool execution,
// tool_result wiring, progress updates and append-only history. (The real
// teaching behaviour is exercised live with `npm run scenario`.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const requests = [];
let server;

before(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = JSON.parse(body);
    requests.push(json);
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
