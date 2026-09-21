import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession provider privacy", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-headers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function createModel(provider: string, baseUrl: string): Model<Api> {
		return {
			id: `${provider}-test-model`,
			name: `${provider} Test Model`,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneStream(input = 0) {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureProviderOptions(
		model: Model<Api>,
		options: {
			providerHeaders?: Record<string, string>;
			requestHeaders?: Record<string, string>;
			sessionId?: string;
			remoteZdr?: boolean;
		} = {},
	): Promise<SimpleStreamOptions | undefined> {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = AuthStorage.inMemory({
			[model.provider]: { type: "api_key", key: "test-api-key" },
		});
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			headers: options.providerHeaders,
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream();
			},
		});

		const sessionManager = SessionManager.inMemory(cwd);
		if (options.sessionId) sessionManager.newSession({ id: options.sessionId });
		const modelRuntime = getModelRuntime(modelRegistry);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			privacy: { remoteZdr: options.remoteZdr },
		});

		try {
			const stream = await session.agent.streamFunction(model, normalizeContext({ messages: [] }), {
				sessionId: session.sessionId,
				...(options.requestHeaders ? { headers: options.requestHeaders } : {}),
			});
			await stream.result();
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it.each([
		["openrouter", "https://openrouter.ai/api/v1"],
		["nvidia", "https://integrate.api.nvidia.com/v1"],
		["cloudflare-ai-gateway", "https://gateway.ai.cloudflare.com/v1/example"],
	])("does not add attribution headers for %s", async (provider, baseUrl) => {
		const headers = (await captureProviderOptions(createModel(provider, baseUrl)))?.headers;

		expect(headers?.["HTTP-Referer"]).toBeUndefined();
		expect(headers?.["X-OpenRouter-Title"]).toBeUndefined();
		expect(headers?.["X-OpenRouter-Categories"]).toBeUndefined();
		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBeUndefined();
		expect(headers?.["User-Agent"]).toBeUndefined();
	});

	it("does not send the local session identifier to OpenCode", async () => {
		const headers = (
			await captureProviderOptions(createModel("opencode", "https://opencode.ai/zen/v1"), {
				sessionId: "local-session-id",
			})
		)?.headers;

		expect(headers?.["x-opencode-session"]).toBeUndefined();
		expect(headers?.["x-opencode-client"]).toBeUndefined();
	});

	it("uses an ephemeral provider routing ID instead of the durable local session ID", async () => {
		const model = createModel("capture-provider", "https://example.invalid");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = AuthStorage.inMemory({
			[model.provider]: { type: "api_key", key: "test-api-key" },
		});
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		let capturedOptions: SimpleStreamOptions | undefined;
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream();
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.newSession({ id: "durable-local-session-id" });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager,
		});

		try {
			await session.prompt("privacy test");
			expect(session.sessionId).toBe("durable-local-session-id");
			expect(session.agent.sessionId).toBeDefined();
			expect(session.agent.sessionId).not.toBe(session.sessionId);
			expect(capturedOptions?.sessionId).toBe(session.agent.sessionId);
			expect(capturedOptions?.sessionId).not.toBe(session.sessionId);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("preserves explicitly configured headers", async () => {
		const headers = (
			await captureProviderOptions(createModel("openrouter", "https://openrouter.ai/api/v1"), {
				providerHeaders: { "X-Provider": "provider", "X-Override": "provider" },
				requestHeaders: { "X-Request": "request", "X-Override": "request" },
			})
		)?.headers;

		expect(headers).toEqual({
			"X-Provider": "provider",
			"X-Request": "request",
			"X-Override": "request",
		});
	});

	it("warms approved ZDR requests with runtime identity and rechecks approval before refresh", async () => {
		const model: Model<Api> = {
			...createModel("capture-provider", "https://example.invalid"),
			zdr: true,
			promptCache: { short: 300 },
			cost: { input: 10, output: 1, cacheRead: 0.1, cacheWrite: 0 },
		};
		const modelRegistry = await createInMemoryModelRegistry(
			AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "test-api-key" } }),
		);
		const requests: Array<{ context: unknown; options: SimpleStreamOptions | undefined }> = [];
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (_model, context, options) => {
				requests.push({ context, options });
				return createDoneStream(100_000);
			},
		});
		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.newSession({ id: "durable-local-session-id" });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ cacheWarming: "idle" }),
			privacy: { clientZdr: true, remoteZdr: true },
		});
		try {
			vi.useFakeTimers();
			await session.prompt("Keep this synthetic request cached.");
			expect(requests).toHaveLength(1);
			expect(session.cacheWarmingStatus?.state).toBe("scheduled");
			await vi.advanceTimersByTimeAsync(270_000);
			expect(requests).toHaveLength(2);
			expect(requests[1].context).toEqual(requests[0].context);
			for (const request of requests) {
				expect(request.options?.sessionId).toBe(session.agent.sessionId);
				expect(request.options?.sessionId).not.toBe(session.sessionId);
				expect(request.options?.allowModelFallbacks).toBe(false);
			}
			expect(requests[1].options).toMatchObject({ maxTokens: 1, maxRetries: 0 });
			expect(sessionManager.getBranch().filter((entry) => entry.type === "usage")).toHaveLength(1);
			expect(sessionManager.isPersisted()).toBe(false);
			expect(existsSync(join(agentDir, "sessions"))).toBe(false);

			const approval = vi.spyOn(modelRuntime, "isZdrModel").mockReturnValue(false);
			await vi.advanceTimersByTimeAsync(270_000);
			expect(approval).toHaveBeenCalledWith(model);
			expect(requests).toHaveLength(2);
			expect(sessionManager.getBranch().filter((entry) => entry.type === "usage")).toHaveLength(1);
			approval.mockRestore();
			session.dispose();
			await vi.advanceTimersByTimeAsync(270_000);
			expect(requests).toHaveLength(2);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("disables provider-side model fallback routing in remote-ZDR mode", async () => {
		const model = { ...createModel("capture-provider", "https://example.invalid"), zdr: true };
		const options = await captureProviderOptions(model, { remoteZdr: true });

		expect(options?.allowModelFallbacks).toBe(false);
	});
});
