import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { safeTerminalLabel, safeTerminalText } from "../src/safe-text.ts";
import { ProcessTerminal } from "../src/terminal.ts";
import { hyperlink } from "../src/terminal-image.ts";

describe("untrusted terminal text", () => {
	const control = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u;
	const inputs = [
		"\x07\x1b]52;c;dGVzdA==\x07",
		"\x1b[2J\x1b[31mred\x1b[0m",
		"\x1bPpayload\x1b\\\x1b_payload\x1b\\",
		"\x9b2J\x9d52;c;dGVzdA==\x9c",
		"\x1b]unterminated\x1b[",
	];
	it("preserves ordinary text and visibly escapes terminal controls", () => {
		assert.equal(safeTerminalText("雪\tα\r\nline"), "雪\tα\nline");
		assert.equal(safeTerminalLabel("a\nb\tc\rd"), "a\\nb\\tc\\rd");
		for (const input of inputs) {
			assert(!control.test(safeTerminalText(input)));
			assert(!/[\x00-\x1f\x7f-\x9f]/u.test(safeTerminalLabel(input)));
			for (let split = 0; split <= input.length; split++) {
				assert(!control.test(safeTerminalText(input.slice(0, split)) + safeTerminalText(input.slice(split))));
			}
		}
	});
	it("the title writer emits only its own terminal framing", () => {
		const chunks: string[] = [];
		const write = mock.method(process.stdout, "write", (chunk: string) => {
			chunks.push(chunk);
			return true;
		});
		try {
			new ProcessTerminal().setTitle(`workspace${inputs[0]}`);
		} finally {
			write.mock.restore();
		}
		assert.equal(chunks.length, 1);
		assert(chunks[0].startsWith("\x1b]0;"));
		assert(chunks[0].endsWith("\x07"));
		assert(!control.test(chunks[0].slice(4, -1)));
	});
	it("encodes URL controls before adding trusted hyperlink framing", () => {
		const url = `https://example.invalid/${inputs[0]}\n`;
		const rendered = hyperlink("fixture", url);
		const actualUrl = rendered.slice(5, rendered.indexOf("\x1b\\"));
		assert(!/[\x00-\x20\x7f-\x9f]/u.test(actualUrl));
		assert(actualUrl.includes("%1B"));
		assert.equal(
			hyperlink("fixture", "https://example.invalid/"),
			"\x1b]8;;https://example.invalid/\x1b\\fixture\x1b]8;;\x1b\\",
		);
	});
});
