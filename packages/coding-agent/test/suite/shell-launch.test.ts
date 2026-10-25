import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashLaunchEvent } from "../../src/core/extensions/types.ts";
import { type BashOperations, createBashTool, createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createPowerShellToolDefinition } from "../../src/core/tools/powershell.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const destination = { cwd: "/remote/project", home: "/home/remote", pathStyle: "posix" } satisfies NonNullable<
	BashOperations["context"]
>;

describe("session shell launch boundary", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each(["bash", "powershell", "sdk"] as const)(
		"guards %s tools before dispatch with destination identity",
		async (kind) => {
			const shell = kind === "powershell" ? "powershell" : "bash";
			const exec = vi.fn(async () => ({ exitCode: 0 }));
			const backendContext = { ...destination };
			const operations: BashOperations = { context: backendContext, exec };
			const launches: BashLaunchEvent[] = [];
			const harness = await createHarness({
				tools:
					kind === "sdk"
						? [createBashTool("/host/project", { operations, exposeSessionEnvironment: false })]
						: undefined,
				extensionFactories: [
					(pi) => {
						if (kind !== "sdk") {
							const create = shell === "bash" ? createBashToolDefinition : createPowerShellToolDefinition;
							pi.registerTool(create("/host/project", { operations, exposeSessionEnvironment: false }));
						}
						pi.on("session_start", () => pi.setActiveTools([shell]));
						pi.on("bash_launch", (event) => {
							launches.push(event);
							if (event.command === "blocked") return { block: true, reason: "synthetic guard" };
							backendContext.cwd = "/changed-after-inspection";
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall(shell, { command: "blocked" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run shell");
			expect(exec).not.toHaveBeenCalled();
			expect(getToolResult(harness, shell).isError).toBe(true);
			expect(launches[0]).toMatchObject({ ...destination, shell, source: "tool", command: "blocked" });
			expect(Object.isFrozen(launches[0])).toBe(true);

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall(shell, { command: "allowed" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run allowed shell");
			expect(exec).toHaveBeenCalledExactlyOnceWith("allowed", destination.cwd, expect.any(Object));
		},
	);

	it("guards direct remote execution using destination context and the configured prefix", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		let launch: BashLaunchEvent | undefined;
		const harness = await createHarness({
			settings: { shellCommandPrefix: "prefix" },
			extensionFactories: [
				(pi) => {
					pi.on("bash_launch", (event) => {
						launch = event;
						return { block: true, reason: "synthetic guard" };
					});
				},
			],
		});
		harnesses.push(harness);
		await expect(
			harness.session.executeBash("blocked", undefined, { operations: { context: destination, exec } }),
		).rejects.toThrow("synthetic guard");
		expect(launch).toMatchObject({ ...destination, source: "direct", shell: "bash", command: "prefix\nblocked" });
		expect(exec).not.toHaveBeenCalled();
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("rejects a launch handler that changes the destination identity", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_launch", () => ({ operations: { context: destination, exec } }));
				},
			],
		});
		harnesses.push(harness);
		await expect(harness.session.executeBash("allowed")).rejects.toThrow("cannot change the execution context");
		expect(exec).not.toHaveBeenCalled();
	});
});
