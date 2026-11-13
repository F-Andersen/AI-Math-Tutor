// HTTP regression: a model turn must not race a reset or another browser tab.
// Both servers bind locally; no external model requests or real keys are used.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("student mutations are blocked during a turn, and failure/retry preserves progress", { timeout: 15_000 }, async t => {
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  let phase = "failure";
  let calls = 0;
  const stub = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume the SDK request */ }
    const step = ++calls;
    let content;
    if (phase === "privacy" && step === 1) {
      content = [
        { name: "solve_equation", input: { equation: "3x = 9" } },
        { name: "check_step", input: { previous_equation: "3x = 9", student_equation: "x = 3" } },
        { name: "check_answer", input: { equation: "3x = 9", value: "3" } },
        { name: "record_mistake", input: { skill: "equation_balance", error_type: "changed_one_side", description: "You changed only one side.", student_work: "3x = 10", correct_work: "PRIVATE_CORRECT_WORK" } },
        { name: "assign_practice_problem", input: { equation: "2x = 8", skill: "equation_balance", targets_mistake_id: "", rationale: "PRIVATE_RATIONALE" } },
        { name: "private_unknown_tool_x = 3", input: {} },
      ].map((call, i) => ({ type: "tool_use", id: `tu_private_${i}`, ...call }));
    } else if (step === 1) {
      content = [{ type: "tool_use", id: "tu_http", name: phase === "failure" ? "check_step" : "complete_exercise",
        input: phase === "failure"
          ? { previous_equation: "2x = 14", student_equation: "x = 7" }
          : { final_answer: "7", outcome: "independent", skill: "inverse_operations" } }];
    } else {
      if (phase === "failure") {
        waiting.resolve();
        await release.promise;
      }
      content = phase === "failure" ? [] : [{ type: "text", text: phase === "privacy" ? "Check both sides of your equation." : "Your answer is correct." }];
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "msg_http", type: "message", role: "assistant", model: "claude-haiku-5-5", content,
      stop_reason: step === 1 ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  await new Promise(resolve => stub.listen(0, "127.0.0.1", resolve));
  t.after(() => { release.resolve(); stub.closeAllConnections(); stub.close(); });

  // Ask the OS for a free application port instead of competing with a dev server.
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-http-turn-"));
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir,
    ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.address().port}` };
  delete env.ANTHROPIC_AUTH_TOKEN;
  const child = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", d => { if (String(d).includes("AI math tutor on")) resolve(); });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`server exited with ${code}`)));
  });
  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const studentId = "st_busytest";
  const first = await (await post("/api/session", { studentId })).json();
  const second = await (await post("/api/session", { studentId })).json();
  const initial = await (await post("/api/exercise", { sessionId: first.sessionId, problem: "2x = 14" })).json();
  const pending = post("/api/message", { sessionId: first.sessionId, text: "x = 7" });
  await waiting.promise;
  for (const [route, body] of [
    ["/api/exercise", { sessionId: second.sessionId, problem: "3x = 9" }],
    ["/api/reset", { studentId }],
    ["/api/session", { studentId }],
    ["/api/message", { sessionId: second.sessionId, text: "x = 7" }],
  ]) assert.equal((await post(route, body)).status, 409, route);
  release.resolve();
  const failed = await pending;
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /unchanged/);

  const resumed = await post("/api/session", { studentId });
  assert.equal(resumed.status, 200); // lock released after failure
  const afterFailure = await resumed.json();
  assert.deepEqual(afterFailure.progress, initial.progress);
  assert.deepEqual(afterFailure.activeExercise, initial.activeExercise);

  phase = "success";
  calls = 0;
  const retry = await post("/api/message", { sessionId: afterFailure.sessionId, text: "x = 7" });
  assert.equal(retry.status, 200);
  const done = await retry.json();
  assert.equal(done.progress.totals.exercises_completed, 1);
  assert.equal(done.activeExercise, null);
  assert.equal(done.progress.skills.inverse_operations.attempts, 1);
  assert.equal((await post("/api/exercise", { sessionId: afterFailure.sessionId, problem: "3x = 9" })).status, 200);

  await t.test("the message response strips private tool inputs and calculated answers from traces", async () => {
    phase = "privacy";
    calls = 0;
    const response = await post("/api/message", { sessionId: afterFailure.sessionId, text: "3x = 10" });
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.doesNotMatch(raw, /PRIVATE_|correct_work|rationale|"input"|solutions|x = 3/);
    const data = JSON.parse(raw);
    assert.equal(data.trace.length, 6);
    assert.equal(data.activeExercise.problem, "3x = 9");
    assert.deepEqual(data.activeExercise.steps, []); // the tutor's own line stays private
  });
});
