/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

import { Box, Spacer, safeTerminalText, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { VisualLinePreview } from "../../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolRenderers, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { BashToolDetails } from "../bash.ts";
import {
	getTextOutput,
	invalidArgText,
	renderShellCommand,
	startToolTimer,
	str,
	toolTimerText,
} from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

const BASH_PREVIEW_LINES = 5;
export const BASH_UPDATE_THROTTLE_MS = 100;
function rebuildBashResultRenderComponent(
	component: Box,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	timerText: string | undefined,
	isError: boolean,
): void {
	component.clear();

	const exitCode = result.details?.exitCode;
	const content = exitCode ? result.content.slice(0, 1) : result.content;
	let output = getTextOutput({ content }, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("text", line))
			.join("\n");
		const body = new Box(2, 0);
		component.addChild(body);

		if (options.expanded) {
			body.addChild(new Text(styledOutput, 0, 0));
		} else {
			body.addChild(
				new VisualLinePreview({
					text: styledOutput,
					maxVisualLines: BASH_PREVIEW_LINES,
					keep: "end",
					formatHint: (hidden) =>
						theme.fg("muted", `… ${hidden} earlier lines · `) + keyHint("app.tools.expand", "to expand"),
				}),
			);
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`full output: ${safeTerminalText(fullOutputPath)}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(theme.fg("muted", warnings.join(" · ")), 2, 0));
	}

	const outcome = options.isPartial ? "" : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	if (timerText || outcome) {
		const time = timerText
			? theme.fg(isError ? "error" : "muted", timerText.replace(/^Took /, "").toLowerCase())
			: "";
		const exit = exitCode ? theme.fg("muted", ` · exit ${exitCode}`) : "";
		component.addChild(new Text([outcome, time].filter(Boolean).join(" ") + exit, 2, 0));
	}
	component.addChild(new Spacer(1));
}

/** Shell renderers are shared by bash and powershell, which differ only in the prompt they display. */
export function createShellRenderers(prompt: string): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(rawArgs, theme, context) {
			const args = rawArgs as { command?: unknown; timeout?: unknown } | undefined;
			startToolTimer(context);
			const component = new Box(context.outputPad, 0, (line) => theme.bg("toolPendingBg", line));
			component.addChild(new Spacer(1));
			const command = str(args?.command);
			component.addChild(
				command === null
					? new Text(invalidArgText(theme), 0, 0)
					: renderShellCommand(command || "…", prompt, theme),
			);
			if (context.isPartial && args?.timeout)
				component.addChild(
					new Text(
						theme.fg(
							"muted",
							`timeout ${typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : "[invalid arg]"}s`,
						),
						2,
						0,
					),
				);
			return component;
		},
		renderResult(result, options, _theme, context) {
			const timerText = toolTimerText(context, options.isPartial);
			const component =
				(context.lastComponent as Box | undefined) ?? new Box(0, 0, (line) => theme.bg("toolPendingBg", line));
			component.setPaddingX(context.outputPad);
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				timerText,
				context.isError,
			);
			component.invalidate();
			return component;
		},
	};
}
