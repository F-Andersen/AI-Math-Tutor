# AI Math Tutor

A web-based algebra tutor that checks a student's work **line by line**, finds the *reasoning* error behind a wrong step, guides the student with questions instead of giving the answer, then gives a similar practice problem to confirm the student understood. Progress (exercises, mistakes, skill mastery) is saved for each student.

Built with Node.js (no framework) and Claude (`claude-opus-5-5`) through the official Anthropic SDK, using tool use.

## Run it

```bash
npm install
cp .env.example .env      # then put your ANTHROPIC_API_KEY in .env
npm start                 # http://localhost:3000
```

Requires Node 20.6+. Other commands:

| Command | What it does |
|---|---|
| `npm test` | Tests for the algebra engine, plus a tool-loop test against a stub API (no key needed) |
| `npm run scenario` | Runs the assignment's test scenario in the terminal against the real model (needs a key) |
| `npm run dev` | Starts the server and restarts it when files change |

In the UI, click **Load test scenario**. It starts `3(x + 4) = 2x + 19` and fills in the student's wrong line `3x + 4 = 2x + 19`. Press Send and continue the dialogue.

## Test scenario: what happens

1. The student sends `3x + 4 = 2x + 19`.
2. The tutor calls `check_step("3(x + 4) = 2x + 19", "3x + 4 = 2x + 19")`. The engine returns: **not equivalent** (solution changes from x = 7 to x = 15). Left side changed from `3x + 12` to `3x + 4` (a change of −8), and the right side is unchanged.
3. From that report the tutor identifies the misconception: *the 3 was multiplied by x but not by 4 (distributive property)*. It logs the mistake with `record_mistake`.
4. It does **not** show the correct line. It asks a guiding question, such as "what does 3(x + 4) mean — how many 4s are there?". If the student stays stuck, help increases in steps: point to the location, then ask about the rule, then show an analogous example with different numbers, and only as a last resort reveal the step.
5. The student fixes the line. Each later line is checked the same way. When the student gives `x = 7`, `check_answer` confirms it by substitution and `complete_exercise` records the outcome ("with guidance").
6. The tutor calls `assign_practice_problem` with a new problem of the same structure, such as `4(x + 3) = 3x + 20`, linked to the logged mistake. The engine checks that the problem has a single solution.
7. If the student solves the practice problem with no mistakes, it is completed as "independent". The original mistake is then marked **Fixed & verified**, and mastery for `distributive_property` goes up.

## Technical approach

```
Browser (public/)  ──HTTP/JSON──  Node server (src/server.js)
                                   ├─ tutor/agent.js   Claude tool loop (Messages API)
                                   ├─ tutor/tools.js   6 tools the model can call
                                   ├─ math/engine.js   deterministic algebra checker
                                   └─ store.js         per-student progress (JSON file)
```

**Split of responsibilities: the LLM teaches, deterministic code checks the math.** LLMs make arithmetic slips and can agree with a wrong student. So every judgment about correctness comes from `math/engine.js`, a small exact-arithmetic (BigInt fractions) parser and solver for one-variable polynomial equations. It does more than compare final answers:

- `check_step` compares the previous line with the new line: is the solution set preserved, which transformation was used (rewrite, the same term added to both sides, both sides multiplied by k, or *invalid: sides changed by different amounts*), and how each side's value changed. This report shows **where** the reasoning broke, which is what the tutor needs to name the misconception.
- `check_answer` substitutes the student's value and shows both sides (57 vs 49 for x = 15).
- `solve_equation` gives the tutor the solution for its own reference.

**Teaching logic is model-driven, not scripted.** The system prompt ([src/tutor/prompt.js](src/tutor/prompt.js)) sets the teaching approach: verify every line, diagnose the misconception, ask one question at a time, increase help in steps, and assign a practice problem after a correction. The model decides when to call each tool, what to ask and how to personalise its explanation. No reply text is hard-coded. The **Tutor reasoning trace** panel shows the tool calls made on each turn, so reviewers can see the logic.

**Progress tracking is tied to tool calls.** Progress changes only through `record_mistake`, `complete_exercise` and `assign_practice_problem`. The server verifies them: completing an exercise with a wrong final answer is rejected, and practice problems must have a single solution. A mistake counts as *verified fixed* only when a practice problem linked to it is solved independently. Mastery per skill is an exponential moving average (independent = 1, guided = 0.5, revealed = 0). At the start of each session, the tutor receives a short profile of the student's past mistakes so it can personalise from the first message.

**Claude API details.** `claude-opus-5-5` with adaptive thinking and `effort: medium` (enough for tutoring dialogue, which keeps latency down). The system prompt and tools are byte-stable and prompt-cached. Conversation history is append-only, and full content blocks are kept so thinking blocks stay valid. A failed turn is rolled back to the last valid prefix. Server-side refusal fallbacks (`fallbacks: "default"`) are enabled; set `TUTOR_FALLBACKS=off` to disable them. The model can be changed with `TUTOR_MODEL`.

**What is deliberately simple in this prototype:** sessions are held in memory and progress is stored in a JSON file. There are no accounts; the student id is stored in `localStorage`. Replies are returned whole rather than streamed. The engine handles one variable and degree ≤ 2. Systems of equations, inequalities and rational equations would go to the LLM without verification, or need engine extensions.

## Scaling to Web, iOS and Android

1. **One backend, several clients.** The tutoring logic, engine and progress live behind the HTTP API (`/api/session`, `/api/exercise`, `/api/message`). Web, iOS and Android are thin clients on the same API, so teaching behaviour is the same on every platform and the API key never leaves the server.
2. **Web.** Keep the current UI as a responsive web app (it already works from 320 px). Add streaming replies over SSE and make it installable as a PWA for offline review of history.
3. **iOS and Android.** Use React Native (Expo) to share most UI code across both platforms, or SwiftUI and Jetpack Compose if native polish matters more. Add camera input for handwritten work: send a photo to Claude's vision input, ask it to transcribe the work into lines, and run the same `check_step` pipeline. Use push notifications for spaced-repetition reminders based on open mistakes.
4. **Backend for production.** Postgres for students, exercises and mistakes (the `store.js` interface maps directly to tables). Redis or the database for session state, so servers stay stateless and can scale horizontally behind a load balancer. Auth with OAuth or school SSO. Per-student rate limits and cost caps.
5. **Quality and cost.** Build an eval set of real student mistakes (a misconception taxonomy with expected diagnoses) and run it on every prompt or model change. Track tokens per completed exercise. Use a cheaper model or lower effort for simple turns, and keep stronger reasoning for diagnosing mistakes. Rewrite the engine in a shared library (or add SymPy as a service) to cover more topics.
6. **Teachers.** Add a teacher dashboard that groups mistakes by misconception across a class, using the same data the progress panel shows.

## Project layout

```
public/            index.html, styles.css, app.js  (UI)
src/server.js      HTTP API + static files
src/tutor/         agent loop, tools, system prompt
src/math/engine.js algebra engine
src/store.js       progress persistence
scripts/scenario.js live run of the test scenario
test/              node:test suites
```
