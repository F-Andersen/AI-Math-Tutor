// The tutoring loop: Claude decides what to check, what to log and what to say;
// the server executes its tool calls against the algebra engine and the store.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.js";
import { TOOLS, runTool, activeExercise } from "./tools.js";
import { MathError } from "../math/engine.js";
import { profileForTutor } from "../store.js";

export const MODEL = process.env.TUTOR_MODEL || "claude-haiku-5-5";
const EFFORT = process.env.TUTOR_EFFORT || "medium";
// Server-side refusal fallbacks exist only for some models (not Haiku), so they
// are opt-in for models that support them.
const FALLBACK_CAPABLE = /^claude-(opus-5|sonnet-5-5|fable-5)/;
const USE_FALLBACKS = process.env.TUTOR_FALLBACKS !== "off" && FALLBACK_CAPABLE.test(MODEL);
const MAX_ITERATIONS = 10;

let client = null;
const getClient = () => (client ??= new Anthropic());
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
    parts.push(
      ex
        ? `Active exercise (${ex.source === "tutor" ? "a practice problem you assigned" : "chosen by the student"}): ${ex.problem}`
        : "There is no active exercise now. If the student gives a new equation, work on it with them."
    );
  }
  return parts.join("\n\n");
}

const textOf = (content) =>
  content
    .filter((b) => b.type === "text" && b.text.trim())
    .map((b) => b.text.trim())
    .join("\n\n");

/**
 * Run one student turn. History stays append-only (full content blocks are
 * kept so thinking blocks remain valid); a failed or refused turn is rolled
 * back to the last good prefix.
 */
export async function tutorTurn({ student, session, text }) {
  const checkpoint = session.messages.length;
  const context = contextFor(student, session);

  session.messages.push({ role: "user", content: text });
  if (context) session.messages.push({ role: "system", content: context });

  const trace = [];
  let reply = "";

  try {
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
        session.messages.length = checkpoint; // keep the history clean
        return {
          reply: "I can only help with the math exercise here. Can you show me your next step?",
          trace: [...trace, { tool: "refusal", summary: response.stop_details?.category ?? "declined", ok: false }],
        };
      }

      session.messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        // The answer to the student is the text of the final response only;
        // text written before tool calls is working commentary.
        reply = textOf(response.content);
        break;
      }

      const results = [];
      for (const call of toolUses) {
        try {
          const { result, summary } = runTool(call.name, call.input, { student, session });
          trace.push({ tool: call.name, input: call.input, summary, ok: true });
          results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
        } catch (err) {
          const message = err instanceof MathError ? err.message : `Internal error: ${err.message}`;
          trace.push({ tool: call.name, input: call.input, summary: message, ok: false });
          results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: message });
        }
      }
      session.messages.push({ role: "user", content: results });
    }
  } catch (err) {
    session.messages.length = checkpoint;
    throw err;
  }

  session.profileSent = true;
  // Whatever is active now, the tutor knows about it (it was announced, or the
  // tutor itself assigned/completed it during this turn).
  session.announcedExerciseId = activeExercise(student, session)?.id ?? "none";
  return { reply: reply || "Can you show me your next step?", trace };
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError)
    return { status: 503, message: "The tutor is offline: the server's Anthropic API key was rejected." };
  if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError)
    return { status: 503, message: `The tutor is offline: this API key cannot use the model "${MODEL}". Set TUTOR_MODEL to a model your key can use.` };
  if (err instanceof Anthropic.RateLimitError) return { status: 429, message: "The tutor is busy right now. Try again in a moment." };
  if (err instanceof Anthropic.APIConnectionError) return { status: 502, message: "Could not reach the AI service. Check the connection and try again." };
  if (err instanceof Anthropic.APIError) return { status: 502, message: `AI service error (${err.status ?? "unknown"}). Try again.` };
  return { status: 500, message: "Something went wrong on the server." };
}
