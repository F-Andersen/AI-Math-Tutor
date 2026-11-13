// HTTP-level tests: the server survives malformed requests and never sends
// solutions to the browser. Runs the real server in a child process, without
// an API key (these routes do not call the model).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "tutor-srv-")) };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  child = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("AI math tutor on") && resolve());
    child.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
});

after(() => child?.kill());

const post = (p, body) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("malformed URLs and bodies get 4xx and the server keeps running", async () => {
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/session`, { method: "POST", body: "{not json" })).status, 400);
  assert.equal((await post("/api/session", null)).status, 400);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ai_configured, false);
});

test("the browser never receives solutions or tutor-only notes", async () => {
  const { sessionId } = await (await post("/api/session", { studentId: "st_srvtest01" })).json();
  const r = await post("/api/exercise", { sessionId, problem: "3(x + 4) = 2x + 19" });
  assert.equal(r.status, 200);
  const raw = await r.text();
  const data = JSON.parse(raw);
  assert.equal(data.activeExercise.problem, "3(x + 4) = 2x + 19");
  assert.doesNotMatch(raw, /solution|x = 7|correct_work|rationale/);
});

test("invalid equations are rejected without replacing the active exercise", async () => {
  const { sessionId } = await (await post("/api/session", { studentId: "st_srvtest02" })).json();
  await post("/api/exercise", { sessionId, problem: "2x = 8" });
  const bad = await post("/api/exercise", { sessionId, problem: "x + 1 = x + 1" });
  assert.equal(bad.status, 400);
  const msg = await post("/api/message", { sessionId, text: "x = 4" });
  assert.equal(msg.status, 503); // no API key: a clear "offline" error, not a crash
  const again = await post("/api/exercise", { sessionId, problem: "3x = 9" });
  const { progress } = await again.json();
  assert.deepEqual(progress.exercises.map((e) => [e.problem, e.status]), [["3x = 9", "active"], ["2x = 8", "abandoned"]]);
});

test("an unfinished exercise is resumed in a new session (page reload)", async () => {
  const studentId = "st_srvtest03";
  const first = await (await post("/api/session", { studentId })).json();
  await post("/api/exercise", { sessionId: first.sessionId, problem: "2x = 8" });
  await post("/api/exercise", { sessionId: first.sessionId, problem: "3x = 9" });
  const second = await (await post("/api/session", { studentId })).json();
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(second.activeExercise.problem, "3x = 9");
  assert.equal(second.progress.exercises.filter((e) => e.status === "active").length, 1);
  assert.ok(second.sessionId.length >= 32); // not guessable
});

test("reserved ids do not break the server, and responses carry security headers", async () => {
  const r = await post("/api/session", { studentId: "__proto__" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).progress.totals.exercises_completed, 0);
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
});

test("API calls are rate limited per address", async () => {
  let last;
  for (let i = 0; i < 620; i++) last = await post("/api/reset", { studentId: "st_ratelimit1" });
  assert.equal(last.status, 429);
});
