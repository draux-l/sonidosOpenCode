# Security

## Scope

Sonido is a local-only notification plugin for OpenCode:

- It makes **no network requests** and sends **no telemetry**.
- It never intercepts or mutates tool or permission execution.
- It never awaits notification processes; a notification failure cannot affect
  OpenCode.
- Its only persistent artifact is a local debug log (`sonido.log`) written next
  to the plugin.

Because it is passive and local, the attack surface is limited to the event
text that OpenCode feeds it. That text is never executed: it is Base64-encoded
and rendered by a fixed PowerShell script, and toast text is assigned through
the XML DOM (`InnerText`), which escapes it.

## Supported versions

Only the latest release is supported. Users should update to the newest version
from the repository.

## Reporting a vulnerability

Please report suspected vulnerabilities privately rather than in a public
issue:

- Use GitHub's private vulnerability reporting if the repository has it
  enabled (Security tab → Report a vulnerability).
- Otherwise, open an issue with a clear description of the concern without
  including secrets or sensitive data.

We aim to acknowledge reports within a few days and to provide a fix in the
next release.

## Reporting guidelines

- Include the Sonido version and OpenCode version.
- Describe the scenario and the expected vs. actual behavior.
- Do not include personal data, API keys, or credentials in the report.