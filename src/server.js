// Minimal HTTP server: JSON API + static frontend. No framework needed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tutorTurn, describeError, aiConfigured, MODEL } from "./tutor/agent.js";
import { createExercise, activeExercise } from "./tutor/tools.js";
import { getStudent, snapshot, resetStudent, newId } from "./store.js";
import { MathError } from "./math/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, "../public");
const PORT = Number(process.env.PORT) || 3000;

/** In-memory tutoring sessions (conversation history). Progress itself is persisted. */
const sessions = new Map();

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 20_000) throw new MathError("Request too large");
  }
  return data ? JSON.parse(data) : {};
}

const validId = (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{6,64}$/.test(s);

function sessionFrom(body) {
  const s = sessions.get(body.sessionId);
  if (!s) throw Object.assign(new Error("Session expired — reload the page."), { status: 404, expose: true });
  return s;
}

function state(student, session) {
  return { progress: snapshot(student), activeExercise: session ? activeExercise(student, session) : null };
}

const routes = {
  "GET /api/health": async () => ({ ai_configured: aiConfigured(), model: MODEL }),

  "POST /api/session": async (body) => {
    if (!validId(body.studentId)) throw new MathError("Invalid student id");
    const student = getStudent(body.studentId);
    const session = { id: newId("s"), studentId: student.id, messages: [], activeExerciseId: null, busy: false };
    sessions.set(session.id, session);
    return { sessionId: session.id, ...state(student, session) };
  },

  "POST /api/exercise": async (body) => {
    const session = sessionFrom(body);
    const student = getStudent(session.studentId);
    const problem = String(body.problem ?? "").trim().slice(0, 120);
    const prev = activeExercise(student, session);
    if (prev) prev.status = "abandoned";
    const ex = createExercise(student, { problem, source: "student" });
    session.activeExerciseId = ex.id;
    return state(student, session);
  },

  "POST /api/message": async (body) => {
    const session = sessionFrom(body);
    const text = String(body.text ?? "").trim().slice(0, 2000);
    if (!text) throw new MathError("Empty message");
    if (!aiConfigured()) throw Object.assign(new Error("The AI model is not configured: set ANTHROPIC_API_KEY on the server."), { status: 503, expose: true });
    if (session.busy) throw Object.assign(new Error("The tutor is still answering."), { status: 409, expose: true });
    const student = getStudent(session.studentId);
    session.busy = true;
    const checkpoint = session.messages.length;
    const flags = { profileSent: session.profileSent, announcedExerciseId: session.announcedExerciseId };
    try {
      const turn = await tutorTurn({ student, session, text });
      return { ...turn, ...state(student, session) };
    } catch (err) {
      // Roll back the half-finished turn so the history stays a valid prefix.
      session.messages.length = checkpoint;
      Object.assign(session, flags);
      throw err;
    } finally {
      session.busy = false;
    }
  },

  "POST /api/reset": async (body) => {
    if (!validId(body.studentId)) throw new MathError("Invalid student id");
    resetStudent(body.studentId);
    for (const [id, s] of sessions) if (s.studentId === body.studentId) sessions.delete(id);
    return { ok: true };
  },
};

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const key = `${req.method} ${new URL(req.url, "http://localhost").pathname}`;
  const handler = routes[key];
  if (!handler) return req.method === "GET" ? serveStatic(req, res) : send(res, 404, { error: "Not found" });
  try {
    const body = req.method === "POST" ? await readJson(req) : {};
    send(res, 200, await handler(body));
  } catch (err) {
    if (err instanceof MathError || err instanceof SyntaxError) return send(res, 400, { error: err.message });
    if (err.expose) return send(res, err.status, { error: err.message });
    const { status, message } = describeError(err);
    console.error("[tutor]", err);
    send(res, status, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`AI math tutor on http://localhost:${PORT}  (model ${MODEL}, AI ${aiConfigured() ? "configured" : "NOT configured — set ANTHROPIC_API_KEY"})`);
});
