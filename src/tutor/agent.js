// The tutoring loop: Claude decides what to check, what to log and what to say;
// the server executes its tool calls against the algebra engine and the store.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.js";
import { TOOLS, runTool, activeExercise } from "./tools.js";
import { MathError } from "../math/engine.js";
import { profileForTutor, save } from "../store.js";

export const MODEL = process.env.TUTOR_MODEL || "claude-haiku-5-5";
const EFFORT = process.env.TUTOR_EFFORT || "medium";
// Server-side refusal fallbacks exist only for some models (not Haiku), so they
// are opt-in for models that support them.
const FALLBACK_CAPABLE = /^claude-(opus-5|sonnet-5-5|fable-5)/;
const USE_FALLBACKS = process.env.TUTOR_FALLBACKS !== "off" && FALLBACK_CAPABLE.test(MODEL);
const MAX_ITERATIONS = 10;

class IncompleteTurnError extends Error {
  constructor(reason) {
    super(`Tutor turn did not finish: ${reason}`);
    this.name = "IncompleteTurnError";
  }
}

let client = null;
// A student should not wait minutes on a stuck request: 60 s per attempt, one retry.
const getClient = () => (client ??= new Anthropic({ timeout: 60_000, maxRetries: 1 }));
export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/**
 * Operator context for this turn (student profile, newly active exercise).
 * Sent as a mid-conversation system message, separate from the student's words,
 * so a student cannot impersonate it by typing "[Active exercise] ...".
 */
function contextFor(student, session) {
  const parts = [];
  if (!session.profileSent) parts.push(`Student profile:\n${profileForTutor(student)}`);
  const ex = activeExercise(student, session);
  if ((ex?.id ?? "none") !== session.announcedExerciseId) {
    if (ex) {
      parts.push(`Active exercise (${ex.source === "tutor" ? "a practice problem you assigned" : "chosen by the student"}): ${ex.problem}`);
      // Resumed after a page reload: the chat is gone but the checked lines are not.
      if (ex.steps.length)
        parts.push(
          "Lines of this exercise already checked in an earlier conversation:\n" +
            ex.steps.map((s) => `- ${s.line} (${s.equivalent ? "valid" : "had an error"})`).join("\n")
        );
    } else parts.push("There is no active exercise now. If the student gives an equation to work on, start it as an exercise.");
  }
  return parts.join("\n\n");
}

const textOf = (content) =>
  content
    .filter((b) => b.type === "text" && b.text.trim())
    .map((b) => b.text.trim())
    .join("\n\n");

/**
 * Tools work on drafts: neither progress nor history is published until the
 * model finishes with a usable reply. A failed/refused turn discards both.
 * The HTTP layer serialises mutations per student while this draft is open.
 */
export async function tutorTurn({ student, session, text }) {
  const draftStudent = structuredClone(student);
  const draftSession = structuredClone(session);
  const { refused, ...turn } = await runTurn({ student: draftStudent, session: draftSession, text });
  if (!refused) {
    Object.assign(student, draftStudent);
    Object.assign(session, draftSession);
    save();
  }
  return turn;
}

async function runTurn({ student, session, text }) {
  const context = contextFor(student, session);
  const answerExerciseId = session.activeExerciseId;

  session.messages.push({ role: "user", content: text });
  if (context) session.messages.push({ role: "system", content: context });

  const trace = [];
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages: session.messages,
      cache_control: { type: "ephemeral" },
      ...(USE_FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    });

    if (response.stop_reason === "refusal") {
      return {
        refused: true,
        reply: "I can only help with the math exercise here. Can you show me your next step?",
        trace: [{ tool: "refusal", summary: response.stop_details?.category ?? "declined", ok: false }],
      };
    }

    // Truncated output (including partial tool input) is never a completed
    // turn. Keep it out of history and discard any earlier draft changes.
    if (!["end_turn", "tool_use", "pause_turn"].includes(response.stop_reason))
      throw new IncompleteTurnError(response.stop_reason ?? "missing stop reason");
    if (!Array.isArray(response.content)) throw new IncompleteTurnError("missing content");
    session.messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason === "end_turn") {
      // The answer to the student is the text of the final response only;
      // text written before tool calls is working commentary.
      const reply = textOf(response.content);
      if (toolUses.length || !reply) throw new IncompleteTurnError("missing final reply or unresolved tools");
      session.profileSent = true;
      session.announcedExerciseId = activeExercise(student, session)?.id ?? "none";
      return { reply, trace };
    }
    if (!toolUses.length) throw new IncompleteTurnError("tool_use without tools");

    const results = [];
    for (const call of toolUses) {
      try {
        const { result, summary } = runTool(call.name, call.input, { student, session, studentText: text, answerExerciseId });
        const ok = result.completed !== false;
        trace.push({ tool: call.name, input: call.input, summary, ok });
        results.push({ type: "tool_result", tool_use_id: call.id, ...(!ok ? { is_error: true } : {}), content: JSON.stringify(result) });
      } catch (err) {
        if (!(err instanceof MathError)) throw err;
        const message = err.message;
        trace.push({ tool: call.name, input: call.input, summary: message, ok: false });
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: message });
      }
    }
    session.messages.push({ role: "user", content: results });
  }
  throw new IncompleteTurnError("iteration limit");
}

export function describeError(err) {
  if (err instanceof IncompleteTurnError)
    return { status: 502, message: "The tutor could not finish this reply. Your exercise and progress are unchanged. Send your message again." };
  if (err instanceof Anthropic.AuthenticationError)
    return { status: 503, message: "The tutor is offline: the server's Anthropic API key was rejected." };
  if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError)
    return { status: 503, message: `The tutor is offline: this API key cannot use the model "${MODEL}". Set TUTOR_MODEL to a model your key can use.` };
  if (err instanceof Anthropic.RateLimitError) return { status: 429, message: "The tutor is busy right now. Try again in a moment." };
  if (err instanceof Anthropic.APIConnectionError) return { status: 502, message: "Could not reach the AI service. Check the connection and try again." };
  if (err instanceof Anthropic.APIError) return { status: 502, message: `AI service error (${err.status ?? "unknown"}). Try again.` };
  return { status: 500, message: "Something went wrong on the server." };
}
