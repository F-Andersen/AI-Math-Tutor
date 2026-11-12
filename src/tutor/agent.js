// The tutoring loop: Claude decides what to check, what to log and what to say;
// the server executes its tool calls against the algebra engine and the store.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.js";
import { TOOLS, runTool, activeExercise } from "./tools.js";
import { MathError } from "../math/engine.js";
import { profileForTutor } from "../store.js";

export const MODEL = process.env.TUTOR_MODEL || "claude-opus-5-5";
const EFFORT = process.env.TUTOR_EFFORT || "medium";
const USE_FALLBACKS = process.env.TUTOR_FALLBACKS !== "off";
const MAX_ITERATIONS = 10;

let client = null;
const getClient = () => (client ??= new Anthropic());
export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** Context the model needs before reading the student's message. */
function contextBlock(student, session) {
  const parts = [];
  if (!session.profileSent) {
    parts.push(`[Student profile]\n${profileForTutor(student)}`);
    session.profileSent = true;
  }
  const ex = activeExercise(student, session);
  if (ex && session.announcedExerciseId !== ex.id) {
    parts.push(
      `[Active exercise${ex.source === "tutor" ? " (practice problem you assigned)" : " (chosen by the student)"}]\nSolve: ${ex.problem}`
    );
    session.announcedExerciseId = ex.id;
  }
  if (!ex) parts.push("[No active exercise. If the student gives a new equation, work on it with them.]");
  return parts.join("\n\n");
}

/**
 * Run one student turn. Mutates session.messages (append-only, full content
 * blocks kept so thinking blocks stay valid) and returns the reply + trace.
 */
export async function tutorTurn({ student, session, text }) {
  const context = contextBlock(student, session);
  session.messages.push({
    role: "user",
    content: [
      ...(context ? [{ type: "text", text: context }] : []),
      { type: "text", text: `[Student]\n${text}` },
    ],
  });

  const trace = [];
  const replyParts = [];
  let usage = { input: 0, output: 0, cache_read: 0 };

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

    usage.input += response.usage.input_tokens ?? 0;
    usage.output += response.usage.output_tokens ?? 0;
    usage.cache_read += response.usage.cache_read_input_tokens ?? 0;

    session.messages.push({ role: "assistant", content: response.content });
    for (const b of response.content) if (b.type === "text" && b.text.trim()) replyParts.push(b.text.trim());

    if (response.stop_reason === "refusal") {
      replyParts.push("Let's stay with the math exercise — can you show me your next step?");
      break;
    }
    if (response.stop_reason === "pause_turn") continue;

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

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

  return {
    reply: replyParts.join("\n\n") || "Can you show me your next step?",
    trace,
    usage,
  };
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError)
    return { status: 503, message: "The AI model is not configured: set ANTHROPIC_API_KEY on the server." };
  if (err instanceof Anthropic.RateLimitError) return { status: 429, message: "The AI model is busy. Try again in a moment." };
  if (err instanceof Anthropic.APIConnectionError) return { status: 502, message: "Could not reach the AI model." };
  if (err instanceof Anthropic.APIError) return { status: 502, message: `AI model error (${err.status}): ${err.message}` };
  return { status: 500, message: err.message || "Unexpected error" };
}
