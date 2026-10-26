import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import type { ExtensionContext, ResourcesDiscoverEvent } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness, getAssistantTexts, getUserTexts } from "./suite/harness.ts";

it("replaces live resources without replacing the extension, conversation, or output owner", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-resource-refresh-"));
	let context: ExtensionContext | undefined;
	let revision: string | undefined = "first";
	let loads = 0;
	let shutdowns = 0;
	let discoveryGate: Promise<void> | undefined;
	const reasons: ResourcesDiscoverEvent["reason"][] = [];
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager: SettingsManager.inMemory(),
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			(pi) => {
				loads++;
				pi.on("session_start", (_event, ctx) => {
					context = ctx;
				});
				pi.on("session_shutdown", () => {
					shutdowns++;
				});
				pi.on("output_file", () => ({ path: "fixture-output:owned-by-live-extension" }));
				pi.on("resources_discover", async (event) => {
					await discoveryGate;
					reasons.push(event.reason);
					return {
						replaceSkills: revision
							? [
									{
										path: `/workspace/.pi/skills/${revision}/SKILL.md`,
										content: `---\nname: ${revision}\ndescription: Synthetic resource\n---\nSkill ${revision}`,
										scope: "project",
									},
								]
							: [],
						replacePrompts: revision
							? [
									{
										path: `/workspace/.pi/prompts/${revision}.md`,
										content: `Prompt ${revision}`,
										scope: "project",
									},
								]
							: [],
					};
				});
			},
		],
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader });
	try {
		await harness.session.bindExtensions({});
		expect(context).toBeDefined();
		harness.setResponses([fauxAssistantMessage("remembered reply"), fauxAssistantMessage("continued reply")]);
		await harness.session.prompt("synthetic conversation to preserve");
		const sessionId = harness.session.sessionId;
		const output = await context!.writeOutputFile("fixture", ".txt", "client output");
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["first"]);
		expect(harness.session.promptTemplates.map((prompt) => prompt.name)).toEqual(["first"]);
		revision = "second";
		await context!.refreshResources();
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["second"]);
		expect(harness.session.promptTemplates.map((prompt) => prompt.name)).toEqual(["second"]);
		expect(context!.getSystemPromptOptions().skills?.map((skill) => skill.name)).toEqual(["second"]);
		revision = undefined;
		await context!.refreshResources();
		expect(loader.getSkills().skills).toEqual([]);
		expect(harness.session.promptTemplates).toEqual([]);
		expect(loads).toBe(1);
		expect(shutdowns).toBe(0);
		expect(reasons).toEqual(["startup", "refresh", "refresh"]);
		expect(harness.eventsOfType("resources_changed")).toHaveLength(3);
		expect(harness.session.sessionId).toBe(sessionId);
		expect(await context!.writeOutputFile("fixture", ".txt", "still owned")).toBe(output);
		await harness.session.prompt("continue after refresh");
		expect(getUserTexts(harness)).toEqual(["synthetic conversation to preserve", "continue after refresh"]);
		expect(getAssistantTexts(harness)).toEqual(["remembered reply", "continued reply"]);
		const stale = context!;
		let finishDiscovery!: () => void;
		discoveryGate = new Promise((resolve) => {
			finishDiscovery = resolve;
		});
		revision = "retired-runtime";
		const pendingRefresh = context!.refreshResources();
		harness.session.extensionRunner.invalidate();
		finishDiscovery();
		await expect(pendingRefresh).rejects.toThrow(/stale/);
		expect(loader.getSkills().skills).toEqual([]);
		expect(harness.session.promptTemplates).toEqual([]);
		expect(() => stale.refreshResources()).toThrow(/stale/);
	} finally {
		harness.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});
