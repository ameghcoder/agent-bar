# Contributing to AgentBar

Thanks for helping. AgentBar is small on purpose. This page says what a change
needs before it can be merged.

## Before you start

- Read [docs/how-it-works.md](docs/how-it-works.md) for the flow, and
  [docs/development.md](docs/development.md) to build and run a checkout.
- For anything beyond a small fix, open an issue first. Changes to the state
  format, the event mapping, or what the top bar says are product decisions,
  recorded in [docs/adr/](docs/adr/).
- To support another coding agent, start with
  [agents/README.md](agents/README.md).

## Rules every change keeps

These come from [CONTEXT.md](CONTEXT.md) and the ADRs. A change that breaks one
will not be merged, however useful it is otherwise.

- Show only what Claude Code actually reported. No progress percentages, no
  guessing from message text. A missing event is never shown as success.
- Nothing from a hook's raw payload (prompts, commands, file contents, paths)
  reaches the top bar or a notification.
- All data stays on the machine. No network calls, no telemetry.
- Never read Claude transcripts.
- A hook must stay fast, print nothing, and never decide whether Claude may
  proceed.
- The user's Claude settings belong to them: preview first, back up, change
  only AgentBar's own entries.
- The extension must never crash or slow GNOME Shell.
- No new runtime dependency without discussing it in an issue first.

## Making the change

1. Write the failing test first, then the code. Tests use Node's built-in
   runner (`node --test`); extension logic runs under the real `gjs`.
2. Keep module boundaries: `src/core` imports nothing outside itself, agents
   and OS folders only import `src/core`. `test/layout.test.mjs` enforces it.
3. If a rule in `src/core/presentation.ts` or the state format changes, update
   `contract/` in the same change. `test/contract.test.mjs` fails otherwise.
4. Run everything:

   ```sh
   pnpm typecheck
   pnpm test
   ```

5. For extension changes, also check a nested GNOME Shell or a real session
   after a logout and login, and include a screenshot in the pull request.
6. Do not weaken or delete an existing test to make a change pass. If a test
   is wrong, say why in the pull request.

## Pull requests

- One topic per pull request, with a description of what changed and why.
- Commit messages say what the change does, in plain words.
- Update the README or docs in the same pull request when behaviour changes.

## License

AgentBar is MIT licensed. By contributing you agree that your contribution is
released under the same license.
