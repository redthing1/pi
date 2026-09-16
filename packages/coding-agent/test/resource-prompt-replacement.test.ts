import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

describe("extension prompt replacement", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const directory of tempDirs.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("uses the ordered in-memory catalog and ignores additive local paths", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-prompt-replacement-"));
		tempDirs.push(directory);
		const localPrompt = join(directory, "local.md");
		mkdirSync(directory, { recursive: true });
		writeFileSync(localPrompt, "LOCAL PROMPT");

		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: join(directory, "agent") });
		loader.extendResources({
			promptPaths: [
				{
					path: localPrompt,
					metadata: { source: "extension", scope: "project", origin: "top-level" },
				},
			],
			promptReplacement: {
				source: "extension:/teleport/index.ts",
				documents: [
					{
						path: "/workspace/.pi/prompts/review.md",
						content: "---\ndescription: Project review\n---\nPROJECT PROMPT\n",
						scope: "project",
					},
					{
						path: "/home/remote/.pi/agent/prompts/review.md",
						content: "---\ndescription: User review\n---\nUSER PROMPT\n",
						scope: "user",
					},
				],
			},
		});

		const result = loader.getPrompts();
		expect(result.prompts).toHaveLength(1);
		expect(result.prompts[0]).toMatchObject({
			name: "review",
			description: "Project review",
			content: "PROJECT PROMPT",
			filePath: "/workspace/.pi/prompts/review.md",
			sourceInfo: { source: "extension:/teleport/index.ts", scope: "project" },
		});
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "collision",
				collision: expect.objectContaining({
					winnerPath: "/workspace/.pi/prompts/review.md",
					loserPath: "/home/remote/.pi/agent/prompts/review.md",
				}),
			}),
		);
	});

	it("treats an empty replacement as authoritative", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-prompt-replacement-empty-"));
		tempDirs.push(directory);
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: join(directory, "agent") });

		loader.extendResources({
			promptReplacement: { source: "extension:/teleport/index.ts", documents: [] },
		});

		expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
	});
});
