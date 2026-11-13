import { describe, expect, it, vi } from "vitest";
import { resolveShellTimeout } from "../src/core/shell-timeout.ts";
import { createBashTool, ShellExecutionError } from "../src/core/tools/bash.ts";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";

describe("shell execution budgets", () => {
	it.each([createBashTool, createPowerShellTool])(
		"supplies a finite default and honors explicit budgets",
		async (create) => {
			const exec = vi.fn(async () => ({ exitCode: 0 }));
			const tool = create(process.cwd(), { operations: { exec } });
			await tool.execute("default", { command: "synthetic" });
			expect(exec.mock.calls[0]).toEqual(["synthetic", process.cwd(), expect.objectContaining({ timeout: 120 })]);
			await tool.execute("longer", { command: "synthetic", timeout: 900 });
			expect(exec.mock.calls[1]).toEqual(["synthetic", process.cwd(), expect.objectContaining({ timeout: 900 })]);
			await expect(tool.execute("excess", { command: "synthetic", timeout: 1801 })).rejects.toThrow(
				"maximum is 1800",
			);
			expect(exec).toHaveBeenCalledTimes(2);
		},
	);

	it("uses an explicit standalone host policy", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const tool = createBashTool(process.cwd(), {
			operations: { exec },
			timeoutPolicy: { timeoutSeconds: 10, maxTimeoutSeconds: 20 },
		});
		await tool.execute("default", { command: "synthetic" });
		expect(exec.mock.calls[0]).toEqual(["synthetic", process.cwd(), expect.objectContaining({ timeout: 10 })]);
		await expect(tool.execute("excess", { command: "synthetic", timeout: 21 })).rejects.toThrow("maximum is 20");
	});

	it("retains backend-owned full output on timeout", async () => {
		const tool = createBashTool(process.cwd(), {
			operations: {
				managesFullOutput: true,
				async exec(_command, _cwd, { onData }) {
					onData(Buffer.from("partial output\n".repeat(3000)));
					throw new ShellExecutionError("timeout:1", "", "timeout:1", "output:fixture");
				},
			},
		});
		const error = await tool.execute("deadline", { command: "controlled" }).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(ShellExecutionError);
		expect(error).toMatchObject({
			fullOutputPath: "output:fixture",
			diagnostic: "Command timed out after 1 second",
		});
		expect((error as Error).message).toContain("Full output: output:fixture");
	});

	it.each([0, -1, NaN, Infinity, null, "120"])("rejects invalid requested duration %s", (timeout) => {
		expect(() => resolveShellTimeout(timeout as number)).toThrow("Invalid timeout");
	});

	it.each([
		{ timeoutSeconds: 0 },
		{ maxTimeoutSeconds: Infinity },
		{ timeoutSeconds: 2000 },
		{ maxTimeoutSeconds: 2_147_484 },
		{ timeoutSeconds: null },
	])("rejects invalid operator policy %j", (policy) => {
		expect(() => resolveShellTimeout(undefined, policy as { timeoutSeconds?: number })).toThrow();
	});

	it.skipIf(process.platform === "win32")(
		"stops a silent process group at its default deadline and preserves output",
		async () => {
			const tool = createBashTool(process.cwd(), {
				timeoutPolicy: { timeoutSeconds: 0.1, maxTimeoutSeconds: 1 },
			});
			const result = tool.execute("deadline", { command: "printf ready; trap '' TERM; sleep 30 & wait" });
			await expect(result).rejects.toThrow("Command timed out after 0.1 seconds");
			const error = await result.catch((error: unknown) => error);
			expect(error).toBeInstanceOf(ShellExecutionError);
			expect((error as ShellExecutionError).output).toBe("ready");
		},
	);
});
