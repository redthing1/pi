import { safeTerminalLabel, truncateToWidth } from "@earendil-works/pi-tui";
import { invalidArgText, shortenPath, str } from "../../../core/tools/render-utils.ts";
import { theme } from "../theme/theme.ts";
import { formatBashExplorationSummary } from "./shell-exploration-summary.ts";
import type { ToolExecutionSnapshot } from "./tool-execution.ts";

const EXPLORATION_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

type ObjectArgs = Record<string, unknown>;

export function isExplorationToolName(toolName: string): boolean {
	return EXPLORATION_TOOL_NAMES.has(toolName);
}

export function isExplorationToolSnapshot(snapshot: ToolExecutionSnapshot): boolean {
	if (isExplorationToolName(snapshot.toolName)) return true;
	if (snapshot.toolName !== "bash") return false;
	if (!snapshot.argsComplete && (!snapshot.result || snapshot.isPartial)) return false;
	return formatBashToolSummary(snapshot) !== undefined;
}

export function formatExplorationHeader(snapshots: ToolExecutionSnapshot[], width: number): string {
	const hasActiveTool = snapshots.some((snapshot) => !snapshot.result || snapshot.isPartial);
	const hasError = snapshots.some((snapshot) => snapshot.result?.isError);
	const bullet = hasError ? theme.fg("error", "•") : theme.fg("muted", "•");
	const label = hasActiveTool ? "Exploring" : "Explored";
	return truncateToWidth(`${bullet} ${theme.fg("toolTitle", theme.bold(label))}`, width);
}

export function formatExplorationRows(snapshots: ToolExecutionSnapshot[]): string[] {
	const rows: string[] = [];
	let pendingReadLabels: string[] = [];

	const flushReadLabels = () => {
		if (pendingReadLabels.length === 0) return;
		rows.push(`${formatAction("Read")} ${dedupe(pendingReadLabels).join(theme.fg("muted", ", "))}`);
		pendingReadLabels = [];
	};

	for (const snapshot of snapshots) {
		if (snapshot.toolName === "read") {
			pendingReadLabels.push(formatReadLabel(snapshot));
			continue;
		}

		flushReadLabels();
		rows.push(formatNonReadSummary(snapshot));
	}

	flushReadLabels();
	return rows;
}

function formatNonReadSummary(snapshot: ToolExecutionSnapshot): string {
	switch (snapshot.toolName) {
		case "grep":
			return formatGrepSummary(snapshot);
		case "find":
			return formatFindSummary(snapshot);
		case "ls":
			return formatLsSummary(snapshot);
		case "bash":
			return formatBashToolSummary(snapshot) ?? `${formatAction(snapshot.toolName)}${formatStatusSuffix(snapshot)}`;
		default:
			return `${formatAction(snapshot.toolName)}${formatStatusSuffix(snapshot)}`;
	}
}

function formatBashToolSummary(snapshot: ToolExecutionSnapshot): string | undefined {
	const args = objectArgs(snapshot.args);
	const command = argString(args, "command");
	if (!command) return undefined;
	const summary = formatBashExplorationSummary({
		command,
		output: textOutput(snapshot),
		status: snapshot.result ? (snapshot.result.isError ? "error" : "complete") : "running",
	});
	return summary?.row;
}

function formatGrepSummary(snapshot: ToolExecutionSnapshot): string {
	const args = objectArgs(snapshot.args);
	const pattern = argString(args, "pattern");
	const path = argString(args, "path");
	const glob = argString(args, "glob");
	let text =
		`${formatAction("Search")} ` +
		(pattern === null ? invalidArgText(theme) : theme.fg("accent", safeTerminalLabel(`/${pattern || ""}/`))) +
		theme.fg("toolOutput", ` in ${formatPath(path, ".")}`);
	if (glob) {
		text += theme.fg("toolOutput", ` (${safeTerminalLabel(glob)})`);
	}

	const matchLimit = numberDetail(snapshot, "matchLimitReached");
	if (matchLimit !== undefined) {
		text += theme.fg("warning", ` limit ${matchLimit}`);
	}
	if (textOutput(snapshot).trim() === "No matches found") {
		text += theme.fg("muted", " no matches");
	}
	return text + formatStatusSuffix(snapshot);
}

function formatFindSummary(snapshot: ToolExecutionSnapshot): string {
	const args = objectArgs(snapshot.args);
	const pattern = argString(args, "pattern");
	const path = argString(args, "path");
	let text =
		`${formatAction("Find")} ` +
		(pattern === null ? invalidArgText(theme) : theme.fg("accent", safeTerminalLabel(pattern || ""))) +
		theme.fg("toolOutput", ` in ${formatPath(path, ".")}`);

	const resultLimit = numberDetail(snapshot, "resultLimitReached");
	if (resultLimit !== undefined) {
		text += theme.fg("warning", ` limit ${resultLimit}`);
	}
	if (textOutput(snapshot).trim() === "No files found matching pattern") {
		text += theme.fg("muted", " no files");
	}
	return text + formatStatusSuffix(snapshot);
}

function formatLsSummary(snapshot: ToolExecutionSnapshot): string {
	const args = objectArgs(snapshot.args);
	const path = argString(args, "path");
	let text = `${formatAction("List")} ${formatPath(path, ".")}`;

	const entryLimit = numberDetail(snapshot, "entryLimitReached");
	if (entryLimit !== undefined) {
		text += theme.fg("warning", ` limit ${entryLimit}`);
	}
	if (textOutput(snapshot).trim() === "(empty directory)") {
		text += theme.fg("muted", " empty");
	}
	return text + formatStatusSuffix(snapshot);
}

function formatReadLabel(snapshot: ToolExecutionSnapshot): string {
	const args = objectArgs(snapshot.args);
	const rawPath = str(args?.file_path ?? args?.path);
	let label =
		rawPath === null ? invalidArgText(theme) : theme.fg("accent", formatDisplayPath(rawPath || "...", "..."));

	const offset = numberArg(args, "offset");
	const limit = numberArg(args, "limit");
	if (offset !== undefined || limit !== undefined) {
		const startLine = offset ?? 1;
		const endLine = limit !== undefined ? startLine + limit - 1 : undefined;
		label += theme.fg("warning", `:${startLine}${endLine !== undefined ? `-${endLine}` : ""}`);
	}

	return label + formatStatusSuffix(snapshot);
}

function formatStatusSuffix(snapshot: ToolExecutionSnapshot): string {
	if (snapshot.result?.isError) {
		return theme.fg("error", " failed");
	}
	return "";
}

function formatAction(action: string): string {
	return theme.fg("toolTitle", theme.bold(action));
}

function formatPath(value: string | null, fallback: string): string {
	if (value === null) return invalidArgText(theme);
	return theme.fg("accent", formatDisplayPath(value || fallback, fallback));
}

function formatDisplayPath(value: string | undefined, fallback: string): string {
	return basename(value && value.length > 0 ? value : fallback);
}

function basename(value: string): string {
	const shortened = shortenPath(value);
	const normalized = shortened.replace(/\\/g, "/").replace(/\/+$/g, "");
	const label = normalized.split("/").filter(Boolean).pop();
	return label ?? (shortened || value || "...");
}

function objectArgs(args: unknown): ObjectArgs | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	return args as ObjectArgs;
}

function argString(args: ObjectArgs | undefined, key: string): string | null {
	return str(args?.[key]);
}

function numberArg(args: ObjectArgs | undefined, key: string): number | undefined {
	const value = args?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function details(snapshot: ToolExecutionSnapshot): ObjectArgs | undefined {
	const value = snapshot.result?.details;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as ObjectArgs;
}

function numberDetail(snapshot: ToolExecutionSnapshot, key: string): number | undefined {
	const value = details(snapshot)?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textOutput(snapshot: ToolExecutionSnapshot): string {
	const content = snapshot.result?.content ?? [];
	return content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}
