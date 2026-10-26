import { type Component, safeTerminalText, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.ts";

type DiffRowKind = "added" | "removed" | "context" | "ellipsis" | "raw";

type DiffRow = {
	kind: DiffRowKind;
	lineNum: string;
	content: string;
	intraLine?: {
		oldContent: string;
		newContent: string;
	};
};

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path used by width-aware diff views for syntax highlighting. */
	filePath?: string;
}

type DiffLineCounts = {
	added: number;
	removed: number;
};

export function countDiffLines(diffText: string): DiffLineCounts {
	let added = 0;
	let removed = 0;
	for (const line of diffText.split("\n")) {
		const parsed = parseDiffLine(line);
		if (parsed?.prefix === "+") added++;
		if (parsed?.prefix === "-") removed++;
	}
	return { added, removed };
}

function parseDiffRows(diffText: string): DiffRow[] {
	diffText = safeTerminalText(diffText);
	if (!diffText) return [];
	const rows = diffText.split("\n").map((line): DiffRow => {
		const parsed = parseDiffLine(line);
		if (!parsed) return { kind: "raw", lineNum: "", content: line };
		if (parsed.prefix === "+" || parsed.prefix === "-") {
			return {
				kind: parsed.prefix === "+" ? "added" : "removed",
				lineNum: parsed.lineNum.trim(),
				content: replaceTabs(parsed.content),
			};
		}
		if (!parsed.lineNum.trim() && parsed.content === "...") {
			return { kind: "ellipsis", lineNum: "", content: "⋮" };
		}
		return { kind: "context", lineNum: parsed.lineNum.trim(), content: replaceTabs(parsed.content) };
	});

	for (let i = 0; i < rows.length - 1; i++) {
		if (
			rows[i].kind === "removed" &&
			rows[i - 1]?.kind !== "removed" &&
			rows[i + 1].kind === "added" &&
			rows[i + 2]?.kind !== "added"
		) {
			const intraLine = { oldContent: rows[i].content, newContent: rows[i + 1].content };
			rows[i].intraLine = intraLine;
			rows[i + 1].intraLine = intraLine;
		}
	}

	return rows;
}

function renderRowContent(row: DiffRow, language: string | undefined): string {
	if (row.intraLine && (row.kind === "removed" || row.kind === "added")) {
		const rendered = renderIntraLineDiff(row.intraLine.oldContent, row.intraLine.newContent);
		const content = row.kind === "removed" ? rendered.removedLine : rendered.addedLine;
		return theme.fg(row.kind === "removed" ? "toolDiffRemoved" : "toolDiffAdded", content);
	}

	if (language) {
		return highlightCode(row.content, language)[0] ?? "";
	}

	if (row.kind === "added") return theme.fg("toolDiffAdded", row.content);
	if (row.kind === "removed") return theme.fg("toolDiffRemoved", row.content);
	return theme.fg("toolDiffContext", row.content);
}

function padLine(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

/**
 * Width-aware diff component used by tool call renderers.
 *
 * It owns wrapping and gutters so continuation rows remain aligned, while
 * additions and removals receive only a subtle row background from the active
 * theme. The diff text itself remains display-only input.
 */
export class DiffView implements Component {
	private diffText: string;
	private options: RenderDiffOptions;
	private rows: DiffRow[];
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(diffText: string, options: RenderDiffOptions = {}) {
		this.diffText = diffText;
		this.options = options;
		this.rows = parseDiffRows(diffText);
	}

	setDiff(diffText: string, options: RenderDiffOptions = this.options): void {
		if (this.diffText === diffText && this.options.filePath === options.filePath) return;
		this.diffText = diffText;
		this.options = options;
		this.rows = parseDiffRows(diffText);
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		if (width <= 0 || this.rows.length === 0) return [];

		const language = this.options.filePath ? getLanguageFromPath(this.options.filePath) : undefined;
		const showGutter = width >= 4;
		const naturalGutterWidth = showGutter ? Math.max(1, ...this.rows.map((row) => row.lineNum.length)) : 0;
		const indentWidth = width >= 8 ? 4 : 0;
		const gutterWidth = showGutter ? Math.min(naturalGutterWidth, Math.max(1, width - indentWidth - 3)) : 0;
		const prefixWidth = showGutter ? indentWidth + gutterWidth + 2 : width >= 2 ? 1 : 0;
		const contentWidth = Math.max(1, width - prefixWidth);
		const indent = " ".repeat(indentWidth);
		const continuationPrefix = " ".repeat(prefixWidth);
		const rendered: string[] = [];

		for (const row of this.rows) {
			if (row.kind === "ellipsis") {
				const line = showGutter
					? `${indent}${" ".repeat(gutterWidth)} ${theme.fg("muted", row.content)}`
					: theme.fg("muted", row.content);
				rendered.push(padLine(line, width));
				continue;
			}

			const sign =
				row.kind === "added"
					? theme.fg("toolDiffAdded", "+")
					: row.kind === "removed"
						? theme.fg("toolDiffRemoved", "-")
						: " ";
			const wrapped = wrapTextWithAnsi(renderRowContent(row, language), contentWidth);
			const background =
				row.kind === "added"
					? (text: string): string => theme.bg("toolSuccessBg", text)
					: row.kind === "removed"
						? (text: string): string => theme.bg("toolErrorBg", text)
						: undefined;
			const lineNum = showGutter ? row.lineNum.slice(-gutterWidth).padStart(gutterWidth, " ") : "";
			const firstPrefix = showGutter
				? `${indent}${theme.fg("toolDiffContext", lineNum)} ${sign}`
				: width >= 2
					? sign
					: "";

			for (let i = 0; i < wrapped.length; i++) {
				const prefix = i === 0 ? firstPrefix : continuationPrefix;
				const line = padLine(`${prefix}${wrapped[i]}`, width);
				rendered.push(background ? background(line) : line);
			}
		}

		this.cachedWidth = width;
		this.cachedLines = rendered;
		return rendered;
	}
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	diffText = safeTerminalText(diffText);
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			// Context line
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}
