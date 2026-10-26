function escapeControl(character: string): string {
	if (character === "\n") return "\\n";
	if (character === "\r") return "\\r";
	if (character === "\t") return "\\t";
	return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
}

/** Render untrusted text without allowing it to issue terminal commands. */
export function safeTerminalText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, escapeControl);
}

/** Display labels and titles on one line while preserving visible path distinctions. */
export function safeTerminalLabel(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, escapeControl);
}
