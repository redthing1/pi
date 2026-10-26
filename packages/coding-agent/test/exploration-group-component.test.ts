import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import {
	ExplorationGroupComponent,
	isExplorationToolSnapshot,
} from "../src/modes/interactive/components/exploration-group.ts";
import { formatExplorationRows } from "../src/modes/interactive/components/exploration-summary.ts";
import { formatBashExplorationSummary } from "../src/modes/interactive/components/shell-exploration-summary.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

test("compact exploration labels escape controls before styling", () => {
	initTheme("dark");
	const control = "\x07\x1b]52;c;fixture\x07\x85";
	const tools = ["grep", "find", "read", "ls"].map((name) =>
		createTool(name, "synthetic", { pattern: control, glob: control, path: `/synthetic/${control}` }),
	);
	const text = formatExplorationRows(tools.map((tool) => tool.getPresentationSnapshot()))
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/gu, "");
	expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(text)).toBe(false);
});

function createTool(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
	return new ToolExecutionComponent(toolName, toolCallId, args, {}, undefined, createFakeTui(), process.cwd());
}

function completeTool(component: ToolExecutionComponent, text: string, details?: unknown): void {
	component.updateResult({ content: [{ type: "text", text }], details, isError: false });
}

function failTool(component: ToolExecutionComponent, text: string): void {
	component.updateResult({ content: [{ type: "text", text }], isError: true });
}

function renderGroup(group: ExplorationGroupComponent, width = 120): string {
	return stripAnsi(group.render(width).join("\n"));
}

describe("ExplorationGroupComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders a compact read summary without the file body when collapsed", () => {
		const group = new ExplorationGroupComponent();
		const read = createTool("read", "read-1", { path: "src/read.ts" });
		completeTool(read, "line one\nline two");

		group.addTool(read);

		const rendered = renderGroup(group);
		expect(rendered).toContain("Explored");
		expect(rendered).toContain("Read read.ts");
		expect(rendered).not.toContain("line one");
		expect(rendered).not.toContain("line two");
	});

	test("reveals the existing detailed tool output when expanded", () => {
		const group = new ExplorationGroupComponent();
		const read = createTool("read", "read-2", { path: "src/read.ts" });
		completeTool(read, "line one\nline two");
		group.addTool(read);

		group.setExpanded(true);

		const rendered = renderGroup(group);
		expect(rendered).toContain("Explored");
		expect(rendered).toContain("src/read.ts");
		expect(rendered).toContain("line one");
		expect(rendered).toContain("line two");
	});

	test("coalesces adjacent reads into one compact row while preserving line ranges", () => {
		const group = new ExplorationGroupComponent();
		const first = createTool("read", "read-3", { path: "src/a.ts", offset: 10, limit: 3 });
		const second = createTool("read", "read-4", { path: "src/b.ts" });
		const duplicate = createTool("read", "read-5", { path: "src/b.ts" });
		completeTool(first, "a");
		completeTool(second, "b");
		completeTool(duplicate, "b again");

		group.addTool(first);
		group.addTool(second);
		group.addTool(duplicate);

		const rendered = renderGroup(group);
		const readRows = rendered.split("\n").filter((line) => line.includes("Read "));
		expect(readRows).toHaveLength(1);
		expect(readRows[0]).toContain("a.ts:10-12");
		expect(readRows[0]).toContain("b.ts");
		expect(readRows[0].match(/\bb\.ts/g)).toHaveLength(1);
	});

	test("preserves mixed exploration order while coalescing only adjacent reads", () => {
		const group = new ExplorationGroupComponent();
		const grep = createTool("grep", "grep-1", { pattern: "ToolExecutionComponent", path: "packages/coding-agent" });
		const firstRead = createTool("read", "read-6", { path: "packages/coding-agent/src/a.ts" });
		const secondRead = createTool("read", "read-7", { path: "packages/coding-agent/src/b.ts" });
		const find = createTool("find", "find-1", { pattern: "**/*.test.ts", path: "packages/coding-agent/test" });
		const ls = createTool("ls", "ls-1", { path: "packages/coding-agent/src/core/tools" });
		completeTool(grep, "src/a.ts:1:ToolExecutionComponent");
		completeTool(firstRead, "a");
		completeTool(secondRead, "b");
		completeTool(find, "exploration-group-component.test.ts");
		completeTool(ls, "read.ts\ngrep.ts");

		group.addTool(grep);
		group.addTool(firstRead);
		group.addTool(secondRead);
		group.addTool(find);
		group.addTool(ls);

		const rendered = renderGroup(group);
		const searchIndex = rendered.indexOf("Search /ToolExecutionComponent/");
		const readIndex = rendered.indexOf("Read a.ts");
		const findIndex = rendered.indexOf("Find **/*.test.ts");
		const listIndex = rendered.indexOf("List tools");
		expect(searchIndex).toBeGreaterThanOrEqual(0);
		expect(readIndex).toBeGreaterThan(searchIndex);
		expect(findIndex).toBeGreaterThan(readIndex);
		expect(listIndex).toBeGreaterThan(findIndex);
		expect(rendered).not.toContain("src/a.ts:1:ToolExecutionComponent");
		expect(rendered).not.toContain("read.ts\ngrep.ts");

		group.setExpanded(true);
		const expanded = renderGroup(group);
		expect(expanded).toContain("packages/coding-agent");
		expect(expanded).toContain("packages/coding-agent/src/a.ts");
		expect(expanded).toContain("packages/coding-agent/test");
		expect(expanded).toContain("packages/coding-agent/src/core/tools");
	});

	test("wraps long compact search rows without dropping tail text", () => {
		const group = new ExplorationGroupComponent();
		const grep = createTool("grep", "grep-long", {
			pattern: "alpha beta gamma delta epsilon zeta eta theta",
			path: "packages/coding-agent/src",
		});
		completeTool(grep, "packages/coding-agent/src/example.ts:1:theta");
		group.addTool(grep);

		const lines = group.render(44);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("alpha beta");
		expect(rendered).toContain("theta");
		expect(rendered).toContain("in src");
		expect(lines.some((line) => stripAnsi(line).startsWith("    "))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(44);
		}
	});

	test("summarizes read-only bash exploration commands", () => {
		const group = new ExplorationGroupComponent();
		const bash = createTool("bash", "bash-1", {
			command: 'cd /repo && rg -il "compaction" packages/ | head -30',
		});
		completeTool(bash, "packages/coding-agent/docs/compaction.md\npackages/coding-agent/src/core/agent-session.ts\n");

		group.addTool(bash);

		const rendered = renderGroup(group);
		expect(rendered).toContain("Explored");
		expect(rendered).toContain("Search /compaction/ in packages");
		expect(rendered).toContain("compaction.md");
		expect(rendered).toContain("agent-session.ts");
		expect(rendered).not.toContain("$ cd /repo");
	});

	test("does not classify mutating bash commands as exploration", () => {
		const bash = createTool("bash", "bash-2", { command: "rm -rf tmp" });
		bash.setArgsComplete();

		expect(isExplorationToolSnapshot(bash.getPresentationSnapshot())).toBe(false);
	});

	test("classifies bash exploration only after arguments are complete", () => {
		const bash = createTool("bash", "bash-incomplete", { command: "rg needle packages/coding-agent/src" });

		expect(isExplorationToolSnapshot(bash.getPresentationSnapshot())).toBe(false);

		bash.setArgsComplete();

		expect(isExplorationToolSnapshot(bash.getPresentationSnapshot())).toBe(true);
	});

	test("formats common shell exploration tools learned from Codex", () => {
		const cases = [
			{ command: "rg --files packages/coding-agent/src | head -n 5", expected: "List src" },
			{ command: 'fdfind "*.ts" packages/coding-agent/src', expected: "Find *.ts in src" },
			{ command: "git grep TODO packages/coding-agent", expected: "Search /TODO/ in coding-agent" },
			{ command: "git ls-files packages/coding-agent/src", expected: "List src" },
			{ command: "egrep -R TODO packages/coding-agent", expected: "Search /TODO/ in coding-agent" },
			{ command: "ag TODO packages/coding-agent", expected: "Search /TODO/ in coding-agent" },
			{ command: "eza --color=always packages/coding-agent/src", expected: "List src" },
			{ command: "tree -L 2 packages/coding-agent/src", expected: "List src" },
			{ command: "cat packages/coding-agent/docs/settings.md", expected: "Read settings.md" },
			{ command: "sed -n '1,20p' packages/coding-agent/docs/settings.md", expected: "Read settings.md" },
			{
				command: 'rg -n "ExplorationGroup\\|explorationGroup" packages/coding-agent/src/ --no-heading',
				expected: "Search /ExplorationGroup|explorationGroup/ in src",
			},
			{
				command: 'cd /repo && rg -rn "exploration" packages/coding-agent/src/ --no-heading 2>/dev/null | head -30',
				expected: "Search /exploration/ in src",
			},
			{
				command:
					'cd /repo && rg -n "exploration" packages/coding-agent/src/core/compaction/branch-summarization.ts',
				expected: "Search /exploration/ in branch-summarization.ts",
			},
			{
				command: 'cd /repo && cat core/src/sandboxing/mod.rs 2>/dev/null || echo "no mod.rs"',
				expected: "Read mod.rs",
			},
			{
				command: 'find /repo/pi-subagents -type f -name "*.md" | grep -v SKILL.md',
				expected: "Find *.md in pi-subagents",
			},
			{
				command:
					'find /repo/pi-mono -name "*.ts" -newer /repo/pi-mono/packages/coding-agent/examples/extensions/README.md 2>/dev/null | grep -i "extensions\\|delegate\\|delegat" | head -20',
				expected: "Find *.ts in pi-mono",
			},
		];

		for (const { command, expected } of cases) {
			const summary = formatBashExplorationSummary({ command, output: "", status: "complete" });
			expect(stripAnsi(summary?.row ?? ""), command).toContain(expected);
		}
	});

	test("keeps ambiguous or mutating shell pipelines detailed", () => {
		const mutating = formatBashExplorationSummary({
			command: "rg TODO packages/coding-agent | xargs perl -pi -e s/TODO/DONE/g",
			output: "",
			status: "complete",
		});
		const unknown = formatBashExplorationSummary({
			command: "node scripts/list-files.js",
			output: "",
			status: "complete",
		});
		const sedWithoutFile = formatBashExplorationSummary({
			command: "sed -n '1,20p'",
			output: "",
			status: "complete",
		});
		const stdoutRedirect = formatBashExplorationSummary({
			command: "rg TODO packages/coding-agent > matches.txt",
			output: "",
			status: "complete",
		});
		const unknownPipeline = formatBashExplorationSummary({
			command: "rg TODO packages/coding-agent | jq .",
			output: "",
			status: "complete",
		});
		const multipleSearchPipeline = formatBashExplorationSummary({
			command: "rg compact packages/coding-agent | rg settings",
			output: "",
			status: "complete",
		});
		const echoBeforeExploration = formatBashExplorationSummary({
			command: 'echo "checking" || cat packages/coding-agent/docs/settings.md',
			output: "",
			status: "complete",
		});
		const contentSearchWithGrepFilter = formatBashExplorationSummary({
			command: "rg TODO packages/coding-agent | grep settings",
			output: "",
			status: "complete",
		});
		const findWithRecursiveGrep = formatBashExplorationSummary({
			command: 'find /repo -name "*.ts" | grep -R settings',
			output: "",
			status: "complete",
		});

		expect(mutating).toBeUndefined();
		expect(unknown).toBeUndefined();
		expect(sedWithoutFile).toBeUndefined();
		expect(stdoutRedirect).toBeUndefined();
		expect(unknownPipeline).toBeUndefined();
		expect(multipleSearchPipeline).toBeUndefined();
		expect(echoBeforeExploration).toBeUndefined();
		expect(contentSearchWithGrepFilter).toBeUndefined();
		expect(findWithRecursiveGrep).toBeUndefined();
	});

	test("summarizes read-to-search shell pipelines", () => {
		const summary = formatBashExplorationSummary({
			command: "cat packages/coding-agent/docs/settings.md | rg compact",
			output: "",
			status: "complete",
		});

		expect(stripAnsi(summary?.row ?? "")).toContain("Search /compact/ in settings.md");
	});

	test("shows exploring while any nested tool is still pending", () => {
		const group = new ExplorationGroupComponent();
		const pending = createTool("grep", "grep-2", { pattern: "needle", path: "." });

		group.addTool(pending);

		const rendered = renderGroup(group);
		expect(rendered).toContain("Exploring");
		expect(rendered).toContain("Search /needle/");
	});

	test("shows compact empty results consistently", () => {
		const group = new ExplorationGroupComponent();
		const grep = createTool("grep", "grep-empty", { pattern: "needle", path: "." });
		const find = createTool("find", "find-empty", { pattern: "*.missing", path: "." });
		const ls = createTool("ls", "ls-empty", { path: "empty" });
		completeTool(grep, "No matches found");
		completeTool(find, "No files found matching pattern");
		completeTool(ls, "(empty directory)");
		group.addTool(grep);
		group.addTool(find);
		group.addTool(ls);

		const rendered = renderGroup(group);
		expect(rendered).toContain("Search /needle/ in . no matches");
		expect(rendered).toContain("Find *.missing in . no files");
		expect(rendered).toContain("List empty empty");
	});

	test("shows compact failure state and reveals error details when expanded", () => {
		const group = new ExplorationGroupComponent();
		const read = createTool("read", "read-8", { path: "missing.ts" });
		failTool(read, "ENOENT: missing.ts");
		group.addTool(read);

		const collapsed = renderGroup(group);
		expect(collapsed).toContain("Explored");
		expect(collapsed).toContain("Read missing.ts failed");
		expect(collapsed).not.toContain("ENOENT");

		group.setExpanded(true);

		const expanded = renderGroup(group);
		expect(expanded).toContain("Read missing.ts failed");
		expect(expanded).toContain("ENOENT: missing.ts");
	});

	test("propagates image settings to nested tool components", () => {
		const group = new ExplorationGroupComponent();
		const read = createTool("read", "read-9", { path: "image.png" });
		let showImages: boolean | undefined;
		let imageWidthCells: number | undefined;
		const originalSetShowImages = read.setShowImages.bind(read);
		const originalSetImageWidthCells = read.setImageWidthCells.bind(read);
		read.setShowImages = (show) => {
			showImages = show;
			originalSetShowImages(show);
		};
		read.setImageWidthCells = (width) => {
			imageWidthCells = width;
			originalSetImageWidthCells(width);
		};
		group.addTool(read);

		group.setShowImages(false);
		group.setImageWidthCells(24);

		expect(showImages).toBe(false);
		expect(imageWidthCells).toBe(24);
	});
});
