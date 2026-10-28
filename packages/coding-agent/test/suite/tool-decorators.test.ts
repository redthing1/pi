import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { defineTool, type ExtensionAPI, type ToolDecorator } from "../../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});
const answer = () => fauxAssistantMessage("Done.");

it.each([false, true])(
	"decorates the selected definition once across replacement and refresh (reversed=%s)",
	async (reversed) => {
		let api!: ExtensionAPI;
		const calls: string[] = [];
		const decorate: ToolDecorator = (definition) => {
			const native = definition as ReturnType<typeof createBashToolDefinition>;
			return defineTool({
				...native,
				description: `${native.description} Decorated.`,
				parameters: Type.Object({ command: Type.String(), background: Type.Optional(Type.Boolean()) }),
				async execute(id, args, signal, update, ctx) {
					calls.push(`decorated:${args.background}`);
					return native.execute(id, args, signal, update, ctx);
				},
			});
		};
		const extensions = [
			(pi: ExtensionAPI) => pi.registerToolDecorator("bash", decorate),
			(pi: ExtensionAPI) => {
				api = pi;
				pi.on("bash_launch", (event) => {
					calls.push(event.command);
					return {
						operations: {
							async exec(_command, _cwd, { onData }) {
								onData(Buffer.from("native result"));
								return { exitCode: 0 };
							},
						},
					};
				});
			},
		];
		const h = await createHarness({
			settings: { shellCommandPrefix: "configured-prefix" },
			extensionFactories: reversed ? extensions.reverse() : extensions,
		});
		harnesses.push(h);
		const run = async (command: string) => {
			h.setResponses([
				(context) => {
					expect(getCurrentTools(context.messages).find((t) => t.name === "bash")?.parameters).toMatchObject({
						properties: { background: { type: "boolean" } },
					});
					return fauxAssistantMessage(fauxToolCall("bash", { command, background: true }), {
						stopReason: "toolUse",
					});
				},
				answer(),
			]);
			await h.session.prompt("Run synthetic command.");
		};
		await run("first");
		expect(calls).toEqual(["decorated:true", "configured-prefix\nfirst"]);
		const replacement = createBashToolDefinition("/", { commandPrefix: "replacement-prefix" });
		api.registerTool(replacement);
		api.registerTool({
			name: "unrelated",
			label: "Unrelated",
			description: "Force a registry refresh",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		});
		await run("second");
		expect(calls.slice(2)).toEqual(["decorated:true", "replacement-prefix\nsecond"]);
		expect(getMessageText(getToolResult(h, "bash"))).toBe("native result");
		expect(h.session.getToolDefinition("bash")?.description).toBe(`${replacement.description} Decorated.`);
		expect(h.session.getToolDefinition("bash")?.renderCall).toBe(replacement.renderCall);
		expect(replacement.description.endsWith("Decorated.")).toBe(false);
	},
);

it("preserves call and launch vetoes around the decorated implementation", async () => {
	let executions = 0;
	let launches = 0;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerToolDecorator("bash", (native) => ({
					...native,
					async execute(...args) {
						executions++;
						return native.execute(...args);
					},
				}));
				pi.on("tool_call", (event) =>
					event.toolName === "bash" && event.input.command === "call veto"
						? { block: true, reason: "call denied" }
						: undefined,
				);
				pi.on("bash_launch", () => {
					launches++;
					return { block: true, reason: "launch denied" };
				});
			},
		],
	});
	harnesses.push(h);
	for (const command of ["call veto", "launch veto"]) {
		h.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }), answer()]);
		await h.session.prompt("Test veto.");
		expect(getToolResult(h, "bash").isError).toBe(true);
	}
	expect(executions).toBe(1);
	expect(launches).toBe(1);
});

it("does not restore excluded tools", async () => {
	let decorated = false;
	const h = await createHarness({
		excludedToolNames: ["bash"],
		extensionFactories: [
			(pi) =>
				pi.registerToolDecorator("bash", (native) => {
					decorated = true;
					return native;
				}),
		],
	});
	harnesses.push(h);
	expect(decorated).toBe(false);
	expect(h.session.getToolDefinition("bash")).toBeUndefined();
});

it("rejects competing decorators and changed tool identity", async () => {
	let first!: ExtensionAPI;
	let second!: ExtensionAPI;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				first = pi;
			},
			(pi) => {
				second = pi;
			},
		],
	});
	harnesses.push(h);
	first.registerToolDecorator("bash", (native) => native);
	expect(() => second.registerToolDecorator("bash", (native) => native)).toThrow(
		'Multiple extensions decorate tool "bash"',
	);
	const other = await createHarness({
		extensionFactories: [
			(pi) => {
				first = pi;
			},
		],
	});
	harnesses.push(other);
	expect(() => first.registerToolDecorator("bash", (native) => ({ ...native, name: "other" }))).toThrow(
		"must preserve its name",
	);
});
