const $ = (id) => document.getElementById(id);

const DEMO = { problem: "3(x + 4) = 2x + 19", firstStep: "3x + 4 = 2x + 19" };
const SAMPLES = ["3(x + 4) = 2x + 19", "5x − 7 = 2x + 8", "2(x − 3) = x + 4", "x/2 + 3 = 7"];

const SKILL_NAMES = {
  distributive_property: "Opening brackets",
  combining_like_terms: "Combining like terms",
  inverse_operations: "Undoing operations",
  sign_handling: "Plus and minus signs",
  arithmetic: "Arithmetic",
  fractions: "Fractions",
  equation_balance: "Keeping both sides balanced",
  other: "Other",
};
const skillName = (s) => SKILL_NAMES[s] ?? s.replace(/_/g, " ");

const RESULTS = {
  independent: ["On my own", "own"],
  with_guidance: ["With help", "help"],
  revealed: ["Answer shown", "shown"],
  abandoned: ["Skipped", "skip"],
  active: ["In progress", "active"],
};

const state = {
  studentId: null,
  sessionId: null,
  busy: false,
  activeId: null,
  shownExercise: null, // last exercise shown in the notebook (kept after solving)
  mistakesSeen: 0,
};

// ---------- helpers ----------
function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

function makeId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return "st_" + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
  if (!res.ok) throw Object.assign(new Error(data.error || `Server error (${res.status})`), { status: res.status });
  return data;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "2.6");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  p.setAttribute("d", kind === "ok" ? "M4 12.5l5 5L20 6.5" : "M6 6l12 12M18 6L6 18");
  svg.append(p);
  return svg;
}

// ---------- chat ----------
const log = () => $("log");
function scrollDown() { log().scrollTop = log().scrollHeight; }

function tutorAvatar() {
  const a = el("div", "avatar");
  a.setAttribute("aria-hidden", "true");
  a.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20l1.2-4.4L15.6 5.2a2 2 0 012.8 0l.4.4a2 2 0 010 2.8L8.4 18.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 7.3l3.2 3.2" stroke="currentColor" stroke-width="1.8"/></svg>';
  return a;
}

function addMessage(who, text, extraClass = "") {
  const m = el("div", `msg msg--${who} ${extraClass}`.trim());
  if (who === "tutor") m.append(tutorAvatar());
  const b = el("div", "bubble");
  for (const para of String(text).split(/\n{2,}/)) b.append(el("p", "", para));
  m.append(b);
  log().append(m);
  scrollDown();
  return m;
}

function addTyping() {
  const m = el("div", "msg msg--tutor");
  m.append(tutorAvatar());
  const b = el("div", "bubble");
  const t = el("span", "typing");
  t.append(el("i"), el("i"), el("i"), document.createTextNode("Checking your step…"));
  b.append(t);
  m.append(b);
  log().append(m);
  scrollDown();
  return m;
}

function addEvent(kind, label, equation) {
  const e = el("div", `event event--${kind}`);
  e.append(document.createTextNode(label));
  if (equation) e.append(el("span", "eq", equation));
  log().append(e);
  scrollDown();
}

function setBusy(b) {
  state.busy = b;
  $("send").disabled = b;
  document.querySelectorAll(".chip").forEach((c) => (c.disabled = b));
}

async function sendMessage(text) {
  text = text.trim();
  if (!text || state.busy) return;
  addMessage("student", text);
  const typing = addTyping();
  setBusy(true);
  try {
    const r = await api("/api/message", { sessionId: state.sessionId, text });
    typing.remove();
    addMessage("tutor", r.reply);
    renderTrace(r.trace);
    render(r, { announce: true });
  } catch (err) {
    typing.remove();
    addMessage("tutor", err.message, "msg--error");
    if (err.status === 404) await startSession();
  } finally {
    setBusy(false);
  }
}

// ---------- rendering ----------
function renderNotebook(progress, active) {
  let ex = active;
  let solved = false;
  if (!ex && state.shownExercise) {
    ex = progress.exercises.find((e) => e.id === state.shownExercise) ?? null;
    solved = ex?.status === "completed";
    if (!solved) ex = null;
  }
  state.shownExercise = ex?.id ?? null;

  $("task-empty").hidden = Boolean(ex);
  $("task").hidden = !ex;
  $("quick").hidden = !active;
  const badge = $("task-kind");
  badge.hidden = !ex;
  if (!ex) return;

  $("task-eq").textContent = ex.problem;
  const practice = ex.source === "tutor";
  badge.textContent = practice ? "Practice" : "Your equation";
  badge.className = `badge ${practice ? "badge--practice" : "badge--own"}`;
  $("task-note").textContent = solved
    ? "Solved. Pick a new equation when you are ready."
    : practice
      ? "Same idea, new numbers. Show every step so the tutor can see your thinking."
      : "Solve for x. Send one line at a time.";

  const lines = $("lines");
  lines.replaceChildren();
  for (const s of ex.steps) {
    const li = el("li", s.equivalent ? "ok" : "bad");
    const work = el("span", "work", s.line);
    const mark = el("span", "mark");
    mark.append(icon(s.equivalent ? "ok" : "bad"), el("span", "mark__text", s.equivalent ? "correct" : "look again"));
    mark.title = s.equivalent ? "This step keeps the equation balanced" : "This step changes the answer";
    li.append(work, mark);
    lines.append(li);
  }
  if (solved) {
    const li = el("li");
    li.append(el("span"), el("span", "solved-stamp", "Solved!"));
    lines.append(li);
  }
  $("lines-empty").hidden = ex.steps.length > 0 || solved;
}

function renderProgress(progress) {
  const t = progress.totals;
  $("s-done").textContent = t.exercises_completed;
  $("s-own").textContent = t.solved_independently;
  $("s-fixed").textContent = t.mistakes_verified_fixed;
  $("s-steps").textContent = t.steps_checked;

  const summary = $("summary");
  summary.replaceChildren();
  if (t.exercises_completed || t.mistakes_found) {
    const b1 = el("b", "", String(t.exercises_completed));
    const b2 = el("b", "", String(t.mistakes_verified_fixed));
    summary.append(b1, ` solved · `, b2, ` mistake${t.mistakes_verified_fixed === 1 ? "" : "s"} fixed`);
  } else summary.textContent = "Let’s practise equations";

  // Skills
  const skills = $("skills");
  skills.replaceChildren();
  const entries = Object.entries(progress.skills).filter(([, s]) => s.attempts || s.mistakes);
  if (!entries.length) skills.append(el("li", "muted", "Solve a few equations to see your skills here."));
  for (const [name, s] of entries) {
    const li = el("li");
    const top = el("div", "skill__top");
    const pct = s.attempts ? Math.round(s.mastery * 100) : 0;
    top.append(el("span", "", skillName(name)), el("span", "skill__pct", s.attempts ? `${pct}%` : "—"));
    const bar = el("div", "bar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `Mastery ${pct} percent`);
    const fill = el("span", pct < 60 ? "low" : "");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    const meta = el("div", "skill__meta", `${s.attempts} exercise${s.attempts === 1 ? "" : "s"} · ${s.mistakes} mistake${s.mistakes === 1 ? "" : "s"}`);
    li.append(top, bar, meta);
    skills.append(li);
  }

  // Mistakes
  const ml = $("mistakes");
  ml.replaceChildren();
  if (!progress.mistakes.length) ml.append(el("li", "muted", "No mistakes yet. Nice!"));
  for (const m of progress.mistakes) {
    const li = el("li", m.verified ? "fixed" : "");
    const top = el("div", "mistake__top");
    top.append(el("span", "", skillName(m.skill)), el("span", `status ${m.verified ? "status--fixed" : "status--work"}`, m.verified ? "Fixed" : "Practising"));
    li.append(top, el("p", "mistake__work", m.student_work), el("p", "mistake__desc", m.description));
    ml.append(li);
  }

  // History
  const h = $("history");
  h.replaceChildren();
  const done = progress.exercises.filter((e) => e.status !== "active");
  if (!done.length) h.append(el("li", "muted", "Nothing solved yet."));
  for (const e of done) {
    const [label, tone] = RESULTS[e.outcome ?? e.status] ?? ["—", "skip"];
    const li = el("li");
    li.append(el("span", "eq", e.problem), el("span", `result result--${tone}`, label));
    h.append(li);
  }
}

function announceChanges(progress, active) {
  // Exercise solved this turn?
  if (state.activeId && state.activeId !== active?.id) {
    const prev = progress.exercises.find((e) => e.id === state.activeId);
    if (prev?.status === "completed") {
      addEvent("good", "Solved: ", prev.problem);
      if (!active) state.shownExercise = prev.id;
    }
  }
  // New practice problem from the tutor?
  if (active && active.id !== state.activeId && active.source === "tutor") addEvent("practice", "New practice problem: ", active.problem);
  // Mistake saved to progress?
  const n = progress.totals.mistakes_found;
  if (n > state.mistakesSeen && progress.mistakes[0]) addEvent("note", `Saved to “Mistakes I’m working on”: ${skillName(progress.mistakes[0].skill)}`);
}

function render({ progress, activeExercise }, { announce = false } = {}) {
  if (announce) announceChanges(progress, activeExercise);
  state.activeId = activeExercise?.id ?? null;
  state.mistakesSeen = progress.totals.mistakes_found;
  renderNotebook(progress, activeExercise);
  renderProgress(progress);
}

function renderTrace(trace) {
  const list = $("trace");
  list.replaceChildren();
  if (!trace?.length) return void list.append(el("li", "muted", "No checks on the last turn."));
  for (const t of trace) {
    const li = el("li", t.ok ? "" : "fail");
    li.append(el("b", "", t.tool), document.createTextNode(` → ${t.summary}`));
    list.append(li);
  }
}

// ---------- actions ----------
async function startExercise(problem) {
  if (state.busy) return false;
  $("own-error").textContent = "";
  try {
    const r = await api("/api/exercise", { sessionId: state.sessionId, problem });
    state.shownExercise = null;
    addEvent("note", "New equation: ", problem);
    render(r);
    return true;
  } catch (err) {
    $("own-error").textContent = err.message;
    if (err.status === 404) await startSession();
    return false;
  }
}

async function startSession() {
  const r = await api("/api/session", { studentId: state.studentId });
  state.sessionId = r.sessionId;
  render(r);
}

function insertAtCursor(textarea, text) {
  const { selectionStart: s, selectionEnd: e, value } = textarea;
  textarea.value = value.slice(0, s) + text + value.slice(e);
  const pos = s + text.length;
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
  autosize();
}

function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight + 2, 160)}px`;
}

function selectTab(name) {
  $("app").dataset.tab = name;
  for (const [id, n] of [["tab-lesson", "lesson"], ["tab-progress", "progress"]]) {
    const tab = $(id);
    tab.setAttribute("aria-selected", String(n === name));
    tab.tabIndex = n === name ? 0 : -1;
  }
}

async function init() {
  state.studentId = storageGet("tutor.studentId") || makeId();
  storageSet("tutor.studentId", state.studentId);

  for (const p of SAMPLES) {
    const b = el("button", "sample", p);
    b.type = "button";
    b.addEventListener("click", () => startExercise(p).then((ok) => ok && $("input").focus()));
    $("samples").append(b);
  }

  try {
    const h = await api("/api/health");
    const foot = $("ai-status");
    foot.replaceChildren();
    if (h.ai_configured) foot.textContent = `Tutor powered by Claude (${h.model}). Your progress is saved for this browser.`;
    else {
      foot.append(el("span", "off", "Tutor offline:"), " the server has no AI key configured.");
      addMessage("tutor", "I’m offline right now: the server has no AI key configured. Ask your teacher or the site admin to set it up.", "msg--error");
    }
    await startSession();
  } catch (err) {
    $("ai-status").textContent = "Can’t reach the server.";
    addMessage("tutor", err.message, "msg--error");
  }

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("input").value;
    $("input").value = "";
    autosize();
    sendMessage(text);
  });
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("input").addEventListener("input", autosize);
  document.querySelectorAll(".key").forEach((k) => k.addEventListener("click", () => insertAtCursor($("input"), k.dataset.ins)));
  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => sendMessage(c.dataset.say)));

  $("own-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = $("own-input").value.trim();
    if (p && (await startExercise(p))) {
      $("own-input").value = "";
      $("input").focus();
    }
  });
  $("demo").addEventListener("click", async () => {
    if (await startExercise(DEMO.problem)) {
      $("input").value = DEMO.firstStep;
      autosize();
      $("input").focus();
    }
  });
  $("reset").addEventListener("click", async () => {
    if (!confirm("Clear all your progress and start over?")) return;
    await api("/api/reset", { studentId: state.studentId });
    log().querySelectorAll(".msg:not(:first-child), .event").forEach((n) => n.remove());
    renderTrace([]);
    state.shownExercise = null;
    await startSession();
    selectTab("lesson");
  });

  $("tab-lesson").addEventListener("click", () => selectTab("lesson"));
  $("tab-progress").addEventListener("click", () => selectTab("progress"));
  $("tab-lesson").parentElement.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = $("app").dataset.tab === "lesson" ? "progress" : "lesson";
    selectTab(next);
    $(next === "lesson" ? "tab-lesson" : "tab-progress").focus();
  });
}

init();
