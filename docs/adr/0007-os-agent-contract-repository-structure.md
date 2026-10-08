---
status: accepted
---

# Organise the repository by contract, agent, and OS

AgentBar has three independent axes of change: which **agent** is observed
(today only Claude Code), which **operating system and desktop** renders the
result (today only GNOME Shell on Ubuntu), and the **contract** between them
(`state.json` and the normalized event). We lay the repository out along those
axes from day one, so a second agent or OS is a new folder that depends on the
contract, not an edit to code that assumed there was only one.

```
contract/            language-neutral source of truth (JSON)
  state.schema.json  snapshot, schemaVersion 1
  event.schema.json  normalized event
  presentation.json  labels, intents, priority, urgency, stale threshold
  fixtures/          agent-neutral cases: snapshot -> view
src/core/            agent- and OS-neutral: state, snapshot, presentation, paths
src/doctor/          shared doctor runner and AgentBar's own checks
src/cli/             agentbar commands; the one place that composes agents and OS
agents/
  claude-code/       receiver, payload translation, hook install, doctor checks,
                     native-payload fixtures
os/
  linux/
    gnome-shell/     the extension (was extension/)
    scripts/         extension build and development helpers
    doctor.ts        GNOME Shell and display-session checks
    packaging/deb/   added by the .deb milestone
    SUPPORT.md       distro + version + GNOME version + tested status
```

Only what exists is created. `os/macos`, `os/windows`, and further `agents/*`
folders appear when someone builds and tests them; an empty folder would
advertise support we cannot claim (CONTEXT.md: only tested environments).

## Decisions

- **Linux is split by desktop, then packaging, never by distro.** The extension
  is GNOME-specific, not Ubuntu-specific; Fedora GNOME runs the same code. The
  distro appears in `SUPPORT.md` and in packaging metadata. A distro folder is
  added only if code genuinely diverges per distro.
- **The contract is data, not TypeScript types.** JSON Schema and
  `presentation.json` are what other-language ports read. Ordering, staleness,
  and notification dedupe are logic and cannot live in JSON, so each port
  reimplements them and must pass the shared `fixtures/` conformance cases.
- **Dependency direction is enforced by a test.** `agents/*` and `os/*` may
  depend on `contract/` and `src/core`; `src/core` depends on neither;
  `agents/*` never import each other or `os/*`; `os/*` never import `agents/*`.
- **An adapter's job is translate, register, diagnose.** Translate a native
  payload into a normalized event, register with the agent (today's
  `install-hooks`), and contribute its own doctor checks. Everything past the
  normalized event is agent-neutral.
- **No new dependency.** The checked-in schemas are verified by a parity test
  against `vocabulary.ts` and the fixtures, not by adding a schema validator.

- **Core receives an adapter, it never imports one.** Capture in `src/core`
  takes the adapter's normalize and reconcile functions as arguments, so the
  lock, timestamping, retention, and atomic write stay agent-neutral while the
  Claude-specific rules (payload mapping, compaction carry-over, project root)
  live in `agents/claude-code`.

## Explicitly not decided here

- **Multi-agent contract changes.** `source` is still the literal
  `'claude-code'`, session IDs are not namespaced, and the status/event
  vocabulary is still Claude-shaped. Supporting a second agent requires an
  incompatible change (a `schemaVersion` bump and a v1 migration) and gets its
  own ADR when that agent is real. The schema written for this ADR describes
  version 1 exactly as it is today.
- **A language-neutral ingress** (`agentbar ingest --agent <id>`, so adapters
  in other languages never write `state.json` themselves). Deferred until a
  non-TypeScript adapter exists, so the interface is shaped by two examples.
- **Agents with no hook mechanism** (for example a bare model server). They
  need a different adapter kind and are out of scope until investigated.

## Consequences

- The move is mechanical but wide: build scripts, `copy-extension-lib`,
  packaging tests, `.gitignore`, README, and architecture docs all change path.
- Installed hook commands embed the receiver path and are recognised by an
  exact-ownership pattern ending in `/hooks/claude-hook.js` (ADR 0005). Moving
  the receiver must keep **existing installs removable and refreshable**: the
  ownership pattern accepts both the legacy and the new path, with a test, so
  `uninstall-hooks` never leaves a dead AgentBar hook behind and never matches
  a user's own hook.
- The receiver keeps its file name, so it moves to
  `dist/agents/claude-code/hooks/claude-hook.js` and the existing ownership
  pattern (any path ending in `/hooks/claude-hook.js`) already matches both the
  legacy and the new location. A test pins both.
- `tsc` compiles from the repository root, so `dist/` mirrors the source tree
  (`dist/src/core`, `dist/agents/claude-code`, `dist/os/linux`).
- The public command names (`agentbar`, `agentbar-hook`) do not change.
- The `.deb` milestone builds against the final paths instead of moving them
  later.
- CONTEXT.md and `docs/architecture.md` gain the new module boundaries; the
  extension's Shell-only role is unchanged.
- This ADR does not widen the supported environment: Ubuntu 26.04, GNOME
  Shell 50, Wayland, Claude Code only.

## Acceptance (2026-10-08)

Accepted by the project owner. The layout above includes four clarifications
found while planning the move: `src/doctor` and `os/linux/scripts` are named,
native-payload fixtures belong to the agent adapter rather than `contract/`,
core receives the adapter as arguments, and the receiver keeps its file name.
