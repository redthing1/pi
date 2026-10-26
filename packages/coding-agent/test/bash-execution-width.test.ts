/**
 * Test that BashExecutionComponent's collapsed output respects the render-time width,
 * not a stale captured width. Regression test for #2569.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** Minimal TUI stub that only exposes terminal.columns */
function createTuiStub(columns: number): { columns: number; stub: any } {
	const state = { columns };
	const stub = {
		terminal: {
			get columns() {
				return state.columns;
			},
			get rows() {
				return 24;
			},
		},
		// Loader calls ui.addInterval / ui.removeInterval
		addInterval: (_cb: () => void, _ms: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
	return { columns: state.columns, stub };
}

describe("BashExecutionComponent width handling (#2569)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});
	it("renders streaming controls and compact shell labels as data", () => {
		const control = "\x07\x1b]52;c;fixture\x07\x85";
		for (const compact of [false, true]) {
			const { stub } = createTuiStub(120);
			const component = new BashExecutionComponent(`rg '${control}' /synthetic`, stub, false, {
				compactExploration: compact,
			});
			try {
				for (const character of `/synthetic/name${control}.txt\n`) {
					component.appendOutput(character);
					const text = component
						.render(120)
						.join("\n")
						.replace(/\x1b\[[0-9;]*m/gu, "");
					expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(text)).toBe(false);
				}
			} finally {
				component.setComplete(0, false);
			}
		}
	});

	it("collapsed preview lines respect render-time width, not construction-time width", () => {
		const wideWidth = 200;
		const narrowWidth = 80;

		const { stub } = createTuiStub(wideWidth);
		const component = new BashExecutionComponent("pwd", stub);

		// Add output with long lines that will wrap differently at different widths
		const longLine = "x".repeat(150);
		component.appendOutput(`${longLine}\n${longLine}\n`);

		// Complete the command so it enters collapsed mode
		component.setComplete(0, false);

		// Render at the narrow width (simulating a resize or split pane)
		const lines = component.render(narrowWidth);

		// Every rendered line must fit within the narrow width
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]);
			expect(w, `Line ${i} visibleWidth=${w} > ${narrowWidth}`).toBeLessThanOrEqual(narrowWidth);
		}
	});

	it("re-computes lines when width changes between renders", () => {
		const { stub } = createTuiStub(200);
		const component = new BashExecutionComponent("echo hello", stub);

		const longLine = "abcdefghij".repeat(20); // 200 chars
		component.appendOutput(`${longLine}\n`);
		component.setComplete(0, false);

		// First render at width 200
		const lines200 = component.render(200);
		for (const line of lines200) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(200);
		}

		// Second render at width 60 (split pane scenario)
		const lines60 = component.render(60);
		for (let i = 0; i < lines60.length; i++) {
			const w = visibleWidth(lines60[i]);
			expect(w, `Line ${i} visibleWidth=${w} > 60`).toBeLessThanOrEqual(60);
		}
	});

	it("compacts read-only rg exploration output when enabled", () => {
		const { stub } = createTuiStub(120);
		const component = new BashExecutionComponent(
			'cd /repo && rg -il "compaction" packages/ | head -30',
			stub,
			false,
			{ compactExploration: true },
		);
		component.appendOutput(
			"packages/coding-agent/docs/compaction.md\npackages/coding-agent/src/core/agent-session.ts\n",
		);
		component.setComplete(0, false);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Explored");
		expect(rendered).toContain("Search /compaction/ in packages");
		expect(rendered).toContain("compaction.md");
		expect(rendered).toContain("agent-session.ts");
		expect(rendered).not.toContain("$ cd /repo");
	});

	it("shows full bash exploration details when expanded", () => {
		const { stub } = createTuiStub(120);
		const component = new BashExecutionComponent('rg -il "compaction" packages/', stub, false, {
			compactExploration: true,
		});
		component.appendOutput("packages/coding-agent/docs/compaction.md\n");
		component.setComplete(0, false);
		component.setExpanded(true);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain('$ rg -il "compaction" packages/');
		expect(rendered).toContain("packages/coding-agent/docs/compaction.md");
	});

	it("wraps compact bash exploration rows without dropping tail text", () => {
		const { stub } = createTuiStub(44);
		const component = new BashExecutionComponent(
			'rg -n "alpha beta gamma delta epsilon zeta eta theta" packages/coding-agent/src',
			stub,
			false,
			{ compactExploration: true },
		);
		component.setComplete(0, false);

		const lines = component.render(44);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("alpha beta");
		expect(rendered).toContain("theta");
		expect(rendered).toContain("in src");
		expect(lines.some((line) => stripAnsi(line).startsWith("    "))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(44);
		}
	});
});
