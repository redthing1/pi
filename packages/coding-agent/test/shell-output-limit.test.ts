import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([createBashTool, createPowerShellTool])(
	"bounds saved output and cancels the native operation without treating the result as success",
	async (create) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-output-limit-"));
		directories.push(directory);
		let aborted = false;
		const shell = create(directory, {
			temporaryOutputDirectory: directory,
			operations: {
				async exec(_command, _cwd, { onData, signal }) {
					onData(Buffer.alloc(32 * 1024 * 1024 + 1, "x"));
					aborted = signal?.aborted === true;
					onData(Buffer.from("late output must not be appended"));
					// Even an operation that returns success after cancellation cannot hide the limit failure.
					return { exitCode: 0 };
				},
			},
		});
		await expect(shell.execute("capture", { command: "synthetic" })).rejects.toThrow(
			"captured output exceeded 32 MiB",
		);
		expect(aborted).toBe(true);
		const files = readdirSync(directory);
		expect(files).toHaveLength(1);
		expect(statSync(join(directory, files[0])).size).toBe(32 * 1024 * 1024);
	},
);
