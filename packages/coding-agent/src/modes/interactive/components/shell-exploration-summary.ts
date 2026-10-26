import { safeTerminalLabel } from "@earendil-works/pi-tui";
import { shortenPath } from "../../../core/tools/render-utils.ts";
import { theme } from "../theme/theme.ts";

const SEARCH_COMMANDS = new Set(["ack", "ag", "egrep", "fgrep", "grep", "pt", "rg", "rga", "ripgrep-all"]);
const FIND_COMMANDS = new Set(["fd", "fdfind", "find"]);
const GREP_FILTER_COMMANDS = new Set(["egrep", "fgrep", "grep"]);
const LIST_COMMANDS = new Set(["exa", "eza", "ls", "tree"]);
const READ_COMMANDS = new Set(["bat", "batcat", "cat", "head", "less", "more", "nl", "sed", "tail"]);
const NAVIGATION_COMMANDS = new Set(["cd", "pwd", "true"]);
const POSTPROCESSING_COMMANDS = new Set(["awk", "cut", "head", "nl", "sed", "sort", "tail", "uniq", "wc"]);
const UNSAFE_PATTERN =
	/(^|[;&|]\s*)(bun|chmod|chown|cp|curl|mkdir|mv|node|npm|perl|python|python3|rm|rmdir|sh|tee|touch|wget|xargs)\b|>>?|<\(|\b(find\b[^|;&]*\s(-delete|-exec))\b|\bsed\b[^|;&]*\s-i\b/;

export interface BashExplorationSummary {
	label: "Exploring" | "Explored";
	row: string;
}

type ParsedShellExploration = {
	action: "find" | "list" | "read" | "search";
	pattern?: string;
	path?: string;
};

type ShellSegment = {
	command: string;
	separator?: "and" | "or" | "pipe" | "sequence";
};

export function formatBashExplorationSummary(options: {
	command: string;
	output: string;
	status: "running" | "complete" | "cancelled" | "error";
	exitCode?: number;
}): BashExplorationSummary | undefined {
	const parsed = parseReadonlyShellExploration(options.command);
	if (!parsed) return undefined;

	const label = options.status === "running" ? "Exploring" : "Explored";
	const outputLabels = fileBasenamesFromOutput(options.output).map(safeTerminalLabel);
	const outputSuffix =
		outputLabels.length > 0
			? theme.fg("muted", ` (${outputLabels.slice(0, 5).join(", ")}${outputLabels.length > 5 ? ", ..." : ""})`)
			: "";
	const statusSuffix =
		options.status === "error"
			? theme.fg("error", ` failed${options.exitCode !== undefined ? ` ${options.exitCode}` : ""}`)
			: options.status === "cancelled"
				? theme.fg("warning", " cancelled")
				: "";

	switch (parsed.action) {
		case "search":
			return {
				label,
				row:
					`${formatAction("Search")} ${theme.fg("accent", safeTerminalLabel(`/${parsed.pattern || "..."}/`))}` +
					theme.fg("toolOutput", " in ") +
					theme.fg("accent", formatDisplayPath(parsed.path, ".")) +
					outputSuffix +
					statusSuffix,
			};
		case "find":
			return {
				label,
				row:
					`${formatAction("Find")} ${theme.fg("accent", safeTerminalLabel(parsed.pattern || "..."))}` +
					theme.fg("toolOutput", " in ") +
					theme.fg("accent", formatDisplayPath(parsed.path, ".")) +
					outputSuffix +
					statusSuffix,
			};
		case "list":
			return {
				label,
				row: `${formatAction("List")} ${theme.fg("accent", formatDisplayPath(parsed.path, "."))}${outputSuffix}${statusSuffix}`,
			};
		case "read":
			return {
				label,
				row: `${formatAction("Read")} ${theme.fg("accent", formatDisplayPath(parsed.path, "..."))}${outputSuffix}${statusSuffix}`,
			};
	}
}

function parseReadonlyShellExploration(command: string): ParsedShellExploration | undefined {
	const normalized = stripHarmlessStderrRedirects(command.trim());
	if (!normalized || UNSAFE_PATTERN.test(normalized)) return undefined;

	const explorations: ParsedShellExploration[] = [];
	for (const segment of splitShellSegments(normalized)) {
		const tokens = tokenizeShellLike(segment.command);
		const commandName = basename(tokens[0] ?? "");
		if (!commandName || NAVIGATION_COMMANDS.has(commandName)) continue;
		if (segment.separator === "or" && commandName === "echo" && explorations.length > 0) continue;
		if (isOutputFilterSegment(segment, commandName, tokens.slice(1), explorations)) continue;

		const summary = summarizeCommandTokens(commandName, tokens.slice(1));
		if (summary) {
			explorations.push(summary);
			continue;
		}
		if (POSTPROCESSING_COMMANDS.has(commandName)) continue;
		return undefined;
	}
	return combineExplorationPipeline(explorations);
}

function isOutputFilterSegment(
	segment: ShellSegment,
	command: string,
	tokens: string[],
	explorations: ParsedShellExploration[],
): boolean {
	const previous = explorations[explorations.length - 1];
	if (segment.separator !== "pipe" || !previous) return false;
	if (previous.action !== "find" && previous.action !== "list") return false;
	if (!GREP_FILTER_COMMANDS.has(command)) return false;
	return isStdinGrepFilter(tokens);
}

function isStdinGrepFilter(tokens: string[]): boolean {
	const positional: string[] = [];
	const regexpValues: string[] = [];
	const safeLongOptions = new Set([
		"--extended-regexp",
		"--fixed-strings",
		"--ignore-case",
		"--invert-match",
		"--line-number",
		"--line-regexp",
		"--no-filename",
		"--word-regexp",
	]);
	const safeShortOptions = new Set(["E", "F", "H", "h", "i", "n", "v", "w", "x"]);

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token) continue;
		if (token === "--") {
			positional.push(...tokens.slice(index + 1));
			break;
		}
		if (token === "-e" || token === "--regexp") {
			const value = tokens[index + 1];
			if (!value) return false;
			regexpValues.push(value);
			index++;
			continue;
		}
		if (token.startsWith("-e") && token.length > 2) {
			regexpValues.push(token.slice(2));
			continue;
		}
		if (token.startsWith("--regexp=")) {
			regexpValues.push(token.slice("--regexp=".length));
			continue;
		}
		if (safeLongOptions.has(token)) continue;
		if (token.startsWith("--")) return false;
		if (token.startsWith("-") && token.length > 1) {
			if ([...token.slice(1)].every((char) => safeShortOptions.has(char))) continue;
			return false;
		}
		positional.push(token);
	}

	if (regexpValues.length > 0) return positional.length === 0;
	return positional.length === 1;
}

function combineExplorationPipeline(explorations: ParsedShellExploration[]): ParsedShellExploration | undefined {
	if (explorations.length === 0) return undefined;
	if (explorations.length === 1) return explorations[0];
	if (explorations.length === 2 && explorations[0]?.action === "read" && explorations[1]?.action === "search") {
		return { ...explorations[1], path: explorations[1].path ?? explorations[0].path };
	}
	return undefined;
}

function stripHarmlessStderrRedirects(command: string): string {
	return command.replace(/(^|\s)2>\s*\/dev\/null\b/g, "$1").trim();
}

function summarizeCommandTokens(command: string, tokens: string[]): ParsedShellExploration | undefined {
	if (SEARCH_COMMANDS.has(command)) return summarizeSearchTokens(tokens, command === "rg" || command === "rga");
	if (FIND_COMMANDS.has(command)) return summarizeFindTokens(command, tokens);
	if (LIST_COMMANDS.has(command)) return summarizeListTokens(command, tokens);
	if (READ_COMMANDS.has(command)) return summarizeReadTokens(command, tokens);
	if (command === "git") return summarizeGitTokens(tokens);
	return undefined;
}

function summarizeSearchTokens(tokens: string[], supportsFilesFlag: boolean): ParsedShellExploration {
	const regexp = optionValue(tokens, new Set(["-e", "--regexp"]));
	const positional = positionalArgs(tokens, {
		optionsWithValues: new Set([
			"-A",
			"-B",
			"-C",
			"-e",
			"-f",
			"-g",
			"-m",
			"-t",
			"--after-context",
			"--before-context",
			"--context",
			"--file",
			"--glob",
			"--iglob",
			"--max-count",
			"--max-depth",
			"--regexp",
			"--type",
			"--type-add",
			"--type-not",
		]),
	});
	if (supportsFilesFlag && tokens.includes("--files")) {
		return { action: "list", path: positional[0] };
	}
	return {
		action: "search",
		pattern: regexp ?? positional[0],
		path: regexp ? positional[0] : positional[1],
	};
}

function summarizeFindTokens(command: string, tokens: string[]): ParsedShellExploration {
	if (command === "find") {
		const pattern = optionValue(tokens, new Set(["-iname", "-name", "-path"]));
		const positional = positionalArgs(tokens, {
			optionsWithValues: new Set(["-maxdepth", "-mindepth", "-name", "-iname", "-newer", "-path", "-type"]),
		});
		const path = positional[0] ?? ".";
		return pattern ? { action: "find", pattern, path } : { action: "list", path };
	}

	const positional = positionalArgs(tokens, {
		optionsWithValues: new Set(["-E", "-e", "-g", "-t", "--extension", "--glob", "--type"]),
	});
	const pattern = positional[0];
	return pattern ? { action: "find", pattern, path: positional[1] } : { action: "list", path: "." };
}

function summarizeListTokens(command: string, tokens: string[]): ParsedShellExploration {
	const optionsWithValues =
		command === "tree"
			? new Set(["-I", "-L", "-P", "--charset", "--filelimit", "--sort"])
			: new Set(["-I", "-w", "--block-size", "--color", "--format", "--ignore-glob", "--quoting-style", "--sort"]);
	const positional = positionalArgs(tokens, { optionsWithValues });
	return { action: "list", path: positional[0] };
}

function summarizeReadTokens(command: string, tokens: string[]): ParsedShellExploration | undefined {
	if (command === "sed") {
		const path = sedReadPath(tokens);
		return path ? { action: "read", path } : undefined;
	}

	const optionsWithValues =
		command === "head" || command === "tail"
			? new Set(["-c", "-n", "--bytes", "--lines"])
			: command === "bat" || command === "batcat"
				? new Set([
						"--language",
						"--line-range",
						"--map-syntax",
						"--style",
						"--tabs",
						"--terminal-width",
						"--theme",
					])
				: command === "less"
					? new Set(["-P", "-j", "-p", "-x", "-y", "-z", "--pattern", "--prompt", "--tabs"])
					: command === "nl"
						? new Set(["-b", "-i", "-s", "-v", "-w"])
						: new Set<string>();
	const path = singlePositionalArg(tokens, optionsWithValues);
	return path ? { action: "read", path } : undefined;
}

function summarizeGitTokens(tokens: string[]): ParsedShellExploration | undefined {
	const [subcommand, ...tail] = tokens;
	if (subcommand === "grep") return summarizeSearchTokens(tail, false);
	if (subcommand === "ls-files") {
		const positional = positionalArgs(tail, {
			optionsWithValues: new Set(["--exclude", "--exclude-from", "--pathspec-from-file"]),
		});
		return { action: "list", path: positional[0] };
	}
	return undefined;
}

function formatAction(action: string): string {
	return theme.fg("toolTitle", theme.bold(action));
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

function fileBasenamesFromOutput(output: string): string[] {
	const labels = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split(":")[0] ?? line)
		.filter((line) => line.includes("/") || line.includes("\\"))
		.map((line) => basename(line));
	return dedupe(labels);
}

function splitShellSegments(input: string): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let current = "";
	let nextSeparator: ShellSegment["separator"];
	let quote: "'" | '"' | undefined;
	let escaped = false;

	const flush = (separator?: ShellSegment["separator"]) => {
		const segment = current.trim();
		if (segment) {
			segments.push({ command: segment, separator: nextSeparator });
			nextSeparator = separator;
		} else if (separator) {
			nextSeparator = separator;
		}
		current = "";
	};

	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (!char) continue;
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			current += char;
			escaped = true;
			continue;
		}
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			current += char;
			quote = char;
			continue;
		}
		if (char === ";") {
			flush("sequence");
			continue;
		}
		if (char === "|" && input[index + 1] === "|") {
			flush("or");
			index++;
			continue;
		}
		if (char === "|" || (char === "&" && input[index + 1] === "&")) {
			flush(char === "&" ? "and" : "pipe");
			if (char === "&") index++;
			continue;
		}
		current += char;
	}
	flush();
	return segments;
}

function tokenizeShellLike(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

function optionValue(tokens: string[], optionNames: Set<string>): string | undefined {
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token) continue;
		const equalsIndex = token.indexOf("=");
		if (equalsIndex > 0 && optionNames.has(token.slice(0, equalsIndex))) {
			return token.slice(equalsIndex + 1);
		}
		if (optionNames.has(token)) {
			return tokens[index + 1];
		}
	}
	return undefined;
}

function singlePositionalArg(tokens: string[], optionsWithValues: Set<string>): string | undefined {
	const positional = positionalArgs(tokens, { optionsWithValues }).filter((token) => token !== "--");
	return positional.length === 1 ? positional[0] : undefined;
}

function sedReadPath(tokens: string[]): string | undefined {
	if (!tokens.includes("-n")) return undefined;
	const usesScriptOption = tokens.some((token) => token === "-e" || token === "-f");
	const positional = positionalArgs(tokens, { optionsWithValues: new Set(["-e", "-f"]) }).filter(
		(token) => token !== "--",
	);
	if (usesScriptOption) return positional[0];
	return positional.length >= 2 ? positional[positional.length - 1] : undefined;
}

function positionalArgs(tokens: string[], options: { optionsWithValues: Set<string> }): string[] {
	const positional: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token) continue;
		if (token === "--") continue;
		if (options.optionsWithValues.has(token)) {
			index++;
			continue;
		}
		if (token.startsWith("--") && token.includes("=")) continue;
		if (token.startsWith("-")) continue;
		positional.push(token);
	}
	return positional;
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
