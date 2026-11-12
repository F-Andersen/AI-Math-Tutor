# AI Math Tutor

A web-based algebra tutor for school students. It checks the student's work **line by line**, finds the *reasoning* error behind a wrong step, and guides the student with questions instead of giving the answer. Then it gives a similar practice problem to confirm the student understood. Progress (exercises, mistakes, skill mastery) is saved for each student.

Built with Node.js (no framework) and Claude through the official Anthropic SDK, using tool use. The default model is Claude Haiku 5.5 (`claude-haiku-5-5`); any current Claude model can be set with `TUTOR_MODEL`.

## Run it

Requires Node 20.6+.

```bash
npm install
npm start
```

Open http://localhost:3000. The tutor needs an Anthropic API key, read from the `ANTHROPIC_API_KEY` **environment variable** of the server process. Set it in the terminal session you start the server from (it is not saved anywhere) or, when hosting, in the platform's secret / environment settings. See [Security](#security).

| Command | What it does |
|---|---|
| `npm test` | Algebra engine, tool loop (against a stub API) and HTTP server tests. No key needed |
| `npm run scenario` | Runs the assignment's test scenario in the terminal against the real model |
| `npm run dev` | Starts the server and restarts it when files change |

Optional environment variables: `TUTOR_MODEL` (default `claude-haiku-5-5`), `TUTOR_EFFORT` (`low` / `medium` / `high`, default `medium`), `PORT` (default 3000), `DATA_DIR` (default `./data`).

In the UI, pick **Try the demo mistake**. It starts `3(x + 4) = 2x + 19` and fills in the student's wrong line `3x + 4 = 2x + 19`. Press Send and continue the dialogue.

## Test scenario: what happens

1. The student sends `3x + 4 = 2x + 19`.
2. The tutor calls `check_step("3(x + 4) = 2x + 19", "3x + 4 = 2x + 19")`. The engine returns: **not equivalent** (the solution changes from x = 7 to x = 15). The left side changed from `3x + 12` to `3x + 4` (a change of −8), and the right side is unchanged.
3. From that report the tutor names the misconception (*the 3 was multiplied by x but not by 4: distributive property*) and logs it with `record_mistake`. The student sees the line marked as a wrong step.
4. The tutor does **not** show the correct line. It asks a guiding question, such as "what does 3(x + 4) mean — how many 4s are there?". If the student stays stuck, help increases in steps: point to the location, then ask about the rule, then show the rule on a different example, and only as a last resort reveal the step.
5. The student fixes the line. Each later line is checked the same way. When the student gives `x = 7`, `check_answer` confirms it by substitution and `complete_exercise` records it as solved "with help". The server will not record "independent" for an exercise with a logged mistake.
6. The tutor calls `assign_practice_problem` with a new problem of the same structure, such as `4(x + 3) = 3x + 20`, linked to the logged mistake. The engine checks that the problem has a single solution.
7. If the student solves the practice problem with no mistakes, the original mistake is marked **fixed**, and mastery of `distributive_property` goes up.

## Technical approach

```
Browser (public/)  ──HTTP/JSON──  Node server (src/server.js)
                                   ├─ tutor/agent.js   Claude tool loop (Messages API)
                                   ├─ tutor/tools.js   6 tools the model can call
                                   ├─ math/engine.js   deterministic algebra checker
                                   └─ store.js         per-student progress (JSON file)
```

**The model teaches; deterministic code checks the math.** LLMs make arithmetic slips and can agree with a wrong student. So every judgment about correctness comes from `math/engine.js`, a small parser and solver for one-variable polynomial equations with exact fractions (BigInt). It does more than compare final answers:

- `check_step` compares the previous line with the new line: is the solution set preserved, which transformation was used (rewrite, the same term added to both sides, both sides multiplied by k, or *invalid: sides changed by different amounts*), and how each side's value changed. This report shows **where** the reasoning broke, which the tutor needs to name the misconception.
- `check_answer` substitutes the student's value and shows both sides (57 vs 49 for x = 15).
- `solve_equation` gives the tutor the solution for its own reference.

**Teaching logic is model-driven, not scripted.** The system prompt ([src/tutor/prompt.js](src/tutor/prompt.js)) sets the teaching approach: verify every line, diagnose the misconception, ask one question at a time, increase help in steps, and assign a practice problem after a correction. The model decides when to call each tool, what to ask and how to personalise the explanation. No reply text is hard-coded. A collapsible "How the tutor checked your work" panel shows the tool calls for each turn, so teachers and reviewers can see the logic.

**Progress tracking is tied to verified tool calls.** Progress changes only through `record_mistake`, `complete_exercise` and `assign_practice_problem`, and the server checks them: an exercise cannot be completed with a wrong final answer, practice problems must have a single solution, and an exercise with a logged mistake is never counted as independent. A mistake counts as *fixed* only when a practice problem linked to it is solved independently. Mastery per skill is an exponential moving average (independent = 1, with help = 0.5, answer shown = 0). At the start of a session the tutor gets a short profile of the student's past mistakes, so it can personalise from the first message.

**Claude API details.** Adaptive thinking with `effort: medium`. The system prompt and tool list never change between requests, so they are prompt-cached. The exercise and student profile are sent as mid-conversation `system` messages, separate from the student's text, so a student cannot impersonate them. History is append-only and keeps full content blocks so thinking blocks stay valid. A failed or refused turn is rolled back to the last valid point. Server-side refusal fallbacks are switched on automatically only for models that support them (Opus 5.x, Sonnet 5.5, Fable); Haiku has none.

## Security

- **API key.** Read only from the server's environment (`process.env.ANTHROPIC_API_KEY`). The project never reads a key from a file, there is no key template in the repository, and the key is never sent to the browser. `.gitignore` still blocks `.env*`, `*.key` and `*.pem` as a safety net.
- **No answers in the browser.** API responses to the browser never include solutions or the tutor's private notes (the correct line, the reasoning behind a practice problem). Tests check this.
- **Cost protection for a public demo.** 30 tutor messages per IP per 5 minutes, at most 80 turns per conversation, idle conversations dropped after 2 hours, request body limited to 20 KB.
- **Robustness.** Malformed URLs or JSON get a 4xx response and cannot crash the server (covered by tests).

## Scaling to Web, iOS and Android

1. **One backend, several clients.** Tutoring logic, the engine and progress live behind the HTTP API (`/api/session`, `/api/exercise`, `/api/message`). Web, iOS and Android are thin clients on the same API, so teaching behaviour is the same everywhere and the API key never leaves the server.
2. **Web.** The current UI is responsive down to 320 px. Next steps: streaming replies over SSE, and a PWA for offline review of past work.
3. **iOS and Android.** React Native (Expo) shares most UI code between both platforms; SwiftUI and Jetpack Compose are the option if native polish matters more. Add camera input for handwritten work: Claude's vision input transcribes the photo into lines, which go through the same `check_step` pipeline. Push notifications remind students to revisit mistakes they have not yet fixed (spaced repetition).
4. **Production backend.** Postgres for students, exercises and mistakes (the `store.js` interface maps directly to tables). Session state in Redis or the database, so servers are stateless and scale horizontally. Auth with school SSO or OAuth, plus per-account limits instead of per-IP.
5. **Quality and cost.** An eval set of real student mistakes (a misconception taxonomy with expected diagnoses), run on every prompt or model change. Track tokens per completed exercise. Keep Haiku for routine turns and route hard diagnoses to a stronger model. Extend the engine (or add SymPy as a service) to cover more topics: systems of equations, inequalities, rational equations.
6. **Teachers.** A dashboard that groups mistakes by misconception across a class, built on the same progress data.

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
