# Sonido — OpenCode 2 notification plugin for Windows

Passive, dependency-free OpenCode 2 plugin that tells you what OpenCode just did
— using a **different sound for each situation**, so you know without looking at
the screen.

Sounds are the whole product. Sonido is **sound-only by design**: it shows no
toasts, and it plays each sound **inside OpenCode's own process** — no
`powershell.exe`, no child process at all.

## Sounds at a glance

| Sound file | You hear it when |
|---|---|
| `response.wav` | The assistant finished a turn |
| `attention.wav` | OpenCode asked you something (a form / question) |
| `completion.wav` | A planned task, phase, or wave completed |
| `error.wav` | The session hit an error |

Each sound plays **exactly once**. Works with any OpenCode 2 workflow, including
Gentle AI: everything flows through OpenCode's own plugin hooks.

## Quick install

```powershell
git clone https://github.com/draux-l/sonidosOpenCode.git sonido
cd sonido
powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

Then **restart OpenCode** — plugins are loaded at startup.

That is the whole setup: no `npm install`, no build step, and no `opencode.json`
entry.

The installer copies `sonido.ts`, `sonido-notify.ps1`, and every `*.wav` audio
asset from `plugin/` into `~/.config/opencode/plugins`. It syntax-checks the
PowerShell script first, and verifies that the installed bytes match the project
source byte-for-byte. Re-running it is safe and idempotent.

> `plugin/sonido-core.ts` is deliberately **not** installed. It is the test-only
> copy of the engine; OpenCode would try to load any extra `.ts` file in the
> plugins directory as a plugin.

## Requirements

| Requirement | Detail |
|---|---|
| OS | Windows 10/11 (tested on Windows 11) |
| OpenCode | **Verified: 2.0.30**, together with its bundled `@opencode/plugin` 2.0.4. No other 2.x build has been verified. |
| OpenCode 1.x | **Not supported.** Sonido 2.0.0 speaks the 2.x plugin API (`Plugin.define`, `ctx.event.subscribe()`). Use Sonido 1.1.0 with OpenCode 1.18.x. |
| Runtime | **Bun**, which OpenCode ships, for in-process audio through `bun:ffi`. See [How the sound is played](#how-the-sound-is-played). |
| PowerShell 5.1 | Only needed by the fallback renderer. Built into Windows; pwsh 7 is not used. |
| Node 22.18+ | Only to run the tests. The plugin has **zero** runtime dependencies. |

No `opencode.json` plugin entry is needed: OpenCode auto-discovers `*.ts` /
`*.js` files under the plugins directory.

## How the sound is played

Sonido picks a backend at load time and logs which one it got:

1. **In-process — the default, with zero child processes.** OpenCode runs on Bun,
   so Sonido loads `winmm.dll` through `bun:ffi` and calls
   `PlaySoundW` with `SND_FILENAME | SND_ASYNC | SND_NODEFAULT`. The WAV is read
   by the plugin's own process. Nothing is spawned, ever.
2. **Fallback — the fixed PowerShell renderer.** If `bun:ffi` is unavailable the
   plugin spawns `sonido-notify.ps1` under Windows PowerShell 5.1 instead, which
   plays `<kind>.wav` once (or a Windows system sound if the file is missing).

The log tells you exactly what happened:

```
SonidoPlugin initialized v2.0.0
in-process audio ready (bun:ffi + winmm)          # backend 1 selected
played attention.wav in process, no child process spawned
```

or, on a runtime without FFI:

```
bun:ffi unavailable, falling back to the PowerShell renderer: ...
spawning powershell for kind=attention, scriptPath=...
```

## One sound per event, not one per plugin instance

OpenCode reconciles and reloads local plugins constantly and does not always
dispose the previous instance, so **several instances of this plugin can be live
at the same time**, each classifying the same event on its own.

On a real 2.0.30 install, ten instances were live at once, which turned a single
notification into **ten** `powershell.exe` processes.

Sonido arbitrates between instances with a file-backed **play claim**
(`sonido-claim.json`, next to the plugin): the first instance to claim a slot
plays it, every other instance skips. The slot is the session id, falling back to
the event key, with a 1.5 s window — so two instances that classified the same
event differently cannot both play.

The claim **fails open**: a missing or corrupt claim file still plays. It can
never leave you silent.

Measured live on a real install — four live instances, one question event:

```
classified: 4   emitting: 4   blocked by the claim: 3   played: 1   spawns: 0
```

## Behavior

Sonido is **passive**: it observes OpenCode events and tool results but never
intercepts or mutates tool or permission execution, never blocks, and a
notification failure can never affect OpenCode.

| OpenCode 2 hook | What Sonido observes |
|---|---|
| `ctx.event.subscribe()` | `session.execution.succeeded` (turn finished), `session.execution.failed` / `session.step.failed` (errors), `permission.asked`, `form.created`, `session.created` / `session.deleted`. The names `session.idle` and `session.status` are still accepted defensively. |
| `ctx.session.hook("prompt")` | Clears a pending task-completion flag (an ordinary reply, not a phase end) |
| `ctx.tool.hook("execute.after")` | `task`, `todowrite`, `sdd-*`, `mem_session_summary`, `mem_session_end` — marks the session as a planned-task completion |

### When each sound plays

- **`response.wav`** — a top-level session emitted `session.execution.succeeded`
  with no task-completion flag: OpenCode simply finished answering.
- **`attention.wav`** — OpenCode emitted `form.created` (it is asking you
  something) or `permission.asked`.
- **`completion.wav`** — `session.execution.succeeded` fired *and* a
  planned-task signal was seen for that session.
- **`error.wav`** — `session.execution.failed` or `session.step.failed`.

> **Why `attention.wav` is rarer than you might expect:** OpenCode 2 stopped
> asking before accessing paths outside the project, so "it asked me about a
> directory" no longer exists as an event. The sound now comes from forms and
> any permission prompt your configuration still produces.

### How the completion flag works

The flag is set when any of these runs for the session:

- the `task` tool
- an `sdd-*` tool, `mem_session_summary`, or `mem_session_end`
- `todowrite`, reporting every todo as `completed` or `cancelled`

The flag is consumed by the next turn-finished event — that event becomes
`completion.wav` instead of `response.wav` — and is cleared by the `prompt` hook
and by `session.deleted`.

> OpenCode 2 removed the `todo.updated` event, so `todowrite` is observed through
> the tool hook instead.

### Safeguards

- **Subagent silence**: parent/child relationships are tracked from
  `session.created` (`data.parentID` / `data.title`). Responses and completions
  from subagent sessions are suppressed; only top-level sessions alert.
- **One sound per event across instances**: the play claim described above.
- **No duplicate sounds within an instance**: `session.execution.succeeded`,
  `session.idle`, and `session.status` share one dedupe key per session (2 s
  window). Permission and form events are deduped by their event id (1 h window);
  errors are deduped per session (5 s window).
- **Rate limiting**: at most 12 notifications per minute, at least 400 ms apart.
- **Bounded memory**: dedupe table (max 500 entries) and session table (max 200)
  evict oldest entries; session records are removed on `session.deleted`.
- **No dynamic code**: nothing from an event is interpolated into a script or a
  command. The in-process path only ever passes a file path to `PlaySoundW`, and
  the fallback renderer receives its payload as Base64 arguments.

## Customizing the sounds

Replace any file in `~/.config/opencode/plugins` — keeping the **exact same file
name** — with your own WAV:

| File name | Replaces |
|---|---|
| `response.wav` | assistant response sound |
| `attention.wav` | form / question sound |
| `completion.wav` | planned-task completion sound |
| `error.wav` | session error sound |

Use a standard uncompressed PCM WAV, which is what both `PlaySoundW` and
`System.Media.SoundPlayer` read reliably. If a file is missing or cannot be
played, in-process playback fails and the fallback renderer takes over, which
plays a Windows system sound instead.

## Uninstall / rollback

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

Removes exactly the Sonido files (`sonido.ts`, `sonido-notify.ps1`, the audio
assets, the legacy `quack.wav` left behind by 1.0.2, plus the runtime
`sonido.log` and `sonido-claim.json`) and leaves every other plugin untouched.
Uninstalling works even if you moved or deleted the project checkout.

Restart OpenCode afterward. To roll back to a previous version, reinstall from
the matching project checkout — the installer overwrites only the Sonido files.

## Troubleshooting

| Symptom | Check |
|---|---|
| No sound at all | An active audio device is required. Look in `sonido.log` for `ffi PlaySound failed` or `bun:ffi unavailable`. |
| Nothing happens | Confirm the plugin loaded: restart OpenCode, then look for the `SonidoPlugin initialized v2.0.0` line in `sonido.log`. |
| One sound plays several times | The play claim is not seeing its file. Confirm `sonido-claim.json` sits next to `sonido.ts` and is writable. |
| A sound is missing | Confirm all four `.wav` files are present and are uncompressed PCM. |
| `attention.wav` never fires | OpenCode 2 removed the external-directory prompt; only forms and configured permission prompts raise it now. |

The plugin writes a debug log next to itself (`sonido.log` in the plugins
directory when installed), one line per classified event, play claim, and spawn,
prefixed with an ISO timestamp.

Safe command-line smoke test for the fallback renderer (no interaction;
`-DryRun` plays nothing):

```powershell
powershell.exe -NoProfile -File plugin\sonido-notify.ps1 -Kind response -DryRun
powershell.exe -NoProfile -File plugin\sonido-notify.ps1 -Kind attention -DryRun
powershell.exe -NoProfile -File plugin\sonido-notify.ps1 -Kind completion -DryRun
powershell.exe -NoProfile -File plugin\sonido-notify.ps1 -Kind error -DryRun

# Play a sound for real through the fallback renderer:
powershell.exe -NoProfile -File plugin\sonido-notify.ps1 -Kind completion
```

## Privacy & security

- **Everything stays local.** Sonido makes no network requests and sends no
  telemetry. The only artifacts it writes are the local debug log and the play
  claim file.
- It never intercepts or mutates tool or permission execution and never blocks
  OpenCode.
- No event text is ever executed or interpolated into a command; the in-process
  path passes only a WAV path to `PlaySoundW`.
- All in-memory state is bounded and evicted (see Safeguards).

## Architecture

```
OpenCode 2 hooks ──► translateEvent ──► SonidoCore ──► createNotifier
(ctx.event.subscribe /   {type,data} ->   classify / suppress /   │
 ctx.session.hook("prompt") /            dedupe / rate-limit      │
 ctx.tool.hook("execute.after"))                                  │
                                                                  ▼
                                            play claim (sonido-claim.json, shared)
                                                                  │
                                            ┌─────────────────────┴─────────────────────┐
                                            ▼                                           ▼
                                  bun:ffi + winmm PlaySoundW               fallback: powershell.exe 5.1
                                  (in-process, zero child processes)       + fixed sonido-notify.ps1
                                            │                                           │
                                            └────────────► <kind>.wav ◄─────────────────┘
```

- `plugin/sonido.ts` — the OpenCode 2 entry point. It must default-export **only**
  a `Plugin.define({ id, setup })` definition: the 2.x loader rejects a plugin
  with any other export, so the whole engine is inlined here and the file imports
  nothing local. It translates `{ type, data }` events into the core's
  `{ type, properties }` contract, loads the audio backend, and owns the play
  claim.
- `plugin/sonido-core.ts` — the same engine, exported for the tests. It is
  intentionally a duplicate and is never installed. A drift-guard test fails if
  the two copies diverge.
- `plugin/sonido-notify.ps1` — the fallback renderer: decodes the Base64 payload
  and plays `<kind>.wav` once, or a Windows system sound. Runs under Windows
  PowerShell 5.1.
- `plugin/*.wav` — one sound per notification kind.
- `install.ps1` — idempotent installer/uninstaller with byte-verification.
- `tests/sonido.test.ts` — behavior tests (Node's built-in runner, zero deps).

## Development

```powershell
npm test
# or, equivalently:
node --test tests/sonido.test.ts
```

The suite covers classification, subagent suppression, deduplication, rate
limiting, memory bounds, failure isolation, the spawn contract, the
notifier/renderer boundary, the 2.x-to-core event translation, the entry's loader
contract, the cross-instance play claim, the audio backend, and drift between the
two engine copies.

The entry's `import { Plugin } from "@opencode/plugin"` resolves from OpenCode's
own dependency tree at runtime, so the test suite never imports the entry and
never needs `npm install` (the tests assert its loader contract on the source).
For editor type hints, `npm i -D @opencode/plugin typescript` enables them.

## License

The **code** in this repository is MIT — see [LICENSE](LICENSE). Use it, modify
it, redistribute it; just keep the copyright notice.

The **audio assets** in `plugin/` are **not** covered by the MIT license. They
are included only so the plugin works out of the box — do not reuse them outside
this repository. Their provenance is still being documented; if you believe you
hold rights to any of them, please open an issue.

## Limitations

- Sound requires an active audio device.
- In-process audio needs the Bun runtime. On a runtime without `bun:ffi`, Sonido
  falls back to spawning one `powershell.exe` per sound.
- A sound that fires for a session that existed before a plugin restart cannot
  know it was a subagent (session records are learned from `session.created`
  going forward); a completion alert may fire once for such sessions.
- The play claim collapses sounds to at most one per session per 1.5 s, so two
  genuinely different events for the same session inside that window produce a
  single sound.
- `attention.wav` depends on OpenCode emitting `form.created` or
  `permission.asked`; a configuration that never prompts will rarely hear it.
