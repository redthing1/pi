import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function registerModel(
	modelRuntime: ModelRuntime,
	provider: string,
	modelId: string,
	apiKey = `${provider}-key`,
): Model<Api> {
	modelRuntime.registerProvider(provider, {
		baseUrl: `https://${provider}.test/v1`,
		apiKey,
		api: "openai-completions",
		models: [
			{
				id: modelId,
				name: modelId,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});

	const model = modelRuntime.getModel(provider, modelId);
	if (!model) {
		throw new Error(`Failed to register ${provider}/${modelId}`);
	}
	return model;
}

async function createModelRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
}

function createExistingSession(model: Model<Api>): SessionManager {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendModelChange(model.provider, model.id);
	sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	return sessionManager;
}

describe("createAgentSession provider scope", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-provider-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not restore a session model outside the provider scope", async () => {
		const modelRuntime = await createModelRuntime();
		const riskyModel = registerModel(modelRuntime, "risky-provider", "risky-model");
		const safeModel = registerModel(modelRuntime, "safe-provider", "safe-model");
		await modelRuntime.refresh({ allowNetwork: false });
		const sessionManager = createExistingSession(riskyModel);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
			providerScope: "safe-provider",
		});

		expect(session.model?.provider).toBe("safe-provider");
		expect(session.model?.id).toBe("safe-model");
		expect(modelFallbackMessage).toContain(
			'Session model risky-provider/risky-model is outside provider scope "safe-provider"',
		);
		expect(modelFallbackMessage).toContain("Using safe-provider/safe-model");
		expect(session.providerScope).toBe("safe-provider");
		await expect(session.setModel(riskyModel)).rejects.toThrow(
			'Model risky-provider/risky-model is outside provider scope "safe-provider"',
		);
		session.setScopedModels([{ model: riskyModel }, { model: safeModel }]);
		expect(session.scopedModels).toEqual([{ model: safeModel }]);

		session.dispose();
	});

	it("blocks direct provider requests outside the provider scope", async () => {
		const modelRuntime = await createModelRuntime();
		const riskyModel = registerModel(modelRuntime, "risky-provider", "risky-model");
		const safeModel = registerModel(modelRuntime, "safe-provider", "safe-model");
		await modelRuntime.refresh({ allowNetwork: false });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: safeModel,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(),
			providerScope: "safe-provider",
		});

		try {
			await expect(session.agent.streamFunction(riskyModel, normalizeContext({ messages: [] }), {})).rejects.toThrow(
				'Model risky-provider/risky-model is outside provider scope "safe-provider"',
			);
		} finally {
			session.dispose();
		}
	});

	it("rejects an unknown provider scope before creating a session", async () => {
		const modelRuntime = await createModelRuntime();
		registerModel(modelRuntime, "safe-provider", "safe-model");
		await modelRuntime.refresh({ allowNetwork: false });

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory(),
				sessionManager: SessionManager.inMemory(),
				providerScope: "missing-provider",
			}),
		).rejects.toThrow('Unknown provider "missing-provider"');
	});

	it("uses provider scope from settings when no explicit option is provided", async () => {
		const modelRuntime = await createModelRuntime();
		const riskyModel = registerModel(modelRuntime, "risky-provider", "risky-model");
		registerModel(modelRuntime, "safe-provider", "safe-model");
		await modelRuntime.refresh({ allowNetwork: false });
		const sessionManager = createExistingSession(riskyModel);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ providerScope: "safe-provider" }),
			sessionManager,
		});

		expect(session.model?.provider).toBe("safe-provider");
		expect(session.model?.id).toBe("safe-model");
		expect(session.providerScope).toBe("safe-provider");

		session.dispose();
	});

	it("does not fall back globally when no model is available inside the provider scope", async () => {
		const modelRuntime = await createModelRuntime();
		const riskyModel = registerModel(modelRuntime, "risky-provider", "risky-model");
		registerModel(modelRuntime, "safe-provider", "safe-model", "$SAFE_PROVIDER_TEST_KEY");
		await modelRuntime.refresh({ allowNetwork: false });
		const sessionManager = createExistingSession(riskyModel);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
			providerScope: "safe-provider",
		});

		expect(session.model?.provider).toBe("unknown");
		expect(modelFallbackMessage).toContain('No authenticated models available for provider "safe-provider"');
		expect(modelFallbackMessage).toContain("Provider scope prevents fallback to another provider");
		expect(modelFallbackMessage).not.toContain("using risky-provider/risky-model");

		session.dispose();
	});
});
