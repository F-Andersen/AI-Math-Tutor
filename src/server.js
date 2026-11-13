// Minimal HTTP server: JSON API + static frontend. No framework needed.
// The Anthropic API key comes from the process environment (the npm scripts
// also load an optional, git-ignored .env file); it is never sent to the browser.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tutorTurn, describeError, aiConfigured, MODEL } from "./tutor/agent.js";
import { createExercise, activeExercise } from "./tutor/tools.js";
import { getStudent, snapshot, resetStudent, newId, flush, publicExercise, publicTrace, save } from "./store.js";
import { MathError } from "./math/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, "../public");
const PORT = Number(process.env.PORT) || 3000;

const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // drop conversations idle for 2 h
const MAX_SESSIONS = 2000;
const MAX_TURNS_PER_SESSION = 80;
const WINDOW_MS = 5 * 60 * 1000;
// Per window. Tutor messages cost money, so they are limited per conversation
// (one student) and per address (a whole classroom can share one address, so
// that ceiling is higher and configurable). "request" covers every API call.
const LIMITS = {
  session: 20,
  message: Number(process.env.MESSAGES_PER_ADDRESS) || 150,
  request: 600,
};
// Behind a reverse proxy (nginx, Caddy, a PaaS) every request comes from the
// proxy's address. Set TRUST_PROXY=1 there so limits apply per real client.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** In-memory tutoring sessions (conversation history). Progress itself is persisted. */
const sessions = new Map();
// All sessions for one student share progress. Protect an in-flight draft from
// changes in another tab, a reload, or a reset until it commits or is discarded.
const busyStudents = new Set();
function requireIdleStudent(studentId) {
  if (busyStudents.has(studentId)) throw new HttpError(409, "Wait for the tutor to finish answering.");
}
setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff && !s.busy) sessions.delete(id);
}, 10 * 60 * 1000).unref();

/** Simple fixed-window rate limiter so a public demo link cannot burn API credit or fill the disk. */
const hits = new Map();
function rateLimit(kind, ip) {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > WINDOW_MS) return void hits.set(key, { start: now, count: 1 });
  if (++h.count > LIMITS[kind]) throw new HttpError(429, "Too many requests. Take a short break and try again in a few minutes.");
}
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, h] of hits) if (h.start < cutoff) hits.delete(key);
}, WINDOW_MS).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 20_000) throw new HttpError(413, "Request too large");
  }
  if (!data) return {};
  const parsed = JSON.parse(data);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Expected a JSON object");
  return parsed;
}

const validId = (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{6,64}$/.test(s);

function sessionFrom(body) {
  const s = sessions.get(body.sessionId);
  if (!s) throw new HttpError(404, "Your session expired. Reload the page to continue.");
  s.lastSeen = Date.now();
  return s;
}

/** What the browser may see: no solutions, no tutor-only notes. */
function state(student, session) {
  return { progress: snapshot(student), activeExercise: publicExercise(activeExercise(student, session)) };
}

const routes = {
  "GET /api/health": async () => ({ ai_configured: aiConfigured(), model: MODEL }),

  "POST /api/session": async (body) => {
    if (!validId(body.studentId)) throw new HttpError(400, "Invalid student id");
    requireIdleStudent(body.studentId);
    if (sessions.size >= MAX_SESSIONS) throw new HttpError(503, "The tutor is at capacity. Try again later.");
    const student = getStudent(body.studentId);
    // Resume the exercise that was in progress (e.g. after a page reload);
    // older unfinished ones are closed so they do not pile up as "active".
    const open = student.exercises.filter((e) => e.status === "active");
    const resume = open.pop() ?? null;
    for (const e of open) e.status = "abandoned";
    if (open.length) save();
    const session = { id: newId("s", 16), studentId: student.id, messages: [], activeExerciseId: resume?.id ?? null, busy: false, turns: 0, lastSeen: Date.now() };
    sessions.set(session.id, session);
    return { sessionId: session.id, ...state(student, session) };
  },

  "POST /api/exercise": async (body) => {
    const session = sessionFrom(body);
    requireIdleStudent(session.studentId);
    if (session.busy) throw new HttpError(409, "Wait for the tutor to finish answering.");
    const student = getStudent(session.studentId);
    const problem = String(body.problem ?? "").trim().slice(0, 120);
    if (!problem) throw new HttpError(400, "Type an equation first.");
    const ex = createExercise(student, { problem, source: "student" }); // validates before touching the old one
    const prev = activeExercise(student, session);
    if (prev) prev.status = "abandoned";
    session.activeExerciseId = ex.id;
    save();
    return state(student, session);
  },

  "POST /api/message": async (body, req) => {
    const session = sessionFrom(body);
    const text = String(body.text ?? "").trim().slice(0, 2000);
    if (!text) throw new HttpError(400, "Empty message");
    if (!aiConfigured()) throw new HttpError(503, "The tutor is offline: the server has no Anthropic API key configured.");
    requireIdleStudent(session.studentId);
    if (session.busy) throw new HttpError(409, "The tutor is still answering.");
    if (session.turns >= MAX_TURNS_PER_SESSION) throw new HttpError(409, "This conversation is very long. Reload the page to start a fresh one — your progress is saved.");
    rateLimit("session", session.id);
    rateLimit("message", clientIp(req));

    const student = getStudent(session.studentId);
    session.busy = true;
    busyStudents.add(student.id);
    try {
      const turn = await tutorTurn({ student, session, text });
      session.turns += 1;
      return { reply: turn.reply, trace: publicTrace(turn.trace), ...state(student, session) };
    } finally {
      session.busy = false;
      busyStudents.delete(student.id);
    }
  },

  "POST /api/reset": async (body) => {
    if (!validId(body.studentId)) throw new HttpError(400, "Invalid student id");
    requireIdleStudent(body.studentId);
    resetStudent(body.studentId);
    for (const [id, s] of sessions) if (s.studentId === body.studentId) sessions.delete(id);
    return { ok: true };
  },
};

function serveStatic(method, pathname, res) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  if (method === "HEAD") return res.end();
  fs.createReadStream(file)
    .on("error", () => res.destroy()) // file vanished mid-read: drop the connection, keep the server
    .pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) {
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(req.method, pathname, res);
      throw new HttpError(404, "Not found");
    }
    if (req.method === "POST") rateLimit("request", clientIp(req));
    const body = req.method === "POST" ? await readJson(req) : {};
    send(res, 200, await handler(body, req));
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    if (err instanceof MathError) return send(res, 400, { error: err.message });
    if (err instanceof SyntaxError || err instanceof URIError) return send(res, 400, { error: "Malformed request" });
    const { status, message } = describeError(err);
    console.error("[tutor]", err);
    send(res, status, { error: message });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use: another copy of the server is probably still running. Stop it, or set PORT to a free port.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`AI math tutor on http://localhost:${PORT}  (model ${MODEL}, AI ${aiConfigured() ? "configured" : "NOT configured: set the ANTHROPIC_API_KEY environment variable"})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}
