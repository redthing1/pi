import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./link-local-pi.mjs", import.meta.url));

for (const configured of [false, true]) {
	test(`links a fresh checkout without global package state (custom bin: ${configured})`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-local-link-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const cli = join(root, "packages/coding-agent/dist/cli.js");
		mkdirSync(join(root, "packages/coding-agent/dist"), { recursive: true });
		writeFileSync(cli, "// fixture\n");
		writeFileSync(join(root, "package.json"), '{"private":true}');
		const installRoot = join(root, "bun");
		const bin = configured ? join(root, "custom-bin") : join(installRoot, "bin");
		if (configured) {
			writeFileSync(join(root, "bunfig.toml"), `[install]\nglobalBinDir = ${JSON.stringify(bin)}\n`);
		}
		execFileSync("bun", ["--no-install", script], {
			cwd: root,
			env: { PATH: process.env.PATH, HOME: join(root, "home"), BUN_INSTALL: installRoot },
			stdio: "pipe",
		});
		assert.equal(realpathSync(join(bin, "pi")), realpathSync(cli));
		assert.equal(existsSync(join(installRoot, "install/global")), false);
	});
}
