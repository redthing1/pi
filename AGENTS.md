# Working on this fork

Read [FORK.md](FORK.md) before upstream integration or changes to dependencies, builds, installation, package loading, or privacy. These instructions are fork-owned; adopt upstream instruction changes only for a concrete reason.

## Working practices

- Keep changes small and clear. Preserve intentional fork behavior, prefer upstream's architecture, and discuss substantive semantic conflicts before resolving them. Do not add compatibility layers unless requested.
- Inspect the affected code and its callers in proportion to the task; full-file reads are not mandatory. Use installed dependency types rather than guessing APIs.
- Preserve other people's work. No commits, pushes, branch changes, destructive Git operations, or broad staging without explicit authorization. Stage only reviewed, explicit paths.
- Do not inspect private session directories or broadly search personal directories. Use isolated fixtures for testing; never use private history as test data.
- Keep tracked files portable and free of personal paths, hostnames, credentials, and local test artifacts.
- Communicate concisely. Explain substantive tradeoffs and distinguish verified results from assumptions. Keep the relevant living notes current without duplicating them into code documentation.

## Code

- Prefer direct code, precise types, and existing abstractions. Avoid unnecessary helpers, options, dependencies, and documentation.
- Use erasable TypeScript syntax in root-checked code: no enums, namespaces, parameter properties, or other constructs requiring emission. Prefer top-level imports; retain local lazy imports where they serve a clear purpose.
- Keep keybindings configurable through the existing defaults, not hardcoded key checks.
- Update model catalogs through `packages/ai/scripts/generate-models.ts`, never by editing `models.generated.ts` directly.
- Put changelog additions under the affected package's existing `[Unreleased]` subsections; preserve released history.

## Verification and dependencies

- After code changes, run `bun run check`, inspect the full output, and address failures. This does not run tests.
- Run focused tests from the package root: `bun ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts`. Always run tests you change. Prefer useful behavior contracts over issue-specific test scaffolding.
- Coding-agent suite tests use `test/suite/harness.ts` and the faux provider, never real credentials or paid calls.
- For interactive checks, follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md), use isolated state and tmux, and clean up task-owned processes and artifacts.
- Do not run `bun run dev`, `bun run build`, or `bun test` without explicit approval. The supported installation path is `bun run install:local-pi`; do not replace the user's installed CLI without permission.
- Hydrate dependencies with `bun install --frozen-lockfile --ignore-scripts`. After intentional manifest changes, use `bun install --lockfile-only --ignore-scripts` and review the complete lock diff. Follow `FORK.md`; never use ad hoc package runners or lifecycle scripts.
- For release work, follow [.pi/skills/release.md](.pi/skills/release.md).
