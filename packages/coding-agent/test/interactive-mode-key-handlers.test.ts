import { Editor, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	setProgramStatus(): void {}
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

type Harness = {
	editor: Editor;
	lastSigintTime: number;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	session: { dequeueLatestFollowUp: ReturnType<typeof vi.fn> };
	updatePendingMessagesDisplay: ReturnType<typeof vi.fn>;
};

const privateMethods = InteractiveMode.prototype as unknown as {
	handleCtrlC(this: Harness): void;
	handleDequeue(this: Harness): void;
};

describe("InteractiveMode key handlers", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("saves a cleared Ctrl-C draft to editor history", () => {
		const tui = new TuiMainScreen(new FakeTerminal());
		const editor = new Editor(tui, getEditorTheme());
		editor.setText("half written prompt");
		const requestRender = vi.fn();
		const harness = Object.assign(Object.create(InteractiveMode.prototype), {
			editor,
			lastSigintTime: 0,
			ui: { requestRender },
		}) as Harness;

		privateMethods.handleCtrlC.call(harness);

		expect(editor.getText()).toBe("");
		expect(requestRender).toHaveBeenCalledOnce();

		editor.handleInput("\x1b[A");

		expect(editor.getText()).toBe("half written prompt");
	});

	test("edits only the latest queued follow-up message", () => {
		const tui = new TuiMainScreen(new FakeTerminal());
		const editor = new Editor(tui, getEditorTheme());
		editor.setText("draft");
		const dequeueLatestFollowUp = vi.fn(() => "second queued message");
		const updatePendingMessagesDisplay = vi.fn();
		const harness = Object.create(InteractiveMode.prototype) as Harness;
		Object.defineProperties(harness, {
			editor: { value: editor },
			session: { value: { dequeueLatestFollowUp } },
			updatePendingMessagesDisplay: { value: updatePendingMessagesDisplay },
		});

		privateMethods.handleDequeue.call(harness);

		expect(dequeueLatestFollowUp).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("second queued message");
		expect(updatePendingMessagesDisplay).toHaveBeenCalledOnce();
	});
});
