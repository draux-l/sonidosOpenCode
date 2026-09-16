# Sonido — OpenCode notification plugin for Windows

Passive, dependency-free OpenCode plugin that tells you when OpenCode needs you
— using a **different sound for each situation**, so you know what happened
without looking at the screen.

## Sounds at a glance

| Sound file | You hear it when | Toast |
|---|---|---|
| `response.wav` | The assistant finished responding | no |
| `attention.wav` | OpenCode asks for a permission or asks you a question | yes |
| `completion.wav` | A planned task, phase, or wave completed | no |
| `error.wav` | The session hit an error | yes |

Each sound is played **exactly once** — there are no repeated beeps to count.
Works with any OpenCode workflow, including Gentle AI: everything flows through
OpenCode's own plugin hooks, so no separate integration is needed.

## Quick install

Clone the repository and run the installer:

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

To confirm the install before relying on it, run the `-DryRun` smoke test in
[Troubleshooting](#troubleshooting).

## Requirements

| Requirement | Detail |
|---|---|
| OS | Windows 10/11 (tested on Windows 11) |
| OpenCode | 1.18.x (plugin loads into `~/.config/opencode/plugins`) |
| Shell | Windows PowerShell 5.1 (`powershell.exe`, built in) — required for WinRT toasts; pwsh 7 is not used |
| Runtime | Node 22.18+ only for running the tests; the plugin itself has **zero** runtime dependencies |

No `opencode.json` plugin entry is needed: OpenCode auto-discovers `*.ts` /
`*.js` files under the plugins directory.

## Behavior

Sonido is **passive**: it observes OpenCode events and tool results but never
intercepts or mutates tool or permission execution, never awaits notification
processes, and a notification failure can never affect OpenCode.

| OpenCode hook | What Sonido observes |
|---|---|
| `event` | `session.idle` / `session.status`, `session.error`, `permission.asked`, `question.asked`, `todo.updated`, `session.created` / `session.deleted` |
| `chat.message` | Clears a pending task-completion flag (an ordinary reply, not a phase end) |
| `tool.execute.after` | `task`, `todowrite`, `sdd-*`, `mem_session_summary`, `mem_session_end` — marks the session as a planned-task completion |

### When each sound plays

- **`response.wav`** — a top-level session went idle (or reported `status:
  idle`) with no task-completion flag: OpenCode simply finished answering.
- **`attention.wav`** — OpenCode emitted `permission.asked` or `question.asked`:
  it needs your approval or your input. A toast carries the detail.
- **`completion.wav`** — a session went idle *and* a planned-task signal was
  seen for it.
- **`error.wav`** — `session.error`: OpenCode hit an error. A toast carries the
  error name and message.

### How the completion flag works

The flag is set when any of these runs for the session:

- the `task` tool
- an `sdd-*` tool, `mem_session_summary`, or `mem_session_end`
- `todowrite`, reporting every todo as `completed` or `cancelled`
- a `todo.updated` event where every todo is `completed` or `cancelled`

The flag is consumed by the next idle event (that idle becomes `completion.wav`
instead of `response.wav`) and is cleared by `chat.message` and
`session.deleted`.

### Toasts

Only `attention` and `error` show a toast — `response` and `completion` are
sound-only by design.

| Kind | Toast title | Toast body |
|---|---|---|
| `attention` (permission) | `Permission request` | The permission name and its patterns, e.g. `bash: git commit -m test` |
| `attention` (question) | `OpenCode needs your input` | The first question's text |
| `error` | `OpenCode error` | `Name: message`, or whichever of the two is available |

Titles are capped at 64 characters and bodies at 240. A completion toast is
never shown, but a completion notification's body is enriched with the session
title.

### Safeguards

- **Subagent silence**: parent/child relationships are tracked from
  `session.created` metadata (`properties.info.parentID`). Responses and
  completions from subagent sessions are suppressed; only top-level sessions
  alert.
- **No duplicate sounds**: `session.idle` and `session.status` share one dedupe
  key per session (2 s window), so the same completion never beeps twice.
  Permission/question events are deduped by their event id (1 h window);
  errors are deduped per session (5 s window).
- **Rate limiting**: at most 12 notifications per minute, at least 400 ms apart.
- **Bounded memory**: dedupe table (max 500 entries) and session table (max 200)
  evict oldest entries; session records are removed on `session.deleted`.
- **Safe rendering**: all dynamic content is Base64-encoded and decoded inside a
  fixed PowerShell script; event text is never interpolated into executable
  code, and toast text is assigned through the XML DOM (`InnerText`), which
  escapes it.
- Toasts use a custom AppUserModelID (`Sonido.OpenCode`); no app registration is
  required on Windows 11.

## Customizing the sounds

Replace any file in `~/.config/opencode/plugins` — keeping the **exact same file
name** — with your own WAV:

| File name | Replaces |
|---|---|
| `response.wav` | assistant response sound |
| `attention.wav` | permission / question sound |
| `completion.wav` | planned-task completion sound |
| `error.wav` | session error sound |

The file must be a WAV that `System.Media.SoundPlayer` can play (uncompressed
PCM works reliably). If a file is missing or cannot be played, Sonido falls back
to a Windows system sound, played once: `Asterisk` by default, `Exclamation` for
`attention`, and `Hand` for `error`.

## Uninstall / rollback

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

Removes exactly the Sonido files (`sonido.ts`, `sonido-notify.ps1`, the four
audio assets, a legacy `quack.wav` left behind by 1.0.2, and the runtime
`sonido.log`) and leaves every other plugin untouched. Uninstalling works even
if you moved or deleted the project checkout.

Restart OpenCode afterward. To roll back to a previous version, reinstall from
the matching project checkout — the installer overwrites only the Sonido files.

## Troubleshooting

| Symptom | Check |
|---|---|
| No sound at all | An active audio device is required. Run the smoke test below. |
| No toast (sound still plays) | Focus Assist / Do Not Disturb suppresses Windows toasts. |
| Nothing happens | Confirm the plugin loaded: restart OpenCode, then look for the `SonidoPlugin initialized v1.1.0` line in the plugin log (see below). |
| Plugin not loading | Verify the files are in `~/.config/opencode/plugins` and restart OpenCode. |
| A sound is missing | Confirm all four `.wav` files are present; a missing file falls back to a system sound. |

The plugin writes a debug log next to itself (`sonido.log` in the plugins
directory when installed), one line per classified event and spawn, prefixed
with an ISO timestamp.

Safe command-line smoke test (no interaction; `-DryRun` plays nothing and shows
no toast):

```powershell
powershell.exe -NoProfile -File plugin\sonido-notify.ps1 -Kind response -DryRun
powershell.exe -NoProfile -File plugin\sonido-notify.ps1 -Kind attention -DryRun
powershell.exe -NoProfile -File plugin\sonido-notify.ps1 -Kind completion -DryRun
powershell.exe -NoProfile -File plugin\sonido-notify.ps1 -Kind error -DryRun

# Play a sound for real (no toast):
powershell.exe -NoProfile -File plugin\sonido-notify.ps1 -Kind completion
```

## Privacy & security

- **Everything stays local.** Sonido makes no network requests and sends no
  telemetry; the only artifact it writes is the local debug log.
- It never intercepts or mutates tool/permission execution and never awaits the
  notification process.
- Dynamic event text is Base64-encoded and rendered by a fixed PowerShell script
  — it is never interpolated into executable code (see Safeguards).
- All in-memory state is bounded and evicted (see Safeguards).

## Architecture

```
OpenCode hooks ──► SonidoCore ──► createNotifier ──► powershell.exe (5.1)
(event, chat.message,   classify / suppress /      ──► fixed sonido-notify.ps1
 tool.execute.after)    dedupe / rate-limit            ──► <kind>.wav
                                                       ──► system sound
                                                       ──► toast
```

- `plugin/sonido.ts` — the OpenCode plugin entry point. It must export **only**
  a default function: OpenCode's loader throws when it finds any other export,
  so the whole engine is inlined here and the file imports nothing local.
- `plugin/sonido-core.ts` — the same engine, exported for the tests. It is
  intentionally a duplicate, and it is never installed. A drift-guard test fails
  if the two copies diverge.
- `plugin/sonido-notify.ps1` — the fixed renderer: decodes the Base64 payload,
  plays `<kind>.wav` once (falling back to a system sound), and shows WinRT
  toasts. Runs under Windows PowerShell 5.1 because pwsh 7 lacks WinRT toast
  support.
- `plugin/*.wav` — one sound per notification kind.
- `install.ps1` — idempotent installer/uninstaller with byte-verification.
- `tests/sonido.test.ts` — behavior tests (Node's built-in runner, zero deps),
  including a cross-boundary test that runs the real renderer with the exact
  arguments the notifier builds.

## Development

Run the tests:

```powershell
npm test
# or, equivalently:
node --test tests/sonido.test.ts
```

The suite covers classification, subagent suppression, deduplication, rate
limiting, memory bounds, failure isolation, the spawn contract, the
notifier/renderer boundary, and drift between the two engine copies.

The plugin's `import type { Plugin } from "@opencode-ai/plugin"` is type-only and
erased at runtime, so the tests never need `npm install`. If you want editor
type hints, `npm i -D @opencode-ai/plugin typescript` enables them.

## License

The **code** in this repository is MIT — see [LICENSE](LICENSE). Use it, modify
it, redistribute it; just keep the copyright notice.

The **audio assets** in `plugin/` are **not** covered by the MIT license. They
are included only so the plugin works out of the box — do not reuse them outside
this repository. Their provenance is still being documented; if you believe you
hold rights to any of them, please open an issue.

## Limitations

- **Focus Assist / Do Not Disturb** suppresses Windows toasts; the fallback
  sound still plays. Sound requires an active audio device.
- A toast shown after a plugin restart for a session that existed before the
  restart cannot know it was a subagent (session records are learned from
  `session.created` events going forward); a completion alert may fire once for
  such sessions.
- Toasts are attributed to the custom `Sonido.OpenCode` identity, not to an
  installed app icon.
- Response and completion alerts are sound-only by design.
