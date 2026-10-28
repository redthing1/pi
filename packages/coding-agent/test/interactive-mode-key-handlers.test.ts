import { Editor, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
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
	setupKeyHandlers(): void;
	handleCtrlC(this: Harness): void;
	handleDequeue(this: Harness): void;
};

describe("InteractiveMode key handlers", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function interruptHarness(remapped = false) {
		const ui = new TuiMainScreen(new FakeTerminal());
		const editor = new CustomEditor(
			ui,
			getEditorTheme(),
			new KeybindingsManager(remapped ? { "app.interrupt": "ctrl+q" } : {}),
		);
		const harness = {
			defaultEditor: editor,
			editor,
			ui,
			isBashMode: false,
			lastEscapeTime: 0,
			session: { isStreaming: false, isBashRunning: false, extensionRunner: { emit: vi.fn() } },
			settingsManager: { getDoubleEscapeAction: () => "tree" },
			showTreeSelector: vi.fn(),
			restoreQueuedMessagesToEditor: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		};
		Object.setPrototypeOf(harness, InteractiveMode.prototype);
		privateMethods.setupKeyHandlers.call(harness);
		return harness;
	}

	test.each([false, true])("interrupt reaches extensions while idle and streaming (remapped=%s)", (remapped) => {
		const h = interruptHarness(remapped);
		const key = remapped ? "\x11" : "\x1b";
		h.editor.setText("unfinished draft");
		h.editor.handleInput(key);
		expect(h.session.extensionRunner.emit).toHaveBeenCalledWith({ type: "ui_interrupt" });
		expect(h.editor.getText()).toBe("unfinished draft");
		expect(h.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
		h.session.isStreaming = true;
		h.editor.handleInput(key);
		expect(h.session.extensionRunner.emit).toHaveBeenCalledTimes(2);
		expect(h.restoreQueuedMessagesToEditor).toHaveBeenCalledWith({
			abort: true,
			abortReason: "Interrupted by the user.",
		});
	});

	test("interrupt preserves autocomplete dismissal, shell-input exit and double-Escape navigation", () => {
		const h = interruptHarness();
		const autocomplete = vi.spyOn(h.editor, "isShowingAutocomplete").mockReturnValue(true);
		h.editor.handleInput("\x1b");
		expect(h.session.extensionRunner.emit).not.toHaveBeenCalled();
		autocomplete.mockRestore();
		h.editor.setText("!unfinished command");
		h.isBashMode = true;
		h.editor.handleInput("\x1b");
		expect(h.session.extensionRunner.emit).not.toHaveBeenCalled();
		expect(h.editor.getText()).toBe("");
		h.editor.handleInput("\x1b");
		h.editor.handleInput("\x1b");
		expect(h.showTreeSelector).toHaveBeenCalledOnce();
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
