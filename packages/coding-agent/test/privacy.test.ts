import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { ZDR_EXPORT_PATH_REQUIRED_MESSAGE, ZDR_MODEL_REQUIRED_MESSAGE } from "../src/core/privacy.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";

describe("zero-data-retention mode", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let modelsPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-privacy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		modelsPath = join(agentDir, "models.json");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"zdr-provider": {
						baseUrl: "https://example.test/v1",
						apiKey: "test-key",
						api: "openai-completions",
						zdr: true,
						models: [
							{
								id: "approved",
								name: "Approved",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1000,
								maxTokens: 100,
							},
							{
								id: "not-approved",
								name: "Not approved",
								zdr: false,
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1000,
								maxTokens: 100,
							},
						],
					},
				},
			}),
		);
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("propagates explicit provider and model ZDR approvals", async () => {
		const runtime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });
		const approved = runtime.getModel("zdr-provider", "approved");
		const notApproved = runtime.getModel("zdr-provider", "not-approved");

		expect(approved?.zdr).toBe(true);
		expect(notApproved?.zdr).toBe(false);
		expect(approved && runtime.isZdrModel(approved)).toBe(true);
		expect(notApproved && runtime.isZdrModel(notApproved)).toBe(false);

		runtime.registerProvider("extension-zdr-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "test-key",
			api: "openai-completions",
			zdr: true,
			models: [
				{
					id: "extension-model",
					name: "Extension model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
			],
		});
		const extensionModel = runtime.getModel("extension-zdr-provider", "extension-model");
		expect(extensionModel && runtime.isZdrModel(extensionModel)).toBe(true);
	});

	it("keeps client ZDR sessions in memory while allowing explicit exports", async () => {
		const modelRuntime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });
		const approved = modelRuntime.getModel("zdr-provider", "approved");
		const notApproved = modelRuntime.getModel("zdr-provider", "not-approved");
		expect(approved).toBeDefined();
		expect(notApproved).toBeDefined();
		await expect(
			createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				model: notApproved,
				privacy: { clientZdr: true, remoteZdr: true },
			}),
		).rejects.toThrow(ZDR_MODEL_REQUIRED_MESSAGE);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: approved,
			privacy: { clientZdr: true, remoteZdr: true },
		});

		try {
			expect(session.sessionManager.isPersisted()).toBe(false);
			expect(session.extensionRunner.createContext().privacy).toEqual({ clientZdr: true, remoteZdr: true });
			await expect(session.setModel(notApproved!)).rejects.toThrow(ZDR_MODEL_REQUIRED_MESSAGE);

			const jsonlPath = join(tempDir, "session.jsonl");
			const htmlPath = join(tempDir, "session.html");
			expect(session.exportToJsonl(jsonlPath)).toBe(jsonlPath);
			await expect(session.exportToHtml(htmlPath)).resolves.toBe(htmlPath);
			expect(existsSync(jsonlPath)).toBe(true);
			expect(existsSync(htmlPath)).toBe(true);
			expect(() => session.exportToJsonl()).toThrow(ZDR_EXPORT_PATH_REQUIRED_MESSAGE);
			await expect(session.exportToHtml()).rejects.toThrow(ZDR_EXPORT_PATH_REQUIRED_MESSAGE);
		} finally {
			session.dispose();
		}
	});

	it("keeps truncated shell output in private session storage until disposal", async () => {
		const modelRuntime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });
		const approved = modelRuntime.getModel("zdr-provider", "approved");
		expect(approved).toBeDefined();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: approved,
			privacy: { clientZdr: true, remoteZdr: true },
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.alloc(60 * 1024, "x"));
				return { exitCode: 0 };
			},
		};
		let outputDirectory: string | undefined;

		try {
			const directResult = await session.executeBash("large-output", undefined, { operations });
			expect(directResult.truncated).toBe(true);
			expect(directResult.fullOutputPath).toBeDefined();
			outputDirectory = dirname(directResult.fullOutputPath!);
			expect(outputDirectory).not.toBe(tmpdir());
			expect(readFileSync(directResult.fullOutputPath!)).toEqual(Buffer.alloc(60 * 1024, "x"));
			if (process.platform !== "win32") {
				expect(statSync(outputDirectory).mode & 0o777).toBe(0o700);
				expect(statSync(directResult.fullOutputPath!).mode & 0o777).toBe(0o600);
			}

			const bash = session.getToolDefinition("bash");
			expect(bash).toBeDefined();
			expect(bash!.description).toContain("full output is saved to a temp file");
		} finally {
			session.dispose();
		}
		expect(outputDirectory).toBeDefined();
		expect(existsSync(outputDirectory!)).toBe(false);
	});

	it("enforces server ZDR while preserving the persistent session", async () => {
		const modelRuntime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });
		const approved = modelRuntime.getModel("zdr-provider", "approved");
		const notApproved = modelRuntime.getModel("zdr-provider", "not-approved");
		expect(approved).toBeDefined();
		expect(notApproved).toBeDefined();

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				model: notApproved,
				privacy: { clientZdr: false, remoteZdr: true },
			}),
		).rejects.toThrow(ZDR_MODEL_REQUIRED_MESSAGE);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: approved,
			privacy: { clientZdr: false, remoteZdr: true },
		});

		try {
			expect(session.sessionManager.isPersisted()).toBe(true);
			expect(session.extensionRunner.createContext().privacy).toEqual({ clientZdr: false, remoteZdr: true });
			await expect(session.setModel(notApproved!)).rejects.toThrow(ZDR_MODEL_REQUIRED_MESSAGE);
		} finally {
			session.dispose();
		}
	});
});
