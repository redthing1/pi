import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../../vitest.base.ts";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Runs in workerd: the Durable Object storage, alarms, and eviction are Cloudflare's own.
export default mergeConfig(
	baseConfig,
	defineConfig({
		root: source("."),
		plugins: [cloudflareTest({ wrangler: { configPath: source("./wrangler.jsonc") } })],
		test: { include: ["*.test.ts"] },
		resolve: {
			conditions: ["source"],
			alias: [
				{ find: /^@earendil-works\/pi-durable$/, replacement: source("../src/index.ts") },
				{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: source("../src/testing/index.ts") },
				{
					find: /^@earendil-works\/pi-durable\/storage\/sqlite\/cloudflare$/,
					replacement: source("../src/storage/sqlite/cloudflare.ts"),
				},
			],
		},
		ssr: { resolve: { conditions: ["source"] } },
	}),
);
