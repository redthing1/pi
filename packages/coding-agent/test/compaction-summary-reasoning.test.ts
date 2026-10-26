import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Model, normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	completeSummarization,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

const COMPACTION_PROVIDER_TIMEOUT_MS = 24 * 60 * 60 * 1000;

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(
	reasoning: boolean,
	maxTokens = 8192,
	compat?: Model<"anthropic-messages">["compat"],
): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
		...(compat ? { compat } : {}),
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const mockToolCallResponse: AssistantMessage = {
	...mockSummaryResponse,
	content: [{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } }],
	stopReason: "toolUse",
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(result.text).toBe("## Goal\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
			timeoutMs: COMPACTION_PROVIDER_TIMEOUT_MS,
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(generateSummary(messages, createModel(false), "test-key")).resolves.toBe("## Goal\nTest summary");
	});

	it("uses fresh routing sessions without prompt caching", async () => {
		await generateSummary(messages, createModel(false), "test-key");
		await generateSummary(messages, createModel(false), "test-key");

		const requestOptions = completeSimpleMock.mock.calls.map((call) => call[2]);
		expect(requestOptions).toHaveLength(2);
		expect(requestOptions.every((options) => options?.cacheRetention === "none")).toBe(true);
		expect(requestOptions.every((options) => options?.toolChoice === undefined)).toBe(true);

		const sessionIds = requestOptions.map((options) => options?.sessionId);
		expect(sessionIds[0]).not.toBe(sessionIds[1]);
	});

	it("honors caller-supplied routing session and tool choice without prompt caching", async () => {
		await completeSummarization(createModel(false), normalizeContext({ systemPrompt: "Summarize", messages: [] }), {
			sessionId: "current-routing-session",
			cacheRetention: "long",
			toolChoice: "auto",
		});

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			sessionId: "current-routing-session",
			cacheRetention: "none",
			toolChoice: "auto",
		});
	});

	it("preserves the previous summary without an empty history request for a split turn", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			previousSummary: "previous checkpoint",
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		const result = await compact(preparation, createModel(false), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(result.summary).toContain("previous checkpoint");
		const requestContext = completeSimpleMock.mock.calls[0][1] as TranscriptContext;
		const prompt = JSON.stringify(requestContext.messages);
		// Regression test for #9652: clear boundaries and continuation wording avoid the reasoning-extraction false positive.
		expect(prompt).toContain("# Conversation\\n[User]: Summarize this.");
		expect(prompt).toContain("# Instructions\\nThe messages above are earlier context from an ongoing conversation.");
	});

	it("applies custom instructions to the turn prefix summary of a split turn", async () => {
		// Regression test for #11058
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			previousSummary: "previous checkpoint",
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await compact(preparation, createModel(false), "test-key", undefined, "keep migration decisions");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const requestContext = completeSimpleMock.mock.calls[0][1] as TranscriptContext;
		expect(JSON.stringify(requestContext.messages)).toContain("Additional focus: keep migration decisions");
	});

	it("rejects tool calls from conversation summaries", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockToolCallResponse);

		await expect(generateSummaryWithUsage(messages, createModel(false), "test-key")).rejects.toThrow(
			"Summarization attempted to call a tool",
		);
	});

	it("rejects tool calls from split-turn summaries", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockToolCallResponse);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), "test-key")).rejects.toThrow(
			"Turn prefix summarization attempted to call a tool",
		);
	});

	it("rejects a length-limited history summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});

		await expect(generateSummaryWithUsage(messages, createModel(false), "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
	});

	it("rejects a length-limited split-turn summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(messages, createModel(true), "test-key", undefined, undefined, undefined, undefined, "off");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
			timeoutMs: COMPACTION_PROVIDER_TIMEOUT_MS,
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
			timeoutMs: COMPACTION_PROVIDER_TIMEOUT_MS,
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("uses a long provider timeout for split-turn compaction summaries", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: messages,
			turnPrefixMessages: [{ role: "user", content: "Keep this prefix context.", timestamp: Date.now() }],
			isSplitTurn: true,
			tokensBefore: 1000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: {
				enabled: true,
				reserveTokens: 2000,
				keepRecentTokens: 100,
			},
		};

		await compact(preparation, createModel(false), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(completeSimpleMock.mock.calls.map((call) => call[2])).toEqual([
			expect.objectContaining({ timeoutMs: COMPACTION_PROVIDER_TIMEOUT_MS }),
			expect.objectContaining({ timeoutMs: COMPACTION_PROVIDER_TIMEOUT_MS }),
		]);
	});

	it("retains the previous checkpoint exactly once when split rollover has no new history", async () => {
		const previousSummary = "Prior durable checkpoint";
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [],
			turnPrefixMessages: [{ role: "user", content: "Keep this prefix context.", timestamp: Date.now() }],
			isSplitTurn: true,
			tokensBefore: 1000,
			previousSummary,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: {
				enabled: true,
				reserveTokens: 2000,
				keepRecentTokens: 100,
			},
		};

		const result = await compact(preparation, createModel(false), "test-key");

		expect(result.summary.split(previousSummary)).toHaveLength(2);
		expect(result.summary).not.toContain("No prior history.");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("limits Anthropic summary refusal fallback to the primary permitted model", async () => {
		const fallbackCost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
		await generateSummary(
			messages,
			createModel(true, 8192, {
				allowedFallbackModels: [
					{ provider: "anthropic", model: "claude-opus-4-8", cost: fallbackCost },
					{ provider: "anthropic", model: "claude-opus-5", cost: fallbackCost },
				],
			}),
			"test-key",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][0]).toMatchObject({
			compat: {
				allowedFallbackModels: [{ provider: "anthropic", model: "claude-opus-4-8", cost: fallbackCost }],
			},
		});
	});

	it("does not set Anthropic refusal fallback for models without allowed fallback targets", async () => {
		await generateSummary(messages, createModel(true), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][0]).not.toHaveProperty("compat");
	});

	it("combines usage from split-turn summaries", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false), "test-key");

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 20,
			output: 20,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
		});
		expect(completeSimpleMock.mock.calls.map((call) => call[2])).toEqual([
			expect.objectContaining({ timeoutMs: COMPACTION_PROVIDER_TIMEOUT_MS }),
			expect.objectContaining({ timeoutMs: COMPACTION_PROVIDER_TIMEOUT_MS }),
		]);
	});
});
