/**
 * Sonido — behavior tests for the passive OpenCode notification plugin.
 *
 * These tests run with Node's built-in test runner (`node --test`) and the
 * built-in assert module. No external dependencies (the plugin's
 * `@opencode-ai/plugin` import is type-only and erased at runtime).
 *
 * Coverage contract:
 *   - event classification (response / attention / completion / error / ignored)
 *   - planned-task completion detection (Task tool, sdd-* / mem_session_* tools,
 *     todowrite all-completed, todo.updated event, chat.message clearing)
 *   - top-level vs subagent suppression
 *   - deduplication (completion, response, permission, question, error events)
 *   - bounded memory (seen map, session map)
 *   - rate limiting (12/min, 400 ms min interval)
 *   - non-blocking / failure isolation (notifications never throw)
 *   - safe spawn contract (detached, unref'd, base64 payload, fixed script)
 *   - cross-boundary contract: the real PowerShell renderer accepts the notifier's args
 *   - no logic drift between plugin/sonido.ts and plugin/sonido-core.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  VERSION,
  DEFAULT_LIMITS,
  SonidoCore,
  createNotifier,
  resolveScriptPath,
  resolveLogPath,
  type Notification,
} from "../plugin/sonido-core.ts"

// ─── Helpers ────────────────────────────────────────────────────────────────

// Tests must not write logs into the repo tree; inject a no-op logger.
const noopLog = () => {}

const permissiveLimits = { minIntervalMs: 0, rateMax: 10_000 }

function idle(sessionID: string): unknown {
  return { type: "session.idle", properties: { sessionID } }
}

function statusIdle(sessionID: string): unknown {
  return { type: "session.status", properties: { sessionID, status: { type: "idle" } } }
}

function statusBusy(sessionID: string): unknown {
  return { type: "session.status", properties: { sessionID, status: { type: "busy" } } }
}

function sessionError(sessionID: string, err?: Record<string, unknown>): unknown {
  return { type: "session.error", properties: { sessionID, error: err } }
}

// Real permission.asked payload: `permission` is the permission name (a string)
// and `tool` is an object ({ messageID, callID }) that carries no display text.
function permissionAsked(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "permission.asked",
    properties: {
      id,
      sessionID: "s1",
      permission: "bash",
      patterns: ["git commit -m test"],
      tool: { messageID: "msg_1", callID: "call_1" },
      ...extra,
    },
  }
}

function questionAsked(id: string, questions: unknown[]): unknown {
  return { type: "question.asked", properties: { id, sessionID: "s1", questions } }
}

function sessionCreated(id: string, info: Record<string, unknown> = {}): unknown {
  return { type: "session.created", properties: { info: { id, title: "Session " + id, ...info } } }
}

function sessionDeleted(id: string): unknown {
  return { type: "session.deleted", properties: { info: { id } } }
}

function todoUpdated(sessionID: string, todos: unknown[]): unknown {
  return { type: "todo.updated", properties: { sessionID, todos } }
}

type CapturedSpawn = { cmd: string; args: string[]; opts: Record<string, unknown>; unrefCalled: boolean }

function fakeSpawn(captures: CapturedSpawn[], opts: { throwOnSpawn?: boolean } = {}) {
  return (cmd: string, args: string[], spawnOpts: Record<string, unknown>) => {
    if (opts.throwOnSpawn) throw new Error("spawn failed")
    const cap: CapturedSpawn = { cmd, args, opts: spawnOpts, unrefCalled: false }
    captures.push(cap)
    return { unref: () => { cap.unrefCalled = true } }
  }
}

function b64decode(value: string): string {
  return Buffer.from(value, "base64").toString("utf8")
}

function collect(core: SonidoCore, events: unknown[]): (Notification | null)[] {
  return events.map((evt) => core.handleEvent(evt))
}

// ─── Version / structure ────────────────────────────────────────────────────

test("plugin is versioned", () => {
  assert.equal(VERSION, "1.1.0")
})

test("resolveScriptPath points at the sibling PowerShell script", () => {
  const p = resolveScriptPath("file:///C:/proj/plugin/sonido.ts")
  assert.ok(p.endsWith("sonido-notify.ps1"), p)
  assert.ok(p.includes("plugin"), p)
})

test("resolveLogPath points at the sibling log file and never leaks a machine path", () => {
  const p = resolveLogPath("file:///C:/proj/plugin/sonido.ts")
  assert.ok(p.endsWith("sonido.log"), p)
  assert.ok(p.includes("plugin"), p)
  assert.ok(!p.includes("Users"), "log path must not reference a user profile")
})

test("default limits match the documented behavior", () => {
  assert.equal(DEFAULT_LIMITS.completionTTLMs, 2_000)
  assert.equal(DEFAULT_LIMITS.errorTTLMs, 5_000)
  assert.equal(DEFAULT_LIMITS.askTTLMs, 3_600_000)
  assert.equal(DEFAULT_LIMITS.rateMax, 12)
})

// ─── Event classification ───────────────────────────────────────────────────

test("session.idle for a top-level session emits the response sound", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [idle("s1")])
  assert.ok(n)
  assert.equal(n!.kind, "response")
  assert.equal(n!.title, "Response ready")
})

test("session.status idle emits the response sound", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [statusIdle("s1")])
  assert.ok(n)
  assert.equal(n!.kind, "response")
})

test("session.status busy/retry are not notifications", () => {
  const core = new SonidoCore({ log: noopLog })
  assert.deepEqual(collect(core, [statusBusy("s1")]), [null])
  assert.deepEqual(
    collect(core, [{ type: "session.status", properties: { sessionID: "s1", status: { type: "retry" } } }]),
    [null],
  )
})

test("Task tool flags the session: next idle emits the completion sound", () => {
  const core = new SonidoCore({ log: noopLog })
  core.onToolExecute("s1", "task", { input: "implement feature" })
  const n = core.handleEvent(idle("s1"))
  assert.ok(n)
  assert.equal(n!.kind, "completion")
  assert.equal(n!.title, "Task complete")
})

test("sdd-* tools flag the session for a completion", () => {
  const core = new SonidoCore({ log: noopLog })
  core.onToolExecute("s1", "sdd-spec")
  const n = core.handleEvent(idle("s1"))
  assert.ok(n)
  assert.equal(n!.kind, "completion")
})

test("mem_session_summary / mem_session_end flag the session for a completion", () => {
  for (const tool of ["mem_session_summary", "mem_session_end"]) {
    const core = new SonidoCore({ log: noopLog })
    core.onToolExecute("s1", tool)
    const n = core.handleEvent(statusIdle("s1"))
    assert.ok(n)
    assert.equal(n!.kind, "completion")
  }
})

test("todowrite with all todos completed flags the session for a completion", () => {
  const core = new SonidoCore({ log: noopLog })
  core.onToolExecute("s1", "todowrite", { todos: [{ status: "completed" }, { status: "cancelled" }] })
  const n = core.handleEvent(idle("s1"))
  assert.ok(n)
  assert.equal(n!.kind, "completion")
})

test("todowrite with pending todos does not flag the session", () => {
  const core = new SonidoCore({ log: noopLog })
  core.onToolExecute("s1", "todowrite", { todos: [{ status: "completed" }, { status: "pending" }] })
  const n = core.handleEvent(idle("s1"))
  assert.ok(n)
  assert.equal(n!.kind, "response")
})

test("todo.updated event with all todos completed flags the session", () => {
  const core = new SonidoCore({ log: noopLog })
  assert.equal(core.handleEvent(todoUpdated("s1", [{ status: "completed" }])), null) // bookkeeping only
  const n = core.handleEvent(idle("s1"))
  assert.ok(n)
  assert.equal(n!.kind, "completion")
})

test("chat.message clears a pending task-completion flag (ordinary answer, not phase end)", () => {
  const core = new SonidoCore({ log: noopLog })
  core.onToolExecute("s1", "task")
  core.onChatMessage("s1")
  const n = core.handleEvent(idle("s1"))
  assert.ok(n)
  assert.equal(n!.kind, "response")
})

test("session.deleted clears task-completion flags", () => {
  const core = new SonidoCore({ log: noopLog })
  core.onToolExecute("s1", "task")
  collect(core, [sessionDeleted("s1")])
  const n = core.handleEvent(idle("s1"))
  assert.ok(n)
  assert.equal(n!.kind, "response")
})

test("session.error emits the error notification with message", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [sessionError("s1", { name: "ApiError", message: "rate limited" })])
  assert.ok(n)
  assert.equal(n!.kind, "error")
  assert.match(n!.body, /ApiError/)
  assert.match(n!.body, /rate limited/)
})

test("session.error without error object still notifies", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [sessionError("s1")])
  assert.ok(n)
  assert.equal(n!.kind, "error")
})

test("permission.asked is an attention request that shows the real permission detail", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [permissionAsked("p1")])
  assert.ok(n)
  assert.equal(n!.kind, "attention")
  assert.equal(n!.title, "Permission request")
  assert.match(n!.body, /bash/)
  assert.match(n!.body, /git commit/)
})

test("permission.asked without a permission name falls back to the generic body", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [
    { type: "permission.asked", properties: { id: "p9", sessionID: "s1" } },
  ])
  assert.ok(n)
  assert.equal(n!.body, "OpenCode needs your approval")
})

test("question.asked is an attention request with question text", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [questionAsked("q1", ["Continue?"])])
  assert.ok(n)
  assert.equal(n!.kind, "attention")
  assert.match(n!.body, /Continue\?/)
})

// ─── Real OpenCode payload shapes (verified against opencode 1.18.x) ────────

// session.error serializes the error as { name, data: { message, ... } } for all
// SDK error variants (APIError, ProviderAuthError, UnknownError, ...).

test("session.error reads the nested error.data.message (APIError shape)", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [
    sessionError("s1", {
      name: "APIError",
      data: { message: "rate limited", statusCode: 429, isRetryable: false },
    }),
  ])
  assert.ok(n)
  assert.equal(n!.kind, "error")
  assert.match(n!.body, /APIError/)
  assert.match(n!.body, /rate limited/)
})

test("session.error reads the nested error.data.message (ProviderAuthError shape)", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [
    sessionError("s1", {
      name: "ProviderAuthError",
      data: { providerID: "anthropic", message: "invalid api key" },
    }),
  ])
  assert.ok(n)
  assert.match(n!.body, /invalid api key/)
})

test("session.error still reads flat error.message as a fallback", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [sessionError("s1", { name: "Error", message: "boom" })])
  assert.ok(n)
  assert.match(n!.body, /boom/)
})

test("session.error with data but no message falls back to the error name", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [sessionError("s1", { name: "MessageOutputLengthError", data: { length: 4096 } })])
  assert.ok(n)
  assert.equal(n!.kind, "error")
  assert.match(n!.body, /MessageOutputLengthError/)
})

// question.asked items are { header, question, options } (QuestionInfo schema).

test("question.asked reads the real {header, question, options} item shape", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [
    questionAsked("q1", [
      {
        header: "Confirm",
        question: "Continue with the refactor?",
        options: [
          { label: "Yes", description: "Proceed with the plan" },
          { label: "No", description: "Keep current code" },
        ],
      },
    ]),
  ])
  assert.ok(n)
  assert.equal(n!.kind, "attention")
  assert.match(n!.body, /Continue with the refactor\?/)
})

test("question.asked with multiple real items shows the first question", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [
    questionAsked("q2", [
      { header: "Scope", question: "Which files?", options: [] },
      { header: "Depth", question: "How deep?", options: [] },
    ]),
  ])
  assert.ok(n)
  assert.match(n!.body, /Which files\?/)
})

test("question.asked real items without a question fall back to the generic body", () => {
  const core = new SonidoCore({ log: noopLog })
  const [n] = collect(core, [questionAsked("q3", [{ header: "Only header", options: [] }])])
  assert.ok(n)
  assert.equal(n!.body, "OpenCode is asking a question")
})

test("unrelated events are ignored", () => {
  const core = new SonidoCore({ log: noopLog })
  const events = [
    { type: "message.updated", properties: {} },
    { type: "tui.toast.show", properties: { message: "hi" } },
    { type: "session.compacted", properties: { sessionID: "s1" } },
    { type: "permission.replied", properties: { permissionID: "p1" } },
    { type: "session.updated", properties: { info: { id: "s1" } } },
    { type: "file.edited", properties: { file: "x" } },
  ]
  assert.deepEqual(collect(core, events), events.map(() => null))
})

test("malformed events never throw and are ignored", () => {
  const core = new SonidoCore({ log: noopLog })
  const events: unknown[] = [
    null,
    undefined,
    42,
    "session.idle",
    {},
    { type: "session.idle" }, // missing properties
    { type: "session.idle", properties: {} }, // missing sessionID
    { type: "permission.asked", properties: {} }, // missing id
    { type: "question.asked", properties: {} }, // missing id
    { type: "session.error", properties: { error: { name: "X" } } }, // missing sessionID
    { type: "session.created", properties: {} }, // missing info
    { type: "todo.updated", properties: { todos: [] } }, // empty todos
  ]
  assert.deepEqual(collect(core, events), events.map(() => null))
})

// ─── Top-level suppression (session parent tracking) ────────────────────────

test("response for a subagent session (parentID) is suppressed", () => {
  const core = new SonidoCore({ log: noopLog })
  const events = [
    sessionCreated("child", { parentID: "root" }),
    idle("child"),
    idle("root"), // root is a real top-level session
  ]
  const [c1, c2, c3] = collect(core, events)
  assert.equal(c1, null) // session.created bookkeeping
  assert.equal(c2, null) // subagent response suppressed
  assert.ok(c3)
  assert.equal(c3!.kind, "response")
})

test("completion for a subagent session is suppressed even when task-flagged", () => {
  const core = new SonidoCore({ log: noopLog })
  collect(core, [sessionCreated("child", { parentID: "root" })])
  core.onToolExecute("child", "task")
  assert.equal(core.handleEvent(idle("child")), null)
})

test("completion for a sub-subagent (grandchild) is suppressed", () => {
  const core = new SonidoCore({ log: noopLog })
  collect(core, [sessionCreated("grand", { parentID: "child" })])
  assert.equal(core.handleEvent(idle("grand")), null)
})

test("title heuristic suppresses subagent responses when parentID is absent", () => {
  const core = new SonidoCore({ log: noopLog })
  collect(core, [sessionCreated("c2", { title: "Review the diff (subagent)" })])
  assert.equal(core.handleEvent(idle("c2")), null)
})

test("explicit null parentID is a top-level session", () => {
  const core = new SonidoCore({ log: noopLog })
  collect(core, [sessionCreated("t1", { parentID: null })])
  assert.ok(core.handleEvent(idle("t1")))
})

test("unknown sessions default to top-level", () => {
  const core = new SonidoCore({ log: noopLog })
  assert.ok(core.handleEvent(idle("never-seen")))
})

test("session.deleted forgets parent records", () => {
  const core = new SonidoCore({ log: noopLog })
  collect(core, [sessionCreated("child", { parentID: "root" }), sessionDeleted("child")])
  // No longer known as a subagent -> treated as top-level
  assert.ok(core.handleEvent(idle("child")))
})

test("completion body is enriched with the session title", () => {
  const core = new SonidoCore({ log: noopLog })
  collect(core, [sessionCreated("s1", { title: "Fix the flaky test" })])
  core.onToolExecute("s1", "task")
  const n = core.handleEvent(idle("s1"))
  assert.ok(n)
  assert.equal(n!.kind, "completion")
  assert.equal(n!.body, "Fix the flaky test")
})

// ─── Deduplication ──────────────────────────────────────────────────────────

test("duplicate permission ids notify once", () => {
  const core = new SonidoCore({ log: noopLog, limits: permissiveLimits })
  const [a, b, c] = collect(core, [permissionAsked("p1"), permissionAsked("p1"), permissionAsked("p2")])
  assert.equal(a!.kind, "attention")
  assert.equal(b, null)
  assert.equal(c!.kind, "attention")
})

test("duplicate question ids notify once", () => {
  const core = new SonidoCore({ log: noopLog, limits: permissiveLimits })
  const [a, b] = collect(core, [questionAsked("q1", ["A?"]), questionAsked("q1", ["A?"])])
  assert.ok(a)
  assert.equal(b, null)
})

test("repeated session.idle for the same session notifies once", () => {
  const core = new SonidoCore({ log: noopLog, limits: permissiveLimits })
  const [a, b] = collect(core, [idle("s1"), idle("s1")])
  assert.ok(a)
  assert.equal(b, null)
})

test("session.idle + session.status idle pair does not double-notify", () => {
  const core = new SonidoCore({ log: noopLog, limits: permissiveLimits })
  const [a, b] = collect(core, [idle("s1"), statusIdle("s1")])
  assert.ok(a)
  assert.equal(b, null)
})

test("response and task-completion use separate dedupe keys", () => {
  const core = new SonidoCore({ log: noopLog, limits: permissiveLimits })
  const [a] = collect(core, [idle("s1")]) // response:key
  assert.ok(a)
  assert.equal(a!.kind, "response")
  core.onToolExecute("s1", "task")
  const b = core.handleEvent(idle("s1")) // completion:key — not a duplicate
  assert.ok(b)
  assert.equal(b!.kind, "completion")
})

test("completion dedupe expires after the TTL window (fake clock, 2 s)", () => {
  let now = 1_000_000
  const core = new SonidoCore({ log: noopLog, nowMs: () => now })
  core.onToolExecute("s1", "task")
  assert.ok(core.handleEvent(idle("s1")))
  core.onToolExecute("s1", "task")
  assert.equal(core.handleEvent(idle("s1")), null)
  now += 3_000 // past completionTTLMs (2 s)
  core.onToolExecute("s1", "task")
  assert.ok(core.handleEvent(idle("s1")))
})

test("error events are deduplicated per session within the window (5 s)", () => {
  let now = 1_000_000
  const core = new SonidoCore({ log: noopLog, nowMs: () => now })
  const [a, b] = collect(core, [sessionError("s1"), sessionError("s1")])
  assert.ok(a)
  assert.equal(b, null)
  now += 6_000 // past errorTTLMs (5 s)
  assert.ok(core.handleEvent(sessionError("s1")))
})

// ─── Bounded memory ─────────────────────────────────────────────────────────

test("seen-map memory is bounded (500 unique asks)", () => {
  const core = new SonidoCore({ log: noopLog, limits: permissiveLimits })
  for (let i = 0; i < 600; i++) core.handleEvent(permissionAsked("p" + i))
  assert.ok(core.stats().seen <= 500)
  // Eviction removes the oldest entries
  assert.ok(core.handleEvent(permissionAsked("p0")), "oldest entry evicted -> notifies again")
})

test("session-map memory is bounded (200 sessions)", () => {
  const core = new SonidoCore({ log: noopLog })
  for (let i = 0; i < 250; i++) core.handleEvent(sessionCreated("s" + i))
  assert.ok(core.stats().sessions <= 200)
  // The very first session was evicted -> its idle is treated as top-level
  assert.ok(core.handleEvent(idle("s0")))
})

// ─── Rate limiting ──────────────────────────────────────────────────────────

test("rate limiter caps notifications at 12 per minute", () => {
  let now = 0
  const core = new SonidoCore({ log: noopLog, nowMs: () => now })
  const out: (Notification | null)[] = []
  for (let i = 0; i < 20; i++) {
    out.push(core.handleEvent(idle("burst" + i)))
    now += 500 // respects the 400 ms min interval; isolates the per-minute cap
  }
  const emitted = out.filter(Boolean).length
  assert.equal(emitted, 12)
  assert.equal(core.stats().rateLimited, 8)
})

// ─── Non-blocking / failure isolation ───────────────────────────────────────

test("a throwing notifier never propagates into handleEvent", () => {
  const core = new SonidoCore({
    log: noopLog,
    notify: () => { throw new Error("boom") },
  })
  const n = core.handleEvent(idle("s1"))
  assert.ok(n) // still classified as emitted
  assert.equal(core.stats().emitted, 1)
})

test("createNotifier swallows spawn errors", () => {
  const captures: CapturedSpawn[] = []
  const notify = createNotifier({
    scriptPath: "C:\\scripts\\sonido-notify.ps1",
    spawnFn: fakeSpawn(captures, { throwOnSpawn: true }),
    log: noopLog,
  })
  assert.doesNotThrow(() => notify({ kind: "attention", title: "T", body: "B" }))
  assert.equal(captures.length, 0)
})

// ─── Spawn contract (non-blocking, safe payload) ────────────────────────────

test("notifier spawns detached, unref'd powershell.exe with a base64 payload", () => {
  const captures: CapturedSpawn[] = []
  const notify = createNotifier({
    scriptPath: "C:\\scripts\\sonido-notify.ps1",
    spawnFn: fakeSpawn(captures),
    log: noopLog,
  })
  notify({ kind: "attention", title: "Permission request", body: "bash: run <danger> & $(evil)" })

  assert.equal(captures.length, 1)
  const { cmd, args, opts, unrefCalled } = captures[0]

  // Windows PowerShell 5.1 only (WinRT toast support); never pwsh.
  assert.ok(cmd.endsWith("WindowsPowerShell\\v1.0\\powershell.exe"), "uses Windows PowerShell 5.1")
  assert.ok(args.includes("-NoProfile"))
  assert.ok(args.includes("-File"))
  assert.ok(args.includes("C:\\scripts\\sonido-notify.ps1"))
  assert.ok(args.includes("-Kind"))
  assert.equal(args[args.indexOf("-Kind") + 1], "attention")

  // The obsolete -Count parameter must never be sent again.
  assert.ok(!args.includes("-Count"), "the removed -Count parameter must not be sent")

  // Dynamic content travels as Base64, never as interpolated arguments.
  const title = args[args.indexOf("-TitleB64") + 1]
  const body = args[args.indexOf("-BodyB64") + 1]
  assert.equal(b64decode(title), "Permission request")
  assert.equal(b64decode(body), "bash: run <danger> & $(evil)")

  // Fire-and-forget: detached, no stdio, hidden window, and unref'd.
  assert.equal(opts.detached, true)
  assert.equal(opts.stdio, "ignore")
  assert.equal(opts.windowsHide, true)
  assert.equal(unrefCalled, true)
})

test("notifier sends only the parameters the renderer declares", () => {
  const captures: CapturedSpawn[] = []
  const notify = createNotifier({
    scriptPath: "S.ps1",
    spawnFn: fakeSpawn(captures),
    log: noopLog,
  })
  notify({ kind: "completion", title: "T", body: "B" })
  assert.equal(captures.length, 1)
  const flags = captures[0].args.filter((arg) => arg.startsWith("-"))
  assert.deepEqual(flags, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "-File",
    "-Kind",
    "-TitleB64",
    "-BodyB64",
  ])
})

test("notifier supports configurable powershell path", () => {
  const captures: CapturedSpawn[] = []
  const notify = createNotifier({
    scriptPath: "S.ps1",
    powershellPath: "C:\\custom\\pw.exe",
    spawnFn: fakeSpawn(captures),
    log: noopLog,
  })
  notify({ kind: "completion", title: "T", body: "B" })
  assert.equal(captures[0].cmd, "C:\\custom\\pw.exe")
  assert.equal(captures[0].args[0], "-NoProfile")
})

// ─── Output hygiene ─────────────────────────────────────────────────────────

test("notification text is truncated to safe lengths", () => {
  const core = new SonidoCore({ log: noopLog, limits: permissiveLimits })
  const long = "x".repeat(300)
  const nErr = core.handleEvent({
    type: "session.error",
    properties: { sessionID: "s1", error: { name: "APIError", data: { message: long } } },
  })
  assert.ok(nErr)
  assert.ok(nErr!.body.length <= 240, `error body length ${nErr!.body.length}`)
  const nQ = core.handleEvent({
    type: "question.asked",
    properties: {
      id: "q1",
      sessionID: "s1",
      questions: [{ header: "H", question: long, options: [] }],
    },
  })
  assert.ok(nQ)
  assert.ok(nQ!.body.length <= 240, `question body length ${nQ!.body.length}`)
  assert.ok(nQ!.title.length <= 64)
})

// ─── Cross-boundary contract: the real renderer accepts the notifier's args ──
//
// The tests above never execute plugin/sonido-notify.ps1. A mismatch between the
// arguments createNotifier builds and the parameters the script declares (for
// example a removed -Count) would therefore pass unnoticed in CI while the
// installed plugin silently stopped playing a sound. This test closes that gap
// by running the real script with the exact arguments the notifier produced.

const POWERSHELL_51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const NOTIFIER_SCRIPT = fileURLToPath(new URL("../plugin/sonido-notify.ps1", import.meta.url))

function notifierArgsFor(notification: Notification): string[] {
  const captures: CapturedSpawn[] = []
  const notify = createNotifier({
    scriptPath: NOTIFIER_SCRIPT,
    spawnFn: fakeSpawn(captures),
    log: noopLog,
  })
  notify(notification)
  assert.equal(captures.length, 1, "the notifier must spawn exactly one process")
  return captures[0].args
}

/** Runs one real event through classification + notifier and returns the spawn args. */
function renderArgs(event: unknown, prepare?: (core: SonidoCore) => void): string[] {
  let emitted: Notification | undefined
  const core = new SonidoCore({
    log: noopLog,
    limits: permissiveLimits,
    notify: (n) => { emitted = n },
  })
  if (prepare) prepare(core)
  core.handleEvent(event)
  assert.ok(emitted, "expected the event to produce a notification")
  return notifierArgsFor(emitted)
}

test(
  "the real PowerShell renderer accepts every argument the notifier builds",
  { skip: process.platform === "win32" ? false : "Windows-only renderer" },
  () => {
    const cases: { label: string; args: string[] }[] = [
      { label: "response", args: renderArgs(idle("x-response")) },
      { label: "attention/permission", args: renderArgs(permissionAsked("x-perm")) },
      { label: "attention/question", args: renderArgs(questionAsked("x-question", ["Continue?"])) },
      { label: "error", args: renderArgs(sessionError("x-error", { name: "ApiError", message: "boom" })) },
      {
        label: "completion",
        args: renderArgs(idle("x-completion"), (core) => core.onToolExecute("x-completion", "task")),
      },
    ]

    for (const { label, args } of cases) {
      const result = spawnSync(POWERSHELL_51, [...args, "-DryRun"], { encoding: "utf8" })
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
      assert.equal(
        result.status,
        0,
        `${label}: the renderer rejected the arguments the notifier builds.\n${output}`,
      )
      assert.match(output, /SONIDO_OK/, `${label}: expected the renderer's dry-run confirmation.\n${output}`)
    }
  },
)

// ─── Duplication drift guard ────────────────────────────────────────────────
//
// plugin/sonido.ts must stay self-contained and default-export-only: the
// OpenCode loader rejects named exports, and it cannot import
// plugin/sonido-core.ts because any extra .ts file inside the plugins directory
// would itself be loaded as a plugin. The duplication is intentional, so this
// guard is what keeps the two copies honest.

function normalizeSource(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^\s*export\s+/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function sharedCoreRegion(file: string): string[] {
  const source = readFileSync(file, "utf8")
  const start = source.indexOf("function resolveLogPath")
  assert.ok(start >= 0, `resolveLogPath not found in ${file}`)
  const factory = source.indexOf("export default", start)
  return normalizeSource(factory >= 0 ? source.slice(start, factory) : source.slice(start))
}

test("plugin/sonido.ts and plugin/sonido-core.ts have not drifted", () => {
  const pluginEntryFile = fileURLToPath(new URL("../plugin/sonido.ts", import.meta.url))
  const testableCoreFile = fileURLToPath(new URL("../plugin/sonido-core.ts", import.meta.url))

  const pluginEntry = sharedCoreRegion(pluginEntryFile)
  const testableCore = sharedCoreRegion(testableCoreFile)

  const shared = Math.min(pluginEntry.length, testableCore.length)
  for (let i = 0; i < shared; i++) {
    if (pluginEntry[i] !== testableCore[i]) {
      assert.fail(
        `Core logic drifted at shared line ${i + 1}.\n` +
          `  plugin/sonido.ts:      ${pluginEntry[i]}\n` +
          `  plugin/sonido-core.ts: ${testableCore[i]}\n` +
          "Apply the change to BOTH files: sonido.ts must stay self-contained for the OpenCode loader.",
      )
    }
  }
  assert.equal(
    pluginEntry.length,
    testableCore.length,
    "The shared core region has a different length in plugin/sonido.ts and plugin/sonido-core.ts",
  )

  assert.match(
    readFileSync(pluginEntryFile, "utf8"),
    new RegExp(`const VERSION = "${VERSION}"`),
    "plugin/sonido.ts must advertise the same version as plugin/sonido-core.ts",
  )
})