import { contentText, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

it("acknowledges each boundary contribution independently of earlier drafts", async () => {
	const accepted: string[] = [];
	const h = await createHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.on("turn_end", (event) => ({
					entries: [
						...event.entries,
						{ type: "custom_message", customType: "discard", content: "Earlier", display: true },
					],
					onCommitted: () => accepted.push("discard"),
				}));
				pi.on("turn_end", (event) => ({
					entries: [
						...event.entries,
						{ type: "custom_message", customType: "keep", content: "Retained", display: true },
					],
					onCommitted: () => accepted.push("keep"),
				}));
				pi.on("turn_end", (event) => ({
					entries: event.entries.filter((entry) => entry.type === "custom_message" && entry.customType === "keep"),
				}));
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	h.setResponses([fauxAssistantMessage("Done")]);
	await h.session.prompt("Finish");
	expect(accepted).toEqual(["keep"]);
});

it("accepted steering releases a join and is delivered before the next inference", async () => {
	let waiting = false;
	const h = await createHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.registerTool({
					name: "join",
					label: "Join",
					description: "Wait for fixture work",
					parameters: Type.Object({}),
					async execute(_id, _args, signal, _update, ctx) {
						waiting = true;
						const outcome = await ctx.foreground.wait({ ready: () => false, subscribe: () => () => {}, signal });
						return { content: [{ type: "text", text: outcome }], details: {} };
					},
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("join", {}), { stopReason: "toolUse" }),
		(context) => {
			expect(
				context.messages.some(
					(message) => message.role === "toolResult" && contentText(message.content).includes("steering"),
				),
			).toBe(true);
			expect(
				context.messages.some(
					(message) =>
						message.role === "user" && contentText(message.content).includes("Continue with this instead"),
				),
			).toBe(true);
			return fauxAssistantMessage("Received the new request.");
		},
	]);
	const run = h.session.prompt("Wait for work");
	await vi.waitFor(() => expect(waiting).toBe(true));
	await h.session.steer("Continue with this instead");
	await run;
	expect(h.getPendingResponseCount()).toBe(0);
});

it("tool and boundary receipts run after their transcript entries exist", async () => {
	const accepted: string[] = [];
	let boundary = false;
	const h = await createHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.registerTool({
					name: "fixture",
					label: "Fixture",
					description: "Return a result",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						ctx.onResultCommitted(() => {
							expect(
								ctx.sessionManager
									.getBranch()
									.some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
							).toBe(true);
							accepted.push("tool");
						});
						return { content: [{ type: "text", text: "Fixture result" }], details: {} };
					},
				});
				pi.on("turn_end", (event, ctx) => {
					if (boundary) return;
					boundary = true;
					return {
						entries: [
							...event.entries,
							{ type: "custom_message", customType: "handoff", content: "Useful finding", display: true },
						],
						onCommitted: () => {
							expect(
								ctx.sessionManager
									.getBranch()
									.some((entry) => entry.type === "custom_message" && entry.customType === "handoff"),
							).toBe(true);
							accepted.push("boundary");
						},
					};
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("fixture", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done"),
	]);
	await h.session.prompt("Exercise publication");
	expect(accepted).toEqual(["tool", "boundary"]);
	let delivered = 0;
	await h.session.sendCustomMessage(
		{ customType: "idle-handoff", content: "Idle finding", display: true },
		{ onDelivered: () => delivered++ },
	);
	expect(delivered).toBe(1);
});

it("does not acknowledge a boundary contribution removed by a later handler", async () => {
	let accepted = 0;
	const h = await createHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.on("turn_end", () => ({
					entries: [
						{ type: "custom_message", customType: "discarded", content: "Discarded finding", display: true },
					],
					onCommitted: () => accepted++,
				}));
				pi.on("turn_end", () => ({ entries: [] }));
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	h.setResponses([fauxAssistantMessage("Done")]);
	await h.session.prompt("Finish");
	expect(accepted).toBe(0);
});
