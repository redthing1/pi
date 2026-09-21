FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS bun
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS builder
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /work
# Build against an ephemeral repository mount. Only outputs staged under
# /opt/evaluator persist; node_modules and dist created in /repo are discarded.
RUN --mount=type=bind,source=.,target=/repo,rw \
    --mount=type=cache,target=/root/.bun/install/cache \
    cd /repo \
    && bun run install:local-pi \
    && node packages/evals/docker/install-runtime.mjs /opt/evaluator

# Both variants use the same installed runtime. The control removes only the
# coding-agent documentation whose effect the experiment measures.
FROM builder AS without-docs-install
RUN rm -rf \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/README.md \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/docs \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/examples

FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS evaluator
COPY --from=builder /opt/evaluator/root /repo
WORKDIR /repo/packages/evals
# Vitest starts as root so it can load evaluator code. Before prompting the
# model, the harness permanently drops to UID 65532. Keep evaluator sources
# root-only so model tools and generated code cannot inspect judges or fixtures.
RUN chmod -R go-rwx \
      /repo/packages/evals/src \
      /repo/packages/evals/evals \
      /repo/packages/evals/docker \
    && chmod go-rwx \
      /repo/vitest.base.ts \
      /repo/packages/evals/vitest.evals.config.ts \
    && mkdir -p /run/pi-eval-secrets \
    && chmod 0700 /run/pi-eval-secrets
ENTRYPOINT ["node", "--experimental-strip-types", "docker/entrypoint.ts"]

FROM evaluator AS without_docs
COPY --from=without-docs-install /opt/evaluator/install/node_modules /repo/node_modules
ENV PI_EVAL_VARIANT=without_docs

FROM evaluator AS with_docs
COPY --from=builder /opt/evaluator/install/node_modules /repo/node_modules
ENV PI_EVAL_VARIANT=with_docs
