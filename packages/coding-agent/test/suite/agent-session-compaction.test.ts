import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	contentText,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { SessionPersistenceError } from "../../src/core/session-manager.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_recoverFromContextOverflow: (assistantMessage: AssistantMessage) => Promise<boolean>;
	_runOverflowCompaction: (assistantMessage?: AssistantMessage) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(
	harness: Harness,
	summary: string,
	onRequest?: (context: TranscriptContext, options: SimpleStreamOptions | undefined) => void,
): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model, context, options) => {
		callCount++;
		onRequest?.(context, options);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function createEchoTool(toolRuns: string[]): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			toolRuns.push(text);
			return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
		},
	};
}

async function createAbortableCompactionHarness(): Promise<{
	harness: Harness;
	compactionStarted: Promise<void>;
}> {
	let markCompactionStarted = () => {};
	const compactionStarted = new Promise<void>((resolve) => {
		markCompactionStarted = resolve;
	});
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					return await new Promise<{ cancel: true }>((resolve) => {
						event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						markCompactionStarted();
					});
				});
			},
		],
	});
	seedCompactableSession(harness);
	return { harness, compactionStarted };
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const summaryUsage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							usage: summaryUsage,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const statsBefore = harness.session.getSessionStats();

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(result.summary).toBe("summary from extension");
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
		expect(harness.session.messages[0]?.role).toBe("system");
		expect(harness.session.messages[1]?.role).toBe("compactionSummary");
	});

	it("checkpoints the replayed system state and folds summarized and retained system patches into it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("declared")]);
		await harness.session.prompt("declare the prompt");
		const declared = harness.session.messages[0];
		if (declared?.role !== "system") throw new Error("expected declared system message");

		harness.sessionManager.appendMessage({
			role: "system",
			content: "summarized instruction",
			sections: { early: "<early>1</early>" },
			toolsRemoved: [{ name: "bash" }],
			timestamp: Date.now(),
		});
		const firstKeptEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept before patch" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "system",
			content: "retained instruction",
			sections: { extra: "<extra>late</extra>" },
			toolsRemoved: [{ name: "read" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept after patch" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendCompaction("compacted", firstKeptEntryId, 100);

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual(["system", "compactionSummary", "user", "user"]);
		const checkpoint = messages[0];
		if (checkpoint?.role !== "system") throw new Error("expected checkpoint system message");
		expect(checkpoint.content).toBe("summarized instruction\n\nretained instruction");
		expect(checkpoint.sections).toEqual({
			...declared.sections,
			early: "<early>1</early>",
			extra: "<extra>late</extra>",
		});
		expect(checkpoint.toolsAdded?.map((tool) => tool.name)).toEqual(
			harness.session.getActiveToolNames().filter((name) => name !== "read" && name !== "bash"),
		);
	});

	it.each(["core", "extension"])("allows a queued prompt from %s when manual compaction ends", async (source) => {
		let queuedPrompt: Promise<void> | undefined;
		let idleAtNotification: boolean | undefined;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
					pi.on("session_compact", (_event, ctx) => {
						if (source !== "extension") return;
						idleAtNotification = ctx.isIdle();
						queuedPrompt = harness.session.prompt("queued after compaction");
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("queued response")]);

		harness.session.subscribe((event) => {
			if (source === "core" && event.type === "compaction_end" && event.reason === "manual" && event.result) {
				idleAtNotification = harness.session.isIdle;
				queuedPrompt = harness.session.prompt("queued after compaction");
			}
		});

		await harness.session.compact();
		expect(idleAtNotification).toBe(true);
		if (!queuedPrompt) throw new Error("compaction notification did not start the queued prompt");
		await queuedPrompt;

		expect(getUserTexts(harness)).toContain("queued after compaction");
		expect(harness.session.getLastAssistantText()).toBe("queued response");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		const summaryResponse = (_context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
			expect(options?.apiKey).toBeUndefined();
			expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
			return fauxAssistantMessage("summary with bearer auth");
		};
		harness.setResponses([summaryResponse]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("uses the standalone compaction request context", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);

		const transformContext = vi.fn(async (messages: AgentMessage[]) => messages);
		harness.session.agent.transformContext = transformContext;
		harness.session.agent.sessionId = "active-routing-session";
		harness.session.agent.transport = "websocket";

		let requestContext: TranscriptContext | undefined;
		let requestOptions: SimpleStreamOptions | undefined;
		useSummaryStreamFn(harness, "standalone summary", (context, options) => {
			requestContext = context;
			requestOptions = options;
		});

		await harness.session.compact();

		expect(transformContext).not.toHaveBeenCalled();
		expect(getCurrentSystemPrompt(requestContext?.messages ?? [])).not.toBe(harness.session.agent.state.systemPrompt);
		expect(getCurrentTools(requestContext?.messages ?? [])).toEqual([]);
		expect(JSON.stringify(requestContext?.messages)).toContain("<conversation>");
		expect(requestOptions).toMatchObject({ cacheRetention: "none" });
		expect(requestOptions?.sessionId).not.toBe("active-routing-session");
		expect(requestOptions?.transport).toBeUndefined();
	});

	it("persists usage from pi-generated manual compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(result.usage).toEqual(createUsage(10));
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].usage : undefined).toEqual(
			createUsage(10),
		);
	});

	it("stages and commits automatic compaction at the provider boundary", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", () => ({ action: "compact" }));
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "automatic checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("continued after checkpoint")]);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "threshold") {
				throw new Error("observer failed after commit");
			}
		});

		await harness.session.prompt("continue");

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]).toMatchObject({ summary: "automatic checkpoint", fromHook: true });
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("continued after checkpoint");
	});

	it("passes the exact threshold inference context to the summary handler", async () => {
		let triggerContext: Readonly<TranscriptContext> | undefined;
		let sourceContext: Readonly<TranscriptContext> | undefined;
		let providerSessionId: string | undefined;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", (event) => {
						triggerContext = event.context;
						return { action: "compact" };
					});
					pi.on("session_before_compact", (event) => {
						sourceContext = event.sourceContext;
						providerSessionId = event.providerSessionId;
						return {
							compaction: {
								summary: "exact source checkpoint",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.agent.sessionId = "provider-routing-session";
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("continued")]);

		await harness.session.prompt("pending request");

		expect(sourceContext).toEqual(triggerContext);
		expect(Object.isFrozen(triggerContext)).toBe(true);
		expect(Object.isFrozen(triggerContext?.messages)).toBe(true);
		expect(Object.isFrozen(sourceContext)).toBe(true);
		expect(Object.isFrozen(sourceContext?.messages)).toBe(true);
		expect(providerSessionId).toBe(harness.session.agent.sessionId);
		expect(providerSessionId).not.toBe(harness.session.sessionId);
	});

	it("does not resolve native summarization auth when Horizon supplies the checkpoint", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", () => ({ action: "compact" }));
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Horizon checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							placement: "after-retained",
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("continued")]);
		const getAuthSpy = vi.spyOn(harness.session.modelRuntime, "getAuth");

		await harness.session.prompt("continue");

		expect(getAuthSpy).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([
			expect.objectContaining({ summary: "Horizon checkpoint", placement: "after-retained" }),
		]);
	});

	it("resolves native auth only after Horizon declines and emits no failure for a successful fallback", async () => {
		const failedEvents: unknown[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", () => ({ action: "compact" }));
					pi.on("session_before_compact", () => undefined);
					pi.on("session_compact_failed", (event) => {
						failedEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "native fallback checkpoint");
		const getAuthSpy = vi.spyOn(harness.session.modelRuntime, "getAuth");

		await harness.session.prompt("continue");

		expect(getAuthSpy).toHaveBeenCalledTimes(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([
			expect.objectContaining({ summary: expect.stringContaining("native fallback checkpoint"), fromHook: false }),
		]);
		expect(failedEvents).toHaveLength(0);
	});

	it("lets an extension checkpoint a single oversized pending turn without retaining it", async () => {
		let preparedAnchor: string | null | undefined;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", () => ({ action: "compact" }));
					pi.on("session_before_compact", (event) => {
						preparedAnchor = event.preparation.firstKeptEntryId;
						return {
							compaction: {
								summary: "oversized request checkpoint",
								firstKeptEntryId: null,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("continued from checkpoint")]);

		await harness.session.prompt("x".repeat(5000));

		expect(preparedAnchor).toBeNull();
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.session.getLastAssistantText()).toBe("continued from checkpoint");
	});

	it("prepares manual source context through the normal context transform", async () => {
		let sourceContext: Readonly<TranscriptContext> | undefined;
		const marker = "manual transformed marker";
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => ({
						messages: [
							...event.messages,
							{ role: "custom", customType: "marker", content: marker, display: false, timestamp: 1 },
						],
					}));
					pi.on("session_before_compact", (event) => {
						sourceContext = event.sourceContext;
						return {
							compaction: {
								summary: "manual checkpoint",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await harness.session.compact();

		expect(
			sourceContext?.messages.some((message) => message.role === "user" && contentText(message.content) === marker),
		).toBe(true);
	});

	it("uses the last dispatched durable prefix as overflow checkpoint source", async () => {
		let sourceContext: Readonly<TranscriptContext> | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						if (event.reason === "overflow") sourceContext = event.sourceContext;
						return {
							compaction: {
								summary: "overflow checkpoint",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("completed response"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(sourceContext?.messages.some((message) => message.role === "user")).toBe(true);
		expect(
			sourceContext?.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "text" && block.text === "partial response"),
			),
		).toBe(false);
	});

	it("does not persist a candidate when replacement transformation fails", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", () => ({ action: "compact" }));
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "uncommitted checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.agent.transformContext = async (messages) => {
			if (messages.some((message) => message.role === "compactionSummary")) {
				throw new Error("replacement transform failed");
			}
			return messages;
		};

		await harness.session.prompt("continue");

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			errorMessage: "Automatic compaction did not reach provider acceptance",
		});
	});

	it("does not dispatch the original request when required automatic compaction is cancelled", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", () => ({ action: "compact" }));
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("must not be sent")]);

		await harness.session.prompt("continue");

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: true,
		});
	});

	it("compacts after tool results and continues the same logical turn", async () => {
		const toolRuns: string[] = [];
		const admissionRoles: string[][] = [];
		const harness = await createHarness({
			tools: [createEchoTool(toolRuns)],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", (event) => {
						admissionRoles.push(event.context.messages.map((message) => message.role));
						return {
							action: event.context.messages.some((message) => message.role === "toolResult")
								? "compact"
								: "send",
						};
					});
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "tool turn checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued after tool checkpoint"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(admissionRoles).toContainEqual(expect.arrayContaining(["toolResult"]));
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.session.getLastAssistantText()).toBe("continued after tool checkpoint");
	});

	it("rejects a transformed checkpoint with an orphaned tool call before commit", async () => {
		const toolRuns: string[] = [];
		const harness = await createHarness({
			tools: [createEchoTool(toolRuns)],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", (event) => ({
						action: event.context.messages.some((message) => message.role === "toolResult") ? "compact" : "send",
					}));
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "invalid tool checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("context", (event) => {
						if (!event.messages.some((message) => message.role === "compactionSummary")) return undefined;
						return { messages: event.messages.filter((message) => message.role !== "toolResult") };
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not be sent"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			"Automatic compaction replacement has incomplete tool-call protocol",
		);
	});

	it("stops queued work and future prompts after an indeterminate persistence failure", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", () => ({ action: "compact" }));
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "checkpoint that cannot persist",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		vi.spyOn(harness.sessionManager, "commitCompactionCandidate").mockImplementation(() => {
			throw new SessionPersistenceError("disk write became indeterminate");
		});
		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued follow-up" }],
			display: false,
			timestamp: Date.now(),
		});

		await harness.session.prompt("continue");

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		await expect(harness.session.prompt("must remain blocked")).rejects.toThrow(
			"Session persistence became indeterminate during automatic compaction",
		);
	});

	it("notifies extensions when auto-compaction fails", async () => {
		const failedEvents: Array<{
			reason: "manual" | "threshold" | "overflow";
			errorMessage?: string;
			aborted: boolean;
			willRetry: boolean;
			fromExtension: boolean;
		}> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", () => ({ action: "compact" }));
					pi.on("session_compact_failed", async (event) => {
						failedEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.agent.streamFunction = () => {
			throw new Error("summary generator blew up");
		};
		await expect(harness.session.prompt("continue")).resolves.toBeUndefined();

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "Automatic compaction failed: summary generator blew up",
		});
		expect(failedEvents).toEqual([
			expect.objectContaining({
				type: "session_compact_failed",
				reason: "threshold",
				aborted: false,
				willRetry: false,
				fromExtension: false,
				errorMessage: "Automatic compaction failed: summary generator blew up",
			}),
		]);
	});

	it("compacts and resumes after a length stop below the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("completed response"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		const activeAssistantTexts = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant"
					? entry.message.content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map((block) => block.text)
					: [],
			);
		expect(activeAssistantTexts).not.toContain("partial response");
		expect(activeAssistantTexts).toContain("completed response");
		expect(harness.session.getLastAssistantText()).toBe("completed response");
	});

	// Regression coverage for #8133: model overrides must also apply between assistant turns.
	// Regression coverage for #9740: an oversized trailing tool result must still produce a cut point.
	it.each([false, true])(
		"compacts after an oversized tool result in the same run (model override: %s)",
		async (modelOverride) => {
			const toolResult = `large-tool-result:${"x".repeat(8000)}`;
			const largeTool: AgentTool = {
				name: "large_result",
				label: "Large result",
				description: "Returns enough content to cross the compaction threshold",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: toolResult }], details: {} }),
			};
			const order: string[] = [];
			const observedSettings: unknown[] = [];
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 3500, maxTokens: 100 }],
				settings: {
					compaction: modelOverride
						? {
								enabled: true,
								reserveTokens: 0,
								keepRecentTokens: 20000,
								modelOverrides: { "faux/faux-1": { reserveTokens: 1300, keepRecentTokens: 1750 } },
							}
						: { enabled: true, reserveTokens: 1300, keepRecentTokens: 1750 },
				},
				tools: [largeTool],
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							order.push("compaction");
							observedSettings.push(event.preparation.settings);
							return {
								compaction: {
									summary: "compacted history",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: {},
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			let resumedRequest = "";
			harness.setResponses([
				fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
				fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
				fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				(context) => {
					order.push("provider");
					resumedRequest = JSON.stringify(context.messages);
					return fauxAssistantMessage("finished after compaction");
				},
			]);

			await harness.session.prompt("seed old history");
			await harness.session.prompt("seed recent history");
			const agentStartsBefore = harness.eventsOfType("agent_start").length;
			await harness.session.prompt("run the large tool");

			expect(order).toEqual(["compaction", "provider"]);
			expect(observedSettings).toEqual([{ enabled: true, reserveTokens: 1300, keepRecentTokens: 1750 }]);
			expect(harness.eventsOfType("agent_start")).toHaveLength(agentStartsBefore + 1);
			expect(harness.eventsOfType("compaction_start").at(-1)).toEqual({
				type: "compaction_start",
				reason: "threshold",
			});
			expect(resumedRequest).toContain("compacted history");
			expect(resumedRequest).toContain("large-tool-result");
			expect(harness.session.getLastAssistantText()).toBe("finished after compaction");
		},
	);

	it("includes steering queued during compaction in the resumed assistant request", async () => {
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
			}),
		};
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3500, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 1300, keepRecentTokens: 1750 } },
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "compacted history",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after compaction");
			},
			fauxAssistantMessage("finished after delayed steering"),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		const promptPromise = harness.session.prompt("run the large tool");
		await compactionStarted;
		await harness.session.steer("change direction");
		releaseCompaction();
		await promptPromise;

		expect(resumedRequest).toContain("change direction");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("does not compact after a terminating tool result", async () => {
		const terminatingTool: AgentTool = {
			name: "terminate_with_large_result",
			label: "Terminate with large result",
			description: "Returns enough content to cross the compaction threshold, then terminates",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
				terminate: true,
			}),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [terminatingTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "unexpected compaction",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("terminate_with_large_result", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		await harness.session.prompt("run the terminating tool");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not compact when a length stop reaches the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(400), { stopReason: "length" })]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("keeps a truncated response coherent when overflow compaction is cancelled", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => (event.reason === "overflow" ? { cancel: true } : undefined));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("partial response", { stopReason: "length" })]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("partial response");
		const branch = harness.sessionManager.getBranch();
		const lastEntry = branch[branch.length - 1];
		expect(lastEntry?.type === "message" && lastEntry.message.role === "assistant").toBe(true);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: true,
			willRetry: false,
		});
	});

	it("stops after one compact-and-retry when a second response is also truncated", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			() => fauxAssistantMessage("y".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			"Truncated response recovery failed after one compact-and-retry attempt.",
		);
	});

	it("keeps overflow wording when a repeated length stop fills the context window", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const lengthOverflowMessage = createAssistant(harness, {
			stopReason: "length",
			totalTokens: 100,
			timestamp: Date.now(),
		});
		const runOverflowCompactionSpy = vi.spyOn(sessionInternals, "_runOverflowCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._recoverFromContextOverflow(lengthOverflowMessage);
		await sessionInternals._recoverFromContextOverflow({ ...lengthOverflowMessage, timestamp: Date.now() + 1 });

		expect(runOverflowCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const { harness, compactionStarted } = await createAbortableCompactionHarness();
		harnesses.push(harness);

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).rejects.toThrow("Compaction cancelled");
		await compactionStarted;
		harness.session.abortCompaction();

		await compactExpectation;
	});

	// Regression test for #8920.
	it("aborts an in-progress manual compaction and waits until the session is idle", async () => {
		const { harness, compactionStarted } = await createAbortableCompactionHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("continued")]);

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).rejects.toThrow("Compaction cancelled");
		await compactionStarted;
		await harness.session.abort();
		await compactExpectation;

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			aborted: true,
		});
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.isIdle).toBe(true);

		await expect(harness.session.prompt("next prompt")).resolves.toBeUndefined();
		expect(harness.session.getLastAssistantText()).toBe("continued");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		let admissionCount = 0;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", () => ({
						action: ++admissionCount === 3 ? "compact" : "send",
					}));
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
			fauxAssistantMessage("queued response"),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		await harness.session.prompt("third");

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.session.getLastAssistantText()).toBe("queued response");
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runOverflowCompactionSpy = vi.spyOn(sessionInternals, "_runOverflowCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._recoverFromContextOverflow(overflowMessage);
		await sessionInternals._recoverFromContextOverflow({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runOverflowCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("does not compact a completed response until another inference is needed", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale retained usage at the next provider boundary", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("continued")]);

		await harness.session.prompt("next prompt");

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("uses the latest valid usage for the default boundary decision", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "default boundary checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "large prior context" }],
			timestamp: Date.now() - 1000,
		});
		harness.sessionManager.appendMessage(successfulAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("continued")]);

		await harness.session.prompt("continue");

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("does not compact structurally small context without prior usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("small response")]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("continued")]);

		await harness.session.prompt("new prompt");

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		belowThresholdHarness.setResponses([fauxAssistantMessage("below")]);
		disabledHarness.setResponses([fauxAssistantMessage("disabled")]);

		await belowThresholdHarness.session.prompt("small");
		await disabledHarness.session.prompt("small");

		expect(belowThresholdHarness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(disabledHarness.eventsOfType("compaction_start")).toHaveLength(0);
	});
});
