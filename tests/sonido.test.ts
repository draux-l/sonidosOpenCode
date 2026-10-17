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
 *   - cross-instance claim: N live plugin instances produce one sound, not N
 *   - no logic drift between plugin/sonido.ts and plugin/sonido-core.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  VERSION,
  DEFAULT_LIMITS,
  SonidoCore,
  createNotifier,
  createPlayClaim,
  loadFfiSoundPlayer,
  resolveAudioDir,
  resolveClaimPath,
  resolveScriptPath,
  resolveLogPath,
  translateEvent,
  PLAY_CLAIM_TTL_MS,
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

// OpenCode 2.x delivers `{ id, created, type, data }` payloads; translateEvent
// maps them onto the `{ type, properties }` contract handleEvent already takes.
function v2Event(type: string, data: Record<string, unknown>): unknown {
  return { id: "evt_" + type, created: 1_700_000_000_000, type, data }
}

function handleV2(core: SonidoCore, event: unknown): Notification | null {
  const translated = translateEvent(event as any)
  return translated ? core.handleEvent(translated) : null
}

// ─── Version / structure ────────────────────────────────────────────────────

test("plugin is versioned", () => {
  assert.equal(VERSION, "2.0.0")
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

// ─── V2 (OpenCode 2.x) event translation ────────────────────────────────────
//
// OpenCode 2.x renamed the event envelope fields (properties -> data) and some
// events. translateEvent() normalizes both onto the core's contract, so the
// engine and its tests stay untouched.

test("V2 session.idle translates to the response sound", () => {
  const core = new SonidoCore({ log: noopLog })
  const n = handleV2(core, v2Event("session.idle", { sessionID: "s1" }))
  assert.ok(n)
  assert.equal(n!.kind, "response")
})

test("V2 session.status idle translates to the response sound", () => {
  const core = new SonidoCore({ log: noopLog })
  const n = handleV2(core, v2Event("session.status", { sessionID: "s1", status: { type: "idle" } }))
  assert.ok(n)
  assert.equal(n!.kind, "response")
})

test("V2 session.execution.succeeded translates to the response sound", () => {
  const core = new SonidoCore({ log: noopLog })
  const n = handleV2(core, v2Event("session.execution.succeeded", { sessionID: "s1" }))
  assert.ok(n)
  assert.equal(n!.kind, "response")
  assert.equal(n!.title, "Response ready")
})

test("V2 session.execution.succeeded is a completion when the session is task-flagged", () => {
  const core = new SonidoCore({ log: noopLog })
  core.onToolExecute("s1", "task")
  const n = handleV2(core, v2Event("session.execution.succeeded", { sessionID: "s1" }))
  assert.ok(n)
  assert.equal(n!.kind, "completion")
})

test("V2 session.execution.succeeded and session.idle share one dedupe key per session", () => {
  const core = new SonidoCore({ log: noopLog, limits: permissiveLimits })
  const a = handleV2(core, v2Event("session.execution.succeeded", { sessionID: "s1" }))
  assert.ok(a)
  assert.equal(a!.kind, "response")
  // The turn-finished signal must not double-beep when idle also fires.
  assert.equal(handleV2(core, v2Event("session.idle", { sessionID: "s1" })), null)
})

test("V2 session.created learns the session id, parentID and title from data", () => {
  const core = new SonidoCore({ log: noopLog })
  // A child session (parentID) is a subagent: its idle is suppressed.
  assert.equal(
    handleV2(core, v2Event("session.created", { sessionID: "child", parentID: "root", slug: "kid", title: "Review the diff (subagent)" })),
    null,
  )
  assert.equal(handleV2(core, v2Event("session.idle", { sessionID: "child" })), null)
  // A top-level session with a title enriches a completion notification body.
  handleV2(core, v2Event("session.created", { sessionID: "s1", slug: "s1", title: "Fix the flaky test" }))
  core.onToolExecute("s1", "task")
  const n = handleV2(core, v2Event("session.idle", { sessionID: "s1" }))
  assert.ok(n)
  assert.equal(n!.kind, "completion")
  assert.equal(n!.body, "Fix the flaky test")
})

test("V2 session.deleted forgets the session record", () => {
  const core = new SonidoCore({ log: noopLog })
  handleV2(core, v2Event("session.created", { sessionID: "child", parentID: "root", slug: "kid" }))
  assert.equal(handleV2(core, v2Event("session.idle", { sessionID: "child" })), null)
  assert.equal(handleV2(core, v2Event("session.deleted", { sessionID: "child" })), null)
  // No longer known as a subagent -> treated as top-level
  assert.ok(handleV2(core, v2Event("session.idle", { sessionID: "child" })))
})

test("V2 session.execution.failed emits the error sound with the structured error", () => {
  const core = new SonidoCore({ log: noopLog, limits: permissiveLimits })
  const n = handleV2(
    core,
    v2Event("session.execution.failed", {
      sessionID: "s1",
      error: { type: "ProviderError", message: "rate limited", status: 429 },
    }),
  )
  assert.ok(n)
  assert.equal(n!.kind, "error")
  assert.equal(n!.title, "OpenCode error")
  assert.match(n!.body, /ProviderError/)
  assert.match(n!.body, /rate limited/)
  // A failure with no structured error still notifies.
  const bare = handleV2(core, v2Event("session.execution.failed", { sessionID: "s2" }))
  assert.ok(bare)
  assert.equal(bare!.kind, "error")
  assert.equal(bare!.body, "Session error")
})

test("V2 session.step.failed emits the error sound for the failed step", () => {
  const core = new SonidoCore({ log: noopLog })
  const n = handleV2(
    core,
    v2Event("session.step.failed", {
      sessionID: "s1",
      assistantMessageID: "msg_1",
      error: { type: "OutputLengthError", message: "output too long" },
    }),
  )
  assert.ok(n)
  assert.equal(n!.kind, "error")
  assert.match(n!.body, /OutputLengthError/)
  assert.match(n!.body, /output too long/)
})

test("V2 permission.asked is an attention request with the action and its resources", () => {
  const core = new SonidoCore({ log: noopLog })
  const n = handleV2(
    core,
    v2Event("permission.asked", {
      id: "p1",
      sessionID: "s1",
      action: "bash",
      resources: ["git commit -m test"],
      source: { type: "tool", messageID: "msg_1", id: "call_1" },
    }),
  )
  assert.ok(n)
  assert.equal(n!.kind, "attention")
  assert.equal(n!.title, "Permission request")
  assert.match(n!.body, /bash/)
  assert.match(n!.body, /git commit/)
})

test("V2 form.created is an attention request showing the form title, else the first field title", () => {
  const core = new SonidoCore({ log: noopLog, limits: permissiveLimits })
  const titled = handleV2(
    core,
    v2Event("form.created", {
      form: {
        id: "f1",
        sessionID: "s1",
        title: "Continue with the refactor?",
        fields: [{ key: "answer", type: "string", title: "Yes or no?" }],
      },
    }),
  )
  assert.ok(titled)
  assert.equal(titled!.kind, "attention")
  assert.equal(titled!.title, "OpenCode needs your input")
  assert.match(titled!.body, /Continue with the refactor\?/)
  const untitled = handleV2(
    core,
    v2Event("form.created", {
      form: {
        id: "f2",
        sessionID: "s1",
        fields: [{ key: "scope", type: "string", title: "Which files?" }],
      },
    }),
  )
  assert.ok(untitled)
  assert.match(untitled!.body, /Which files\?/)
})

test("events that 2.x dropped translate to nothing", () => {
  const core = new SonidoCore({ log: noopLog })
  const events = [
    v2Event("session.error", { sessionID: "s1", error: { name: "APIError", message: "boom" } }),
    v2Event("question.asked", { id: "q1", sessionID: "s1", questions: ["Continue?"] }),
    v2Event("todo.updated", { sessionID: "s1", todos: [{ status: "completed" }] }),
    v2Event("session.updated", { info: { id: "s1" } }),
    v2Event("permission.replied", { permissionID: "p1" }),
  ]
  for (const event of events) assert.equal(translateEvent(event as any), null, String((event as any).type))
  assert.deepEqual(events.map((event) => handleV2(core, event)), events.map(() => null))
})

test("malformed V2 envelopes are ignored without throwing", () => {
  const core = new SonidoCore({ log: noopLog })
  const events: unknown[] = [
    null,
    undefined,
    42,
    "session.idle",
    {},
    { type: "session.idle" }, // no data
    { type: "session.idle", data: {} }, // no sessionID
    { type: "session.status", data: { sessionID: "s1" } }, // no status
    { type: "session.created", data: {} }, // no sessionID
    { type: "session.deleted", data: {} }, // no sessionID
    { type: "session.step.failed", data: {} }, // no sessionID
    { type: "permission.asked", data: { sessionID: "s1" } }, // no id
    { type: "form.created", data: {} }, // no form
    { type: "form.created", data: { form: {} } }, // form without id
  ]
  assert.deepEqual(events.map((event) => handleV2(core, event)), events.map(() => null))
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
    .replace(/^[ \t]*export[ \t]+/gm, "")
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

// ─── Entry contract (OpenCode 2.x loader) ───────────────────────────────────
//
// The entry cannot be imported here (OpenCode resolves "@opencode/plugin" from
// its own install, not from this checkout), so its loader contract is asserted
// on the source: 2.x rejects a plugin that is not a default-exported
// Plugin.define() definition, and it rejects any extra export.

const pluginEntrySource = readFileSync(
  fileURLToPath(new URL("../plugin/sonido.ts", import.meta.url)),
  "utf8",
)

test("the entry default-exports a Plugin.define() definition with an id and setup", () => {
  assert.match(
    pluginEntrySource,
    /import\s*\{\s*Plugin\s*\}\s*from\s*"@opencode\/plugin"/,
    "must import Plugin (a value, not a type) from @opencode/plugin",
  )
  assert.match(pluginEntrySource, /export default Plugin\.define\(\{/, "must default-export Plugin.define({ ... })")
  assert.match(pluginEntrySource, /id:\s*"sonido"/, "the plugin definition must declare an id")
  assert.match(pluginEntrySource, /setup/, "the plugin definition must declare a setup function")
})

test("the entry has no named exports", () => {
  const named = pluginEntrySource.match(/^\s*export\s+(?!default\b)[^\s(]+/gm) ?? []
  assert.deepEqual(named, [], "the OpenCode loader rejects a plugin with named exports")
})

test("the entry subscribes to the V2 event stream and registers the V2 hooks", () => {
  assert.match(pluginEntrySource, /ctx\.event\.subscribe\(/, "must consume the async event stream")
  assert.match(pluginEntrySource, /ctx\.tool\.hook\("execute\.after"/, "must register the tool hook")
  assert.match(pluginEntrySource, /ctx\.session\.hook\("prompt"/, "must register the prompt hook")
})

// ─── Cross-instance play claim ──────────────────────────────────────────────
//
// OpenCode reconciles and reloads local plugins constantly and does not always
// dispose the previous instance, so several instances of this plugin can be
// live at once. Every instance classifies the same event on its own, which on a
// real OpenCode 2.0.30 install turned one notification into TEN PowerShell
// processes. The claim makes exactly one instance play.

let claimSeq = 0

/** Every test gets its own file in the OS temp dir; the repo tree stays clean. */
function tempClaimPath(): string {
  claimSeq++
  return join(tmpdir(), `sonido-claim-test-${process.pid}-${claimSeq}.json`)
}

test("the play claim grants a slot once and refuses it again within the TTL", () => {
  let now = 1_000_000
  const claim = createPlayClaim({ path: tempClaimPath(), nowMs: () => now })
  assert.equal(claim("ses_1"), true, "the first claimant wins")
  assert.equal(claim("ses_1"), false, "a second instance must not replay the same slot")
  assert.equal(claim("ses_2"), true, "a different slot is independent")
  now += PLAY_CLAIM_TTL_MS + 1
  assert.equal(claim("ses_1"), true, "the slot frees up after the TTL")
})

test("the play claim never blocks the sound when its file is missing or corrupt", () => {
  const path = tempClaimPath()
  const claim = createPlayClaim({ path })
  assert.equal(claim("ses_1"), true, "a missing claim file must still play")
  writeFileSync(path, "{ this is not json")
  assert.equal(claim("ses_2"), true, "a corrupt claim file must still play")
})

test("ten live plugin instances of one event produce exactly one sound", () => {
  const captures: CapturedSpawn[] = []
  const claim = createPlayClaim({ path: tempClaimPath() })

  // Ten independent cores, each with its own dedupe map: this is what a real
  // install looks like after OpenCode has leaked plugin instances.
  const instances = Array.from(
    { length: 10 },
    () =>
      new SonidoCore({
        log: noopLog,
        limits: permissiveLimits,
        notify: createNotifier({
          scriptPath: "C:\\scripts\\sonido-notify.ps1",
          spawnFn: fakeSpawn(captures),
          log: noopLog,
          claim,
        }),
      }),
  )

  for (const core of instances) {
    core.handleEvent({ type: "session.idle", properties: { sessionID: "ses_shared" } })
  }

  assert.equal(
    captures.length,
    1,
    "one event must spawn exactly one PowerShell, not one per live instance",
  )
})

test("the notifier does not spawn when another instance already claimed the slot", () => {
  const captures: CapturedSpawn[] = []
  const notify = createNotifier({
    scriptPath: "C:\\scripts\\sonido-notify.ps1",
    spawnFn: fakeSpawn(captures),
    log: noopLog,
    claim: () => false,
  })
  notify({ kind: "response", title: "T", body: "B", sessionID: "ses_lost" })
  assert.equal(captures.length, 0, "a lost claim must not spawn a process")
})

test("the notifier still plays when no claim is configured", () => {
  const captures: CapturedSpawn[] = []
  const notify = createNotifier({
    scriptPath: "C:\\scripts\\sonido-notify.ps1",
    spawnFn: fakeSpawn(captures),
    log: noopLog,
  })
  notify({ kind: "response", title: "T", body: "B", sessionID: "ses_solo" })
  assert.equal(captures.length, 1, "without a claim every notification plays as before")
})

test("resolveClaimPath points at the sibling claim file", () => {
  const p = resolveClaimPath("file:///C:/proj/plugin/sonido.ts")
  assert.ok(p.endsWith("sonido-claim.json"), p)
  assert.ok(p.includes("plugin"), p)
})

// ─── Zero-process audio backend ─────────────────────────────────────────────
//
// The sound is played by winmm through bun:ffi, inside OpenCode's own process,
// so no PowerShell is ever created. Node (this runner) has no bun:ffi, so the
// loader must report "unavailable" and let the notifier fall back — never throw
// and never go silent.

test("loadFfiSoundPlayer reports unavailable instead of throwing off-Bun", async () => {
  const logged: string[] = []
  const player = await loadFfiSoundPlayer({ log: (msg) => logged.push(msg) })
  assert.equal(player, null, "Node has no bun:ffi, so the loader must yield null")
  assert.ok(logged.length >= 1, "the fallback must be logged, not swallowed")
})

test("the notifier plays in process and spawns nothing when the player succeeds", () => {
  const captures: CapturedSpawn[] = []
  const played: string[] = []
  const notify = createNotifier({
    scriptPath: "C:\\scripts\\sonido-notify.ps1",
    audioDir: "C:\\plugins",
    playSound: (wav) => {
      played.push(wav)
      return true
    },
    spawnFn: fakeSpawn(captures),
    log: noopLog,
  })

  notify({ kind: "attention", title: "T", body: "B", sessionID: "ses_x" })

  assert.equal(captures.length, 0, "no child process when the in-process player works")
  assert.equal(played.length, 1, "the in-process player must be asked exactly once")
  assert.ok(played[0].endsWith("attention.wav"), played[0])
})

test("the notifier falls back to spawning when in-process playback fails", () => {
  const captures: CapturedSpawn[] = []
  const notify = createNotifier({
    scriptPath: "C:\\scripts\\sonido-notify.ps1",
    audioDir: "C:\\plugins",
    playSound: () => false,
    spawnFn: fakeSpawn(captures),
    log: noopLog,
  })

  notify({ kind: "completion", title: "T", body: "B", sessionID: "ses_y" })

  assert.equal(captures.length, 1, "a failed in-process play must still make a sound")
})

test("resolveAudioDir points at the module directory, not the module file", () => {
  const p = resolveAudioDir("file:///C:/proj/plugin/sonido.ts")
  assert.ok(p.includes("plugin"), p)
  assert.ok(!p.includes("sonido.ts"), p)
})