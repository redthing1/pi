import { createAssistantMessageEventStream, type Message, type Model, type UserMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent } from "../src/types.ts";

it("readmits steering queued during replacement acceptance and delivers one batch per response", async () => {
	const model: Model<"openai-responses"> = {
		id: "mock",
		name: "mock",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 8192,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const checkpoint: UserMessage = { role: "user", content: "checkpoint", timestamp: 1 };
	const steering: UserMessage[] = [1, 2].map((n) => ({ role: "user", content: `steer-${n}`, timestamp: n + 1 }));
	const queue: UserMessage[] = [];
	const requests: Message[][] = [];
	const admitted: Message[][] = [];
	const events: AgentEvent[] = [];
	let accepted = 0;
	await runAgentLoop(
		[{ role: "user", content: "original", timestamp: 0 }],
		{ messages: [], tools: [] },
		{
			model,
			convertToLlm: (messages) => messages as Message[],
			getSteeringMessages: async () => queue.splice(0, 1),
			beforeInference: async (prepared) => {
				if (prepared.replacementCount === 1) {
					accepted++;
					await Promise.resolve();
					queue.push(...steering);
					return { action: "send" };
				}
				if (!accepted) return { action: "replace", context: { messages: [checkpoint], tools: [] } };
				admitted.push([...prepared.llmContext.messages]);
				return { action: "send" };
			},
		},
		(event) => {
			events.push(event);
		},
		undefined,
		(_model, context) => {
			requests.push([...context.messages]);
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					timestamp: 4,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			});
			return stream;
		},
	);
	expect(accepted).toBe(1);
	expect(requests).toHaveLength(2);
	expect(requests[0]).toEqual([checkpoint, steering[0]]);
	expect(requests[1].filter((message) => message.role === "user")).toEqual([checkpoint, ...steering]);
	expect(admitted).toEqual(requests);
	for (const message of steering) {
		expect(events.filter((event) => event.type === "message_end" && event.message === message)).toHaveLength(1);
	}
});
