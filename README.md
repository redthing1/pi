# Pi Agent Harness

This is a private fork of [Pi](https://github.com/badlogic/pi-mono), a minimal, extensible coding-agent harness. The fork stays close to upstream while maintaining stricter dependency, installation, package-loading, and zero-data-retention guarantees.

## Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
bun run install:local-pi  # Hydrate, build, and link Pi from a fresh clone
bun run check             # Lint, format, and type check
./test.sh                 # Run the test suite
./pi-test.sh              # Run Pi from source
```

`bun run check` requires the packages to be built first.

## Policy and documentation

- [FORK.md](FORK.md): authoritative fork, upstream-integration, supply-chain, and ZDR policy
- [SECURITY.md](SECURITY.md): security boundary and vulnerability reporting
- [AGENTS.md](AGENTS.md): operational rules for development agents
- [CONTRIBUTING.md](CONTRIBUTING.md): contribution requirements
- [packages/coding-agent/docs](packages/coding-agent/docs/index.md): user documentation

Pi runs with the permissions of its process and has no built-in sandbox. See [containerization](packages/coding-agent/docs/containerization.md) when stronger isolation is required.

## License

MIT
