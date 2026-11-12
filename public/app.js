const $ = (id) => document.getElementById(id);
const SCENARIO = { problem: "3(x + 4) = 2x + 19", firstStep: "3x + 4 = 2x + 19" };

const state = { studentId: null, sessionId: null, busy: false, lastExerciseId: null };

function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

function makeId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return "st_" + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------- Chat ----------
function addMessage(kind, who, text) {
  const m = el("div", `msg msg--${kind}`);
  m.append(el("span", "msg__who", who));
  if (text !== undefined) m.append(el("p", "", text));
  $("chat").append(m);
  $("chat").scrollTop = $("chat").scrollHeight;
  return m;
}
const addEvent = (text) => addMessage("event", text);

function setBusy(b) {
  state.busy = b;
  $("send").disabled = b;
  $("composer-status").textContent = b ? "Tutor is checking your work…" : "Enter — send · Shift+Enter — new line";
}

async function sendMessage(text) {
  if (!text.trim() || state.busy) return;
  addMessage("student", "Student", text);
  const pending = addMessage("tutor msg--pending", "Tutor");
  setBusy(true);
  try {
    const r = await api("/api/message", { sessionId: state.sessionId, text });
    pending.classList.remove("msg--pending");
    pending.append(el("p", "", r.reply));
    renderTrace(r.trace);
    render(r);
  } catch (err) {
    pending.remove();
    addMessage("error", "Error", err.message);
    if (err.status === 404) await startSession();
  } finally {
    setBusy(false);
    $("chat").scrollTop = $("chat").scrollHeight;
  }
}

// ---------- Rendering ----------
const LABELS = { independent: ["Independent", "ok"], with_guidance: ["Guided", "warn"], revealed: ["Revealed", "err"], abandoned: ["Skipped", "muted"], active: ["Active", "muted"] };
const tag = (text, tone) => el("span", `tag tag--${tone}`, text);
const pretty = (s) => s.replace(/_/g, " ");

function render({ progress, activeExercise }) {
  const t = progress.totals;
  $("k-done").textContent = t.exercises_completed;
  $("k-indep").textContent = t.solved_independently;
  $("k-mist").textContent = t.mistakes_found;
  $("k-fixed").textContent = t.mistakes_verified_fixed;
  $("k-steps").textContent = t.steps_checked;

  // Active exercise
  const ex = activeExercise;
  $("ex-problem").textContent = ex ? ex.problem : "No active exercise";
  $("ex-source").textContent = ex
    ? ex.source === "tutor" ? `Practice problem · assigned by tutor · skill: ${pretty(ex.skill)}` : "Chosen by student"
    : "Start a new equation or load the test scenario";
  $("ex-rationale").hidden = !(ex && ex.rationale);
  if (ex && ex.rationale) $("ex-rationale").textContent = ex.rationale;
  if (ex && ex.id !== state.lastExerciseId && ex.source === "tutor") addEvent(`New practice problem: ${ex.problem}`);
  state.lastExerciseId = ex ? ex.id : null;

  const steps = $("steps");
  steps.replaceChildren();
  const lines = ex ? ex.steps : [];
  if (!lines.length) {
    const tr = el("tr", "empty"); const td = el("td", "", "Steps appear here as the tutor verifies them."); td.colSpan = 3; tr.append(td); steps.append(tr);
  }
  lines.forEach((s, i) => {
    const tr = el("tr");
    tr.append(el("td", "", String(i + 1)), el("td", "", s.line));
    const c = el("td", "r"); c.append(s.equivalent ? tag("Valid", "ok") : tag("Error", "err")); tr.append(c);
    tr.title = s.transformation;
    steps.append(tr);
  });

  // Skills
  const skills = $("skills");
  skills.replaceChildren();
  const entries = Object.entries(progress.skills);
  if (!entries.length) { const tr = el("tr", "empty"); const td = el("td", "", "No data yet."); td.colSpan = 4; tr.append(td); skills.append(tr); }
  for (const [name, s] of entries) {
    const tr = el("tr");
    tr.append(el("td", "", pretty(name)), el("td", "n", String(s.attempts)), el("td", "n", String(s.mistakes)), el("td", "n", s.attempts ? `${Math.round(s.mastery * 100)}%` : "—"));
    skills.append(tr);
  }

  // Mistakes
  const ml = $("mistakes");
  ml.replaceChildren();
  if (!progress.mistakes.length) ml.append(el("li", "empty", "No mistakes logged."));
  for (const m of progress.mistakes) {
    const li = el("li");
    const head = el("div", "m-head");
    head.append(el("span", "m-skill", `${pretty(m.skill)} / ${pretty(m.error_type)}`), m.verified ? tag("Fixed", "ok") : tag("Open", "warn"));
    li.append(head, el("p", "m-work", m.student_work), el("p", "m-desc", m.description));
    ml.append(li);
  }

  // History
  const h = $("history");
  h.replaceChildren();
  if (!progress.exercises.length) { const tr = el("tr", "empty"); const td = el("td", "", "No exercises yet."); td.colSpan = 3; tr.append(td); h.append(tr); }
  for (const e of progress.exercises) {
    const tr = el("tr");
    const [label, tone] = LABELS[e.outcome ?? e.status] ?? ["—", "muted"];
    const res = el("td", "r"); res.append(tag(label, tone));
    tr.append(el("td", "", e.problem), el("td", "", e.source === "tutor" ? "Practice" : "Student"), res);
    h.append(tr);
  }
}

function renderTrace(trace) {
  const list = $("trace");
  list.replaceChildren();
  if (!trace?.length) { list.append(el("li", "empty", "No tool calls on this turn.")); return; }
  for (const t of trace) {
    const li = el("li", t.ok ? "" : "t-fail");
    li.append(el("span", "t-name", t.tool), document.createTextNode(" → " + t.summary));
    list.append(li);
  }
}

// ---------- Actions ----------
async function startExercise(problem) {
  $("problem-error").textContent = "";
  try {
    const r = await api("/api/exercise", { sessionId: state.sessionId, problem });
    addEvent(`New exercise: ${problem}`);
    render(r);
    return true;
  } catch (err) {
    $("problem-error").textContent = err.message;
    return false;
  }
}

async function startSession() {
  const r = await api("/api/session", { studentId: state.studentId });
  state.sessionId = r.sessionId;
  render(r);
}

async function init() {
  state.studentId = storageGet("tutor.studentId") || makeId();
  storageSet("tutor.studentId", state.studentId);
  $("meta-student").textContent = state.studentId.slice(0, 10);

  try {
    const h = await api("/api/health");
    $("meta-model").textContent = h.model;
    $("meta-ai").textContent = h.ai_configured ? "Online" : "No API key";
    $("meta-ai").classList.add(h.ai_configured ? "status--ok" : "status--err");
    if (!h.ai_configured) addMessage("error", "Server", "ANTHROPIC_API_KEY is not set on the server, so the tutor cannot reply. Add it to .env and restart.");
    await startSession();
  } catch (err) {
    $("meta-ai").textContent = "Offline";
    $("meta-ai").classList.add("status--err");
    addMessage("error", "Error", err.message);
  }

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("msg-input").value;
    $("msg-input").value = "";
    sendMessage(text);
  });
  $("msg-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
  });
  $("new-problem").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = $("problem-input").value.trim();
    if (p && (await startExercise(p))) { $("problem-input").value = ""; $("msg-input").focus(); }
  });
  $("load-scenario").addEventListener("click", async () => {
    if (await startExercise(SCENARIO.problem)) {
      $("msg-input").value = SCENARIO.firstStep;
      $("msg-input").focus();
    }
  });
  $("reset").addEventListener("click", async () => {
    if (!confirm("Delete all progress for this student?")) return;
    await api("/api/reset", { studentId: state.studentId });
    $("chat").querySelectorAll(".msg:not(.msg--system)").forEach((n) => n.remove());
    renderTrace([]);
    await startSession();
  });
}

init();
