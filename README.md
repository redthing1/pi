# Pi fork

This fork tracks upstream Pi while preserving local-only package loading, reproducible Bun installation, and explicit privacy controls. Read [FORK.md](FORK.md) before integration or supply-chain changes.

## Getting started

From a reviewed checkout with Bun installed:

```bash
bun run install:local-pi
pi
```

Installation hydrates the committed frozen lockfile with lifecycle scripts disabled, builds locally, and links the CLI. Runtime package acquisition, self-update, vendor telemetry, automatic remote catalogs, and session uploads are unavailable.

Use `--zdr-client` for local ephemeral sessions, or `--zdr` for fail-closed model approval as well. See the [documentation](packages/coding-agent/docs/index.md).

## Packages

This monorepo contains the Pi CLI and its supporting libraries.

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Typed host runtime for hot-reloadable plugins, contracts, replicated state, and RPC over JSON links |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |


## Development

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
./pi-test.sh
```

Run focused tests as described in [AGENTS.md](AGENTS.md). Build and interactive verification procedures are documented in the repository skills. Local release consumers use reviewed installed dependencies and coherent package artifacts.

## License

MIT
