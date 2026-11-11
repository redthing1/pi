import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { ZDR_SESSION_ACCESS_DISABLED_MESSAGE } from "../src/core/privacy.ts";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory, clientZdr = false) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
					privacy: { clientZdr, remoteZdr: false },
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: clientZdr
				? SessionManager.inMemory(tempDir)
				: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux, tempDir };
	}

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("rejects persisted session switching before inspecting paths in client ZDR", async () => {
		const { runtimeHost, tempDir } = await createRuntimeHost(() => {}, true);
		const missingPath = join(tempDir, "does-not-exist.jsonl");

		await expect(runtimeHost.switchSession(missingPath)).rejects.toThrow(ZDR_SESSION_ACCESS_DISABLED_MESSAGE);
		await expect(runtimeHost.fork("missing-entry")).rejects.toThrow(ZDR_SESSION_ACCESS_DISABLED_MESSAGE);
	});

	it("resumes an exported ZDR session either detached or with normal persistence", async () => {
		const { runtimeHost: zdrRuntime, tempDir } = await createRuntimeHost(() => {}, true);
		zdrRuntime.session.sessionManager.appendMessage({ role: "user", content: "exported from ZDR", timestamp: 1 });
		zdrRuntime.session.sessionManager.appendMessage(fauxAssistantMessage("reply"));
		const sourcePath = join(tempDir, "zdr-session.jsonl");
		expect(zdrRuntime.session.exportToJsonl(sourcePath)).toBe(sourcePath);
		const sourceContent = readFileSync(sourcePath, "utf-8");

		const result = await zdrRuntime.importFromJsonl(sourcePath);
		expect(result).toEqual({ cancelled: false });
		expect(zdrRuntime.session.sessionManager.isPersisted()).toBe(false);
		expect(zdrRuntime.session.sessionFile).toBeUndefined();
		expect(zdrRuntime.session.messages[0]).toEqual({ role: "user", content: "exported from ZDR", timestamp: 1 });

		zdrRuntime.session.sessionManager.appendMessage({ role: "user", content: "continued in ZDR", timestamp: 2 });
		expect(readFileSync(sourcePath, "utf-8")).toBe(sourceContent);

		const { runtimeHost: normalRuntime } = await createRuntimeHost(() => {});
		await expect(normalRuntime.importFromJsonl(sourcePath)).resolves.toEqual({ cancelled: false });
		expect(normalRuntime.session.sessionManager.isPersisted()).toBe(true);
		expect(normalRuntime.session.messages[0]).toEqual({ role: "user", content: "exported from ZDR", timestamp: 1 });
		const persistedPath = normalRuntime.session.sessionFile;
		expect(persistedPath).toBeTruthy();
		expect(persistedPath).not.toBe(sourcePath);

		normalRuntime.session.sessionManager.appendMessage({ role: "user", content: "continued normally", timestamp: 3 });
		expect(readFileSync(sourcePath, "utf-8")).toBe(sourceContent);
		expect(readFileSync(persistedPath!, "utf-8")).toContain("continued normally");
	});

	it.each([false, true])(
		"validates the readable import source before replacement (client ZDR: %s)",
		async (clientZdr) => {
			const inspected: string[] = [];
			const { runtimeHost, tempDir } = await createRuntimeHost((pi) => {
				pi.on("session_before_switch", (event) => {
					if (event.reason !== "resume") return;
					if (!event.targetSessionFile || !existsSync(event.targetSessionFile)) return { cancel: true };
					inspected.push(event.targetSessionFile);
				});
			}, clientZdr);
			runtimeHost.session.sessionManager.appendMessage({ role: "user", content: "transfer me", timestamp: 1 });
			const source = join(tempDir, "export.jsonl");
			runtimeHost.session.exportToJsonl(source);
			const original = readFileSync(source, "utf8");
			await expect(runtimeHost.importFromJsonl(source)).resolves.toEqual({ cancelled: false });
			expect(inspected).toEqual([source]);
			expect(readFileSync(source, "utf8")).toBe(original);
			expect(runtimeHost.session.sessionManager.isPersisted()).toBe(!clientZdr);
		},
	);

	it.each([false, true])(
		"leaves the runtime and managed storage intact after an invalid import (client ZDR: %s)",
		async (clientZdr) => {
			const { runtimeHost, tempDir } = await createRuntimeHost(() => {}, clientZdr);
			const current = runtimeHost.session;
			const source = join(tempDir, "invalid.jsonl");
			writeFileSync(source, "<!doctype html><html>HTML is not a session JSONL file</html>");
			const sessionDir = current.sessionManager.getSessionDir();
			const stored = sessionDir && existsSync(sessionDir) ? readdirSync(sessionDir) : [];
			await expect(runtimeHost.importFromJsonl(source)).rejects.toThrow("not a valid");
			expect(runtimeHost.session).toBe(current);
			expect(sessionDir && existsSync(sessionDir) ? readdirSync(sessionDir) : []).toEqual(stored);
			await current.prompt("continue the original conversation");
			expect(current.messages.some((message) => message.role === "assistant")).toBe(true);
		},
	);

	it.each([false, true].flatMap((clientZdr) => [false, true].map((fileCwd) => [clientZdr, fileCwd] as const)))(
		"allows choosing a local cwd for an imported session (client ZDR: %s, cwd is a file: %s)",
		async (clientZdr, fileCwd) => {
			const { runtimeHost, tempDir } = await createRuntimeHost(() => {}, clientZdr);
			const current = runtimeHost.session;
			const source = join(tempDir, "moved.jsonl");
			const sessionCwd = join(tempDir, "stored-cwd");
			if (fileCwd) writeFileSync(sessionCwd, "not a directory");
			writeFileSync(
				source,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "moved",
					timestamp: new Date().toISOString(),
					cwd: sessionCwd,
				})}\n`,
			);
			const original = readFileSync(source, "utf8");
			await expect(runtimeHost.importFromJsonl(source)).rejects.toBeInstanceOf(MissingSessionCwdError);
			expect(runtimeHost.session).toBe(current);
			await expect(runtimeHost.importFromJsonl(source, tempDir)).resolves.toEqual({ cancelled: false });
			expect(runtimeHost.cwd).toBe(tempDir);
			expect(readFileSync(source, "utf8")).toBe(original);
		},
	);

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
