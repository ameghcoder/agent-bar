# Claude Code adapter

- `hooks/claude-hook.ts`: the receiver, run by Claude Code as
  `agentbar-hook --event <type>` with the hook payload on stdin. It never
  writes to stdout and exits 1, never 2, on failure, so it cannot block Claude.
- `translate.ts`: payload to normalized event; compaction carry-over; the
  project root from `CLAUDE_PROJECT_DIR`, falling back to the session's first
  `cwd`.
- `install/`: the hook config generator, the pure merge engine that recognises
  AgentBar's own handlers by their exact command shape, and the backed-up,
  atomic apply to Claude's `settings.json`.
- `settings.example.json`: a portable hooks template.

The receiver's file name is part of the ownership pattern (any path ending in
`/hooks/claude-hook.js`). Keep it, or existing installs stop being recognised.
