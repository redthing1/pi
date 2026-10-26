import { beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import {
	formatToolCallWithArgs,
	getTextOutput,
	normalizeDisplayText,
	renderToolPath,
} from "../src/core/tools/render-utils.ts";
import { createShellRenderers } from "../src/core/tools/renderers/bash.ts";
import { findRenderers } from "../src/core/tools/renderers/find.ts";
import { grepRenderers } from "../src/core/tools/renderers/grep.ts";
import { lsRenderers } from "../src/core/tools/renderers/ls.ts";
import { DiffView, renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const payload = "\x07\x1b]52;c;dGVzdA==\x07\x9dclipboard\x9c";
const unsafe = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u;
describe("untrusted tool display text", () => {
	beforeAll(() => initTheme("dark"));
	it("escapes data before formatting arguments and paths", () => {
		const args = { path: `name${payload}`, text: `first\n${payload}` };
		const original = JSON.stringify(args);
		for (const expanded of [false, true]) {
			const formatted = formatToolCallWithArgs(`tool${payload}`, args, theme, expanded);
			expect(unsafe.test(stripAnsi(formatted))).toBe(false);
			expect(formatted.includes(payload)).toBe(false);
		}
		const path = renderToolPath(args.path, theme, "/synthetic-workspace");
		expect(stripAnsi(path)).toContain("\\x07");
		expect(path.includes(payload)).toBe(false);
		expect(JSON.stringify(args)).toBe(original);
	});
	it("keeps result and diff controls from becoming terminal commands", () => {
		const raw = `first\n${payload}\nlast`;
		const result = { content: [{ type: "text", text: raw }] };
		expect(unsafe.test(getTextOutput(result, false))).toBe(false);
		expect(unsafe.test(normalizeDisplayText(raw))).toBe(false);
		const diff = `-1 old${payload}\n+1 new${payload}`;
		expect(unsafe.test(stripAnsi(renderDiff(diff)))).toBe(false);
		expect(new DiffView(diff).render(100).some((line) => line.includes(payload))).toBe(false);
		expect(result.content[0].text).toBe(raw);
	});
	it("preserves binary-text filtering without changing the stored result", () => {
		const raw = "before\ufff9\ufffa\ufffb\x00\x85after\n雪\tα";
		const result = { content: [{ type: "text", text: raw }] };
		expect(getTextOutput(result, false)).toBe("before\\x85after\n雪\tα");
		expect(result.content[0].text).toBe(raw);
	});
	it.each([
		["bash", createShellRenderers("$")],
		["find", findRenderers],
		["grep", grepRenderers],
		["ls", lsRenderers],
	] as const)("handles unvalidated numeric arguments in the %s renderer", (_name, renderer) => {
		const args = { command: "fixture", pattern: "fixture", path: "fixture", timeout: payload, limit: payload };
		const context: ToolRenderContext = {
			args,
			toolCallId: "synthetic",
			invalidate() {},
			lastComponent: undefined,
			state: {},
			cwd: "/synthetic-workspace",
			executionStarted: false,
			argsComplete: false,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
			durationMs: undefined,
			outputPad: 0,
		};
		const lines = renderer.renderCall!(args, theme, context).render(120);
		expect(lines.some((line) => unsafe.test(stripAnsi(line)))).toBe(false);
		expect(lines.some((line) => line.includes("[invalid arg]"))).toBe(true);
	});
});
