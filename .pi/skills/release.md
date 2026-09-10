---
name: release
description: Prepare, publish, verify, and recover pi releases. Use for release preparation, local release smoke tests, publishing, and failed release CI or announcements.
---

# Releasing pi

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   bun run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. Run the bare command in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

   Load and follow [interactive-testing.md](interactive-testing.md) for the tmux workflow. Start the release binary from `/tmp`, not the repo root.

3. **Run the release script**:
   ```bash
   bun run release:patch    # fixes + additions
   bun run release:minor    # breaking changes
   ```
   Review any lockfile diff and both release commits before pushing or publishing.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `bun run check` and `./test.sh`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, and commits `Add [Unreleased] section for next cycle`. It does not push or publish.

4. **Review and publish explicitly**: verify the release commits and tag, then run `bun run publish:dry`. Registry publishing is a separate, manual action via `bun run publish` and may require npm authentication. Do not publish unless the user explicitly requests it.

5. **Push explicitly**: after review and any requested publishing, push `main` and `vX.Y.Z` explicitly. Do not rerun the release script for the same version.
