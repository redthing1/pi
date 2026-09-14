import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

const skillContent = (name: string, description: string, body: string): string => `---
name: ${name}
description: ${description}
---

${body}
`;

describe("extension skill replacement", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const directory of tempDirs.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("uses the ordered in-memory catalog and ignores additive local paths", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-skill-replacement-"));
		tempDirs.push(directory);
		const agentDir = join(directory, "agent");
		const localSkill = join(directory, "local", "SKILL.md");
		mkdirSync(join(directory, "local"), { recursive: true });
		writeFileSync(localSkill, skillContent("local", "Local skill", "LOCAL BODY"));

		const loader = new DefaultResourceLoader({ cwd: directory, agentDir });
		loader.extendResources({
			skillPaths: [
				{
					path: localSkill,
					metadata: { source: "extension", scope: "project", origin: "top-level" },
				},
			],
			skillReplacement: {
				source: "extension:/teleport/index.ts",
				documents: [
					{
						path: "/workspace/.pi/skills/shared/SKILL.md",
						content: skillContent("shared", "Project version", "PROJECT BODY"),
						scope: "project",
					},
					{
						path: "/home/remote/.pi/agent/skills/shared/SKILL.md",
						content: skillContent("shared", "User version", "USER BODY"),
						scope: "user",
					},
					{
						path: "/home/remote/.agents/skills/general/user.md",
						content: skillContent("remote-user", "Remote user skill", "REMOTE USER BODY"),
						scope: "user",
					},
				],
			},
		});

		const result = loader.getSkills();
		expect(result.skills.map((skill) => skill.name)).toEqual(["shared", "remote-user"]);
		expect(result.skills[0]).toMatchObject({
			filePath: "/workspace/.pi/skills/shared/SKILL.md",
			content: expect.stringContaining("PROJECT BODY"),
			sourceInfo: { source: "extension:/teleport/index.ts", scope: "project" },
		});
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "collision",
				collision: expect.objectContaining({
					winnerPath: "/workspace/.pi/skills/shared/SKILL.md",
					loserPath: "/home/remote/.pi/agent/skills/shared/SKILL.md",
				}),
			}),
		);
	});

	it("treats an empty replacement as authoritative", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-skill-replacement-empty-"));
		tempDirs.push(directory);
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: join(directory, "agent") });

		loader.extendResources({
			skillReplacement: { source: "extension:/teleport/index.ts", documents: [] },
		});

		expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
	});
});
