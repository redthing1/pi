import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseContextWindow } from "../../src/core/context-window.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

describe("context window", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
	});
	async function setup(options: HarnessOptions = {}) {
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: 200_000, maxTokens: 16_000 }],
			tools: [],
			...options,
		});
		harnesses.push(harness);
		return harness;
	}

	it.each([
		["128000", 128_000],
		["128k", 128_000],
		["1.001k", 1001],
		["1.5M", 1_500_000],
		["128Ki", 131_072],
		["1.5mi", 1_572_864],
		[" 2 K ", 2000],
	] as const)("parses %s as %i tokens", (input, expected) => {
		expect(parseContextWindow(input)).toBe(expected);
	});
	it.each(["", "0", "-1", "1.2", "NaN", "Infinity", "1e6", "128kb", "1k junk", "9007199254740992"])(
		"rejects invalid count %s",
		(input) => expect(() => parseContextWindow(input)).toThrow("positive token count"),
	);

	it("caps request, compaction policy and display without mutating catalog or settings", async () => {
		const checks: number[] = [];
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", (event) => {
						checks.push(event.model.contextWindow);
						return { action: "send" };
					});
				},
			],
		});
		const requests: number[] = [];
		const stream = h.session.agent.streamFunction;
		h.session.agent.streamFunction = (model, context, options) => {
			requests.push(model.contextWindow);
			return stream(model, context, options);
		};
		const configured = h.getModel();
		h.session.setContextWindow(64_000);
		expect(h.session.getContextUsage()?.contextWindow).toBe(64_000);
		expect(h.getPendingResponseCount()).toBe(0);
		expect(h.session.messages).toEqual([]);
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await h.session.prompt("hello");
		h.session.setContextWindow(undefined);
		await h.session.prompt("again");
		expect(checks).toEqual([64_000, 200_000]);
		expect(requests).toEqual(checks);
		expect(configured.contextWindow).toBe(200_000);
		expect(h.session.model?.contextWindow).toBe(200_000);
		expect(h.session.getContextWindow().effective).toBe(200_000);
		expect(h.settingsManager.getGlobalSettings()).not.toHaveProperty("contextWindow");
	});

	it("starts at the preferred default, allows a larger session window, and resets to the default", async () => {
		const h = await setup({
			models: [{ id: "large", contextWindow: 1_048_576 }],
			modelsJson: { providers: { faux: { modelOverrides: { large: { defaultContextWindow: 491_520 } } } } },
		});
		expect(h.session.getContextWindow()).toEqual({
			capacity: 1_048_576,
			defaultWindow: 491_520,
			override: undefined,
			effective: 491_520,
		});
		expect(h.getModel().contextWindow).toBe(1_048_576);
		const windows: number[] = [];
		h.setResponses(
			Array.from({ length: 4 }, () => (_context, _options, _state, model) => {
				windows.push(model.contextWindow);
				return fauxAssistantMessage("response");
			}),
		);
		await h.session.prompt("default");
		h.session.setContextWindow(1_048_576);
		await h.session.prompt("longer");
		h.session.setContextWindow(2_000_000);
		await h.session.prompt("bounded by capacity");
		h.session.setContextWindow(undefined);
		await h.session.prompt("default again");
		expect(windows).toEqual([491_520, 1_048_576, 1_048_576, 491_520]);
		expect(h.session.getContextUsage()?.contextWindow).toBe(491_520);
		h.sessionManager.newSession();
		expect(h.session.getContextWindow().effective).toBe(491_520);
	});

	it("keeps defaults separate from catalog refresh and honors modelOverrides over model definitions", async () => {
		const h = await setup({
			modelsJson: {
				providers: {
					faux: {
						baseUrl: "http://localhost:0",
						api: "openai-completions",
						models: [{ id: "large", defaultContextWindow: 96_000 }],
						modelOverrides: { large: { defaultContextWindow: 64_000 } },
					},
				},
			},
		});
		expect(h.session.getContextWindow()).toMatchObject({ capacity: 200_000, effective: 64_000 });
		await h.session.modelRuntime.refresh();
		expect(h.session.getContextWindow()).toMatchObject({ capacity: 200_000, effective: 64_000 });
		expect(h.session.modelRuntime.getModel("faux", "large")?.contextWindow).toBe(200_000);
	});

	it("applies after virtual routing and remains a cap across model changes", async () => {
		const h = await setup({
			models: [
				{ id: "small", contextWindow: 32_000 },
				{ id: "large", contextWindow: 200_000 },
			],
			modelsJson: {
				providers: {
					faux: {
						modelOverrides: {
							small: { defaultContextWindow: 16_000 },
							large: { defaultContextWindow: 128_000 },
						},
					},
				},
			},
			extensionFactories: [
				(pi) =>
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						route: (_request, ctx) => ({ model: ctx.modelRegistry.find("faux", "large")!, thinkingLevel: "off" }),
					}),
			],
		});
		h.session.setContextWindow(64_000);
		expect(h.session.getContextWindow().effective).toBe(32_000);
		await h.session.setModel(h.session.modelRuntime.getModel("router", "auto")!);
		let sentWindow = 0;
		const stream = h.session.agent.streamFunction;
		h.session.agent.streamFunction = (model, context, options) => {
			sentWindow = model.contextWindow;
			return stream(model, context, options);
		};
		h.setResponses([fauxAssistantMessage("routed")]);
		await h.session.prompt("hello");
		expect(sentWindow).toBe(64_000);
		expect(h.session.getContextUsage()?.contextWindow).toBe(64_000);
		h.session.setContextWindow(undefined);
		h.setResponses([fauxAssistantMessage("routed default")]);
		await h.session.prompt("default after routing");
		expect(sentWindow).toBe(128_000);
		expect(h.session.getContextWindow().effective).toBe(128_000);
		h.session.setContextWindow(64_000);
		await h.session.setModel(h.getModel("small")!);
		expect(h.session.getContextWindow().effective).toBe(32_000);
		expect(h.session.getContextWindow().override).toBe(64_000);
		h.session.setContextWindow(undefined);
		expect(h.session.getContextWindow().effective).toBe(16_000);
	});

	it("keeps an in-flight request's budget and applies changes at the next boundary", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_compaction_check", async () => {
						entered.resolve();
						await release.promise;
						return { action: "send" };
					});
				},
			],
		});
		const windows: number[] = [];
		const stream = h.session.agent.streamFunction;
		h.session.agent.streamFunction = (model, context, options) => {
			windows.push(model.contextWindow);
			return stream(model, context, options);
		};
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		h.session.setContextWindow(64_000);
		const running = h.session.prompt("first");
		await entered.promise;
		h.session.setContextWindow(96_000);
		release.resolve();
		await running;
		await h.session.prompt("second");
		expect(windows).toEqual([64_000, 96_000]);
	});

	it("compacts an existing larger conversation before using the reduced budget", async () => {
		const h = await setup({ settings: { compaction: { reserveTokens: 2000, keepRecentTokens: 500 } } });
		h.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("recent answer")]);
		await h.session.prompt("synthetic history ".repeat(3000));
		await h.session.prompt("recent work ".repeat(200));
		const windows: number[] = [];
		h.setResponses([
			(_context, _options, _state, model) => {
				windows.push(model.contextWindow);
				return fauxAssistantMessage("Brief summary of synthetic history.");
			},
			(_context, _options, _state, model) => {
				windows.push(model.contextWindow);
				return fauxAssistantMessage("continued");
			},
		]);
		h.session.setContextWindow(10_000);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		await h.session.prompt("continue");
		expect(h.eventsOfType("compaction_end")).toHaveLength(1);
		expect(h.eventsOfType("compaction_end")[0]).toMatchObject({ aborted: false });
		expect(windows).toEqual([200_000, 10_000]);
		expect(h.session.getContextWindow().override).toBe(10_000);
	});

	it("restores branch-local limits and resets without persisting in-memory sessions", async () => {
		const h = await setup();
		h.session.setContextWindow(64_000);
		const cappedLeaf = h.sessionManager.getLeafId()!;
		h.session.setContextWindow(undefined);
		expect(h.session.getContextWindow().override).toBeUndefined();
		h.sessionManager.branch(cappedLeaf);
		expect(h.session.getContextWindow().override).toBe(64_000);
		h.sessionManager.createBranchedSession(cappedLeaf);
		expect(h.session.getContextWindow().override).toBe(64_000);
		expect(h.sessionManager.getSessionFile()).toBeUndefined();
		const file = join(h.tempDir, "synthetic-session.jsonl");
		writeFileSync(
			file,
			[h.sessionManager.getHeader(), ...h.sessionManager.getBranch()]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);
		const resumed = await setup({ sessionManager: SessionManager.open(file, h.tempDir) });
		expect(resumed.session.getContextWindow().override).toBe(64_000);
		expect(resumed.session.getContextWindow().effective).toBe(64_000);
		expect(resumed.session.messages).toEqual([]);
		resumed.sessionManager.newSession();
		expect(resumed.session.getContextWindow().override).toBeUndefined();
	});
});
