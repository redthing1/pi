import { Container, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { ExplorationGroupComponent } from "../src/modes/interactive/components/exploration-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { ToolExecutionPresenter } from "../src/modes/interactive/tool-execution-presenter.ts";

function createHarness(compactExploration = true) {
	const container = new Container();
	const ui = { requestRender() {} } as unknown as TUI;
	const read = createReadToolDefinition("/synthetic-workspace");
	let expanded = false;
	const presenter = new ToolExecutionPresenter(container, {
		compactExploration,
		toolsExpanded: () => expanded,
		createComponent(name, id, args, argsComplete) {
			const component = new ToolExecutionComponent(
				name,
				id,
				args,
				{ argsComplete },
				name === "read" ? read : undefined,
				ui,
				"/synthetic-workspace",
			);
			component.setExpanded(expanded);
			return component;
		},
	});
	return {
		container,
		presenter,
		render: () => stripAnsi(container.render(120).join("\n")),
		expand() {
			expanded = true;
			for (const child of container.children)
				if (child instanceof ExplorationGroupComponent || child instanceof ToolExecutionComponent)
					child.setExpanded(true);
		},
	};
}
const result = (text: string) => ({ content: [{ type: "text" as const, text }], isError: false });

describe("interactive tool presentation", () => {
	beforeAll(() => initTheme("dark"));
	test.each([true, false])("replays completed tools and preserves detailed output (compact=%s)", (compact) => {
		const harness = createHarness(compact);
		harness.presenter.track("read", "r1", { path: "src/read.ts" }, true);
		harness.presenter.finish("r1", result("line one\nline two"));
		const collapsed = harness.render();
		if (compact) {
			expect(collapsed).toContain("Explored");
			expect(collapsed).toContain("Read read.ts");
			expect(collapsed).not.toContain("line one");
			expect(collapsed).not.toContain("line two");
		} else expect(collapsed).not.toContain("Explored");
		harness.expand();
		const expanded = harness.render();
		expect(expanded).toContain("read src/read.ts");
		expect(expanded).toContain("line one");
		expect(expanded).toContain("line two");
	});
	test("groups a live shell exploration only after streamed arguments complete", () => {
		const harness = createHarness();
		harness.presenter.track("read", "r1", { path: "src/read.ts" }, true);
		harness.presenter.finish("r1", result("line one"));
		harness.presenter.track("bash", "b1", {});
		const args = { command: 'rg -n "skill" /synthetic/src | head -30' };
		harness.presenter.track("bash", "b1", args);
		expect(harness.container.children).toHaveLength(2);
		expect(harness.container.children[1]).toBeInstanceOf(ToolExecutionComponent);
		harness.presenter.track("bash", "b1", args, true);
		harness.presenter.finish("b1", result("/synthetic/src/skills.ts:1:skill"));
		expect(harness.container.children).toHaveLength(1);
		const group = harness.container.children[0];
		expect(group).toBeInstanceOf(ExplorationGroupComponent);
		expect((group as ExplorationGroupComponent).hasTool("r1")).toBe(true);
		expect((group as ExplorationGroupComponent).hasTool("b1")).toBe(true);
		const rendered = harness.render();
		expect(rendered.match(/Explored/g)).toHaveLength(1);
		expect(rendered).toContain("Search /skill/ in src");
		expect(rendered).not.toContain("$ rg");
	});
	test("inserts a completed shell placeholder before the following exploration", () => {
		const harness = createHarness();
		harness.presenter.track("bash", "b1", {});
		harness.presenter.track("read", "r1", { path: "src/read.ts" }, true);
		harness.presenter.finish("r1", result("line one"));
		harness.presenter.track("bash", "b1", { command: 'rg -n "skill" /synthetic/src' }, true);
		harness.presenter.finish("b1", result("/synthetic/src/skills.ts:1:skill"));
		expect(harness.container.children).toHaveLength(1);
		const rendered = harness.render();
		expect(rendered.match(/Explored/g)).toHaveLength(1);
		expect(rendered.indexOf("Search /skill/ in src")).toBeGreaterThanOrEqual(0);
		expect(rendered.indexOf("Read read.ts")).toBeGreaterThanOrEqual(0);
		expect(rendered.indexOf("Search /skill/ in src")).toBeLessThan(rendered.indexOf("Read read.ts"));
		expect(rendered).not.toContain("$ rg");
	});
});
