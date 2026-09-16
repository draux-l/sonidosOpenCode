/**
 * SonidoCore — notification engine for the Sonido OpenCode plugin.
 *
 * Pure logic, dependency-injected clock/notifier/logger for testing.
 * No OpenCode-specific exports: this module is safe to import from tests.
 */
import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const VERSION = "1.1.0"

export type NotifyKind = "completion" | "response" | "attention" | "error"

export interface Notification {
  kind: NotifyKind
  title: string
  body: string
}

/** A classified event candidate, before suppression/dedupe/rate-limiting. */
export interface Candidate extends Notification {
  dedupeKey: string
  sessionID?: string
}

export interface CoreLimits {
  /** Max tracked dedupe keys (oldest evicted first). */
  seenMax: number
  /** Max tracked session records (oldest evicted first). */
  sessionMax: number
  /** Duplicate window for completion/response events (session.idle + session.status overlap). */
  completionTTLMs: number
  /** Duplicate window for session errors. */
  errorTTLMs: number
  /** Duplicate window for permission/question asks. */
  askTTLMs: number
  /** Max notifications per rate window. */
  rateMax: number
  rateWindowMs: number
  /** Minimum spacing between notifications. */
  minIntervalMs: number
}

export const DEFAULT_LIMITS: CoreLimits = {
  seenMax: 500,
  sessionMax: 200,
  completionTTLMs: 2_000,
  errorTTLMs: 5_000,
  askTTLMs: 3_600_000,
  rateMax: 12,
  rateWindowMs: 60_000,
  minIntervalMs: 400,
}

export interface CoreDeps {
  nowMs?: () => number
  notify?: (n: Notification) => void
  log?: (msg: string) => void
  limits?: Partial<CoreLimits>
}

export interface CoreStats {
  seen: number
  sessions: number
  emitted: number
  duplicates: number
  subagentDropped: number
  rateLimited: number
}

// ─── Logging ────────────────────────────────────────────────────────────────

/**
 * Resolves the sibling sonido.log next to this module. When installed this is
 * exactly `~/.config/opencode/plugins/sonido.log`; in a checkout it is the
 * plugin directory. Returns "" when the URL cannot be resolved (logging off).
 */
export function resolveLogPath(moduleURL: string): string {
  try {
    const p = fileURLToPath(new URL("sonido.log", moduleURL))
    if (p) return p
  } catch {
  }
  return ""
}

function createLogger(logPath: string): (msg: string) => void {
  return (msg: string): void => {
    if (!logPath) return
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {
    }
  }
}

const defaultLog = createLogger(resolveLogPath(import.meta.url))

// ─── Helpers ────────────────────────────────────────────────────────────────

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Truncates text without splitting a UTF-16 surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  let cut = max - 1 // reserve room for the ellipsis
  while (cut > 0 && s.charCodeAt(cut - 1) >= 0xd800 && s.charCodeAt(cut - 1) <= 0xdbff) cut--
  return s.slice(0, cut) + "…"
}

// ─── Core (suppression + dedupe + rate limit + emit) ────────────────────────

export class SonidoCore {
  private readonly nowMs: () => number
  private readonly notify: ((n: Notification) => void) | undefined
  private readonly log: (msg: string) => void
  private readonly limits: CoreLimits
  private readonly sessions = new Map<string, { parentID?: string; title?: string }>()
  private readonly seen = new Map<string, number>()
  private readonly lastEmitted: number[] = []
  private readonly taskCompletionSessions = new Set<string>()
  private readonly counts: CoreStats = {
    seen: 0,
    sessions: 0,
    emitted: 0,
    duplicates: 0,
    subagentDropped: 0,
    rateLimited: 0,
  }

  constructor(deps: CoreDeps = {}) {
    this.nowMs = deps.nowMs ?? Date.now
    this.notify = deps.notify
    this.log = deps.log ?? defaultLog
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits }
  }

  onChatMessage(sessionID?: string): void {
    if (sessionID) {
      this.taskCompletionSessions.delete(sessionID)
    }
  }

  onToolExecute(sessionID?: string, tool?: string, args?: any, output?: any): void {
    if (!sessionID || !tool) return
    const t = tool.toLowerCase()
    if (t === "task") {
      this.taskCompletionSessions.add(sessionID)
      this.log(`flagged task completion for session ${sessionID} via Task tool`)
      return
    }
    if (t === "mem_session_summary" || t === "mem_session_end" || t.startsWith("sdd-")) {
      this.taskCompletionSessions.add(sessionID)
      this.log(`flagged task completion for session ${sessionID} via ${tool}`)
      return
    }
    if (t === "todowrite") {
      try {
        const todos = Array.isArray(args?.todos) ? args.todos : []
        if (todos.length > 0 && todos.every((item: any) => item?.status === "completed" || item?.status === "cancelled")) {
          this.taskCompletionSessions.add(sessionID)
          this.log(`flagged task completion for session ${sessionID} via todowrite all completed`)
        }
      } catch {
      }
    }
  }

  /**
   * Processes one event. Never throws and never blocks: classification,
   * suppression, dedupe, rate limiting, and notification are all synchronous
   * and the notification is fire-and-forget.
   * Returns the emitted notification, or null when ignored/suppressed.
   */
  handleEvent(evt: unknown): Notification | null {
    try {
      if (evt === null || typeof evt !== "object") return null
      const e = evt as { type?: unknown; properties?: unknown }
      const type = e.type
      if (typeof type !== "string") return null
      const props =
        e.properties && typeof e.properties === "object" ? (e.properties as Record<string, any>) : {}

      // Session bookkeeping for parent tracking.
      if (type === "session.created") {
        const info = props.info as { id?: unknown; parentID?: unknown; title?: unknown } | undefined
        if (info && typeof info.id === "string") this.rememberSession(info as { id: string; parentID?: unknown; title?: unknown })
        return null
      }
      if (type === "session.deleted") {
        const info = props.info as { id?: unknown } | undefined
        if (info && typeof info.id === "string") {
          this.sessions.delete(info.id)
          this.taskCompletionSessions.delete(info.id)
        }
        return null
      }

      if (type === "todo.updated") {
        const todos = Array.isArray(props.todos) ? props.todos : []
        const sessionID = asString(props.sessionID)
        if (sessionID && todos.length > 0 && todos.every((item: any) => item?.status === "completed" || item?.status === "cancelled")) {
          this.taskCompletionSessions.add(sessionID)
          this.log(`flagged task completion for session ${sessionID} via todo.updated event`)
        }
        return null
      }

      const cand = this.classify(evt)
      if (!cand) return null

      this.log(`classified event: type=${type} kind=${cand.kind} sessionID=${cand.sessionID} dedupeKey=${cand.dedupeKey}`)

      if ((cand.kind === "completion" || cand.kind === "response") && cand.sessionID && this.isSubagent(cand.sessionID)) {
        this.counts.subagentDropped++
        this.log(`dropped subagent completion/response: ${cand.sessionID}`)
        return null
      }
      if (this.isSeen(cand.dedupeKey, this.ttlFor(cand.kind))) {
        this.counts.duplicates++
        this.log(`dropped duplicate: ${cand.dedupeKey}`)
        return null
      }
      if (!this.reserveRateSlot()) {
        this.counts.rateLimited++
        this.log(`dropped rate-limited: ${cand.dedupeKey}`)
        return null
      }

      let body = cand.body
      if (cand.kind === "completion" && cand.sessionID) {
        const rec = this.sessions.get(cand.sessionID)
        if (rec?.title) body = rec.title
      }
      const notification: Notification = {
        kind: cand.kind,
        title: truncate(cand.title, 64),
        body: truncate(body, 240),
      }

      this.log(`emitting notification: kind=${notification.kind} title=${notification.title}`)

      try {
        if (this.notify) this.notify(notification)
      } catch (err: any) {
        this.log(`notify error: ${err?.message || err}`)
      }
      this.counts.emitted++
      return notification
    } catch (err: any) {
      this.log(`handleEvent fatal error: ${err?.message || err}`)
      return null
    }
  }

  stats(): CoreStats {
    return { ...this.counts, seen: this.seen.size, sessions: this.sessions.size }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private classify(evt: unknown): Candidate | null {
    try {
      if (evt === null || typeof evt !== "object") return null
      const e = evt as { type?: unknown; properties?: unknown }
      const type = e.type
      if (typeof type !== "string") return null
      const props =
        e.properties && typeof e.properties === "object" ? (e.properties as Record<string, any>) : {}

      switch (type) {
        case "session.idle": {
          const sessionID = asString(props.sessionID)
          if (!sessionID) return null
          const isTaskDone = this.taskCompletionSessions.has(sessionID)
          if (isTaskDone) {
            this.taskCompletionSessions.delete(sessionID)
            return {
              kind: "completion",
              dedupeKey: `completion:${sessionID}`,
              sessionID,
              title: "Task complete",
              body: "Planned task or phase finished",
            }
          }
          return {
            kind: "response",
            dedupeKey: `response:${sessionID}`,
            sessionID,
            title: "Response ready",
            body: "OpenCode responded",
          }
        }
        case "session.status": {
          const sessionID = asString(props.sessionID)
          if (!sessionID) return null
          const status = props.status as { type?: unknown } | undefined
          if (!status || typeof status !== "object" || status.type !== "idle") return null
          const isTaskDone = this.taskCompletionSessions.has(sessionID)
          if (isTaskDone) {
            this.taskCompletionSessions.delete(sessionID)
            return {
              kind: "completion",
              dedupeKey: `completion:${sessionID}`,
              sessionID,
              title: "Task complete",
              body: "Planned task or phase finished",
            }
          }
          return {
            kind: "response",
            dedupeKey: `response:${sessionID}`,
            sessionID,
            title: "Response ready",
            body: "OpenCode responded",
          }
        }
        case "session.error": {
          const sessionID = asString(props.sessionID)
          if (!sessionID) return null
          const err = props.error as Record<string, any> | undefined
          const data = err?.data && typeof err.data === "object" ? (err.data as Record<string, any>) : undefined
          const name = asString(err?.name)
          const message = asString(data?.message) ?? asString(err?.message)
          const body = name && message ? `${name}: ${message}` : message || name || "Session error"
          return { kind: "error", dedupeKey: `error:${sessionID}`, sessionID, title: "OpenCode error", body }
        }
        case "permission.asked": {
          const id = asString(props.id)
          if (!id) return null
          // `permission` is the permission name (a string, e.g. "bash"), and `tool`
          // is an object ({ messageID, callID }) that carries no display text.
          // Accept the legacy object shape too, so the toast always shows detail.
          const permission = props.permission as unknown
          const permissionLabel =
            asString(permission) ??
            asString((permission as Record<string, any> | undefined)?.title) ??
            asString((permission as Record<string, any> | undefined)?.type)
          const patterns = Array.isArray(props.patterns)
            ? props.patterns.filter((p: unknown): p is string => typeof p === "string")
            : []
          const body = [permissionLabel, ...patterns].filter(Boolean).join(": ") || "OpenCode needs your approval"
          return { kind: "attention", dedupeKey: `perm:${id}`, title: "Permission request", body }
        }
        case "question.asked": {
          const id = asString(props.id)
          if (!id) return null
          const questions = Array.isArray(props.questions) ? props.questions : []
          let text = ""
          for (const q of questions) {
            const raw =
              typeof q === "string"
                ? q
                : q && typeof q === "object"
                  ? (q as any).question ??
                    (q as any).text ??
                    (q as any).prompt ??
                    (q as any).title
                  : undefined
            const t = asString(raw)
            if (t) {
              text = t
              break
            }
          }
          const body = text || "OpenCode is asking a question"
          return { kind: "attention", dedupeKey: `quest:${id}`, title: "OpenCode needs your input", body }
        }
        default:
          return null
      }
    } catch {
      return null
    }
  }

  private rememberSession(info: { id: string; parentID?: unknown; title?: unknown }): void {
    if (this.sessions.size >= this.limits.sessionMax) {
      const oldest = this.sessions.keys().next().value as string | undefined
      if (oldest !== undefined) this.sessions.delete(oldest)
    }
    this.sessions.set(info.id, {
      parentID: typeof info.parentID === "string" && info.parentID ? info.parentID : undefined,
      title: typeof info.title === "string" ? info.title : undefined,
    })
  }

  private isSubagent(sessionID: string): boolean {
    const rec = this.sessions.get(sessionID)
    if (!rec) return false // unknown sessions default to top-level
    if (rec.parentID) return true
    if (typeof rec.title !== "string") return false
    return rec.title.endsWith(" subagent)") || rec.title.endsWith("(subagent)")
  }

  private isSeen(key: string, ttlMs: number): boolean {
    const now = this.nowMs()
    const prev = this.seen.get(key)
    if (prev !== undefined && now - prev < ttlMs) return true
    this.seen.set(key, now)
    this.pruneSeen(now)
    return false
  }

  private pruneSeen(now: number): void {
    if (this.seen.size <= this.limits.seenMax) return
    // Drop expired entries first (they can no longer dedupe anything).
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.limits.askTTLMs) this.seen.delete(key)
    }
    // Then evict oldest entries until under the cap.
    while (this.seen.size > this.limits.seenMax) {
      const oldest = this.seen.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
  }

  private reserveRateSlot(): boolean {
    const now = this.nowMs()
    // Drop timestamps outside the rate window (in-place compaction).
    const cutoff = now - this.limits.rateWindowMs
    let write = 0
    for (const t of this.lastEmitted) {
      if (t >= cutoff) this.lastEmitted[write++] = t
    }
    this.lastEmitted.length = write
    const tail = this.lastEmitted.length > 0 ? this.lastEmitted[this.lastEmitted.length - 1] : undefined
    if (tail !== undefined && now - tail < this.limits.minIntervalMs) return false
    if (this.lastEmitted.length >= this.limits.rateMax) return false
    this.lastEmitted.push(now)
    return true
  }

  private ttlFor(kind: NotifyKind): number {
    switch (kind) {
      case "response":
      case "completion":
        return this.limits.completionTTLMs
      case "error":
        return this.limits.errorTTLMs
      case "attention":
        return this.limits.askTTLMs
    }
  }
}

// ─── Notifier (fire-and-forget PowerShell 5.1) ──────────────────────────────

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64")
}

export interface NotifierOptions {
  scriptPath: string
  powershellPath?: string
  log?: (msg: string) => void
  /** Injectable spawn for tests; defaults to node:child_process spawn. */
  spawnFn?: (cmd: string, args: string[], opts: Record<string, unknown>) => { unref?: () => void }
}

/**
 * Returns a notify() that spawns a detached, unref'd `powershell.exe` (5.1)
 * process running the fixed notify script. Never awaited; the returned
 * function is synchronous and always safe to call.
 */
export function createNotifier(opts: NotifierOptions): (n: Notification) => void {
  const spawnFn = opts.spawnFn ?? spawn
  const log = opts.log ?? defaultLog
  const powershellPath = opts.powershellPath ?? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const scriptPath = opts.scriptPath
  return (n: Notification): void => {
    try {
      if (!scriptPath) {
        log("notify script path unavailable; dropping notification")
        return
      }
      const args = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Kind",
        n.kind,
        "-TitleB64",
        b64(n.title),
        "-BodyB64",
        b64(n.body),
      ]
      log(`spawning powershell for kind=${n.kind}, scriptPath=${scriptPath}`)

      // If running inside Bun (OpenCode's default runtime), use Bun.spawn
      if (typeof (globalThis as any).Bun !== "undefined" && typeof (globalThis as any).Bun.spawn === "function") {
        const proc = (globalThis as any).Bun.spawn([powershellPath, ...args], {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        })
        if (proc && typeof proc.unref === "function") proc.unref()
        log(`spawned via Bun.spawn, pid=${proc?.pid}`)
      } else {
        const child = spawnFn(powershellPath, args, { detached: true, stdio: "ignore", windowsHide: true })
        if (child && typeof child.unref === "function") child.unref()
        log(`spawned via node:child_process, pid=${(child as any)?.pid}`)
      }
    } catch (err: any) {
      log(`notify spawn failed: ${err?.message || err}`)
    }
  }
}

/** Resolves the sibling sonido-notify.ps1 next to this module. */
export function resolveScriptPath(moduleURL: string): string {
  try {
    const p = fileURLToPath(new URL("sonido-notify.ps1", moduleURL))
    if (p) return p
  } catch {
  }
  return ""
}
