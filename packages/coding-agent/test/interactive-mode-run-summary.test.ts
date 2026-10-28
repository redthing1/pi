import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
let now = 0;

beforeEach(() => {
	initTheme("dark", false);
	now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const h of harnesses.splice(0)) h.cleanup();
});

function observe(h: Harness) {
	harnesses.push(h);
	const chatContainer = new Container();
	// Exercise the real event and rebuild paths without a terminal or spinner timers.
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: h.session },
		isInitialized: true,
		chatContainer,
		outputPad: 1,
		runSummaries: new WeakMap<AgentMessage, string>(),
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		toolExecutionPresenter: { reset: vi.fn(), setCompactExploration: vi.fn(), track: vi.fn(), finish: vi.fn() },
		clearStatusIndicator: vi.fn(),
		checkShutdownRequested: vi.fn(),
		addMessageToChat: (message: AgentMessage) => chatContainer.addChild(new Text(getMessageText(message), 1, 0)),
	}) as {
		handleEvent(event: AgentSessionEvent): Promise<void>;
		rebuildChatFromMessages(): void;
	};
	const pending: Promise<void>[] = [];
	h.session.subscribe((event) => {
		if (["agent_start", "message_end", "agent_end", "agent_settled"].includes(event.type)) {
			pending.push(mode.handleEvent(event));
		}
	});
	return {
		mode,
		flush: () => Promise.all(pending.splice(0)),
		text: () => stripAnsi(chatContainer.render(80).join("\n")),
		chatContainer,
	};
}

test("shows one duration after tools and automatic retries, then retains it across UI rebuilds", async () => {
	const h = await createHarness({
		settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		tools: [
			{
				name: "work",
				label: "Work",
				description: "Synthetic work",
				parameters: Type.Object({}),
				execute: async () => {
					now += 60_000;
					return { content: [{ type: "text", text: "Finished tool" }], details: {} };
				},
			},
		],
	});
	const ui = observe(h);
	h.session.subscribe((event) => {
		if (event.type === "auto_retry_start") {
			expect(ui.text()).not.toContain("Worked for");
			now += 30_000;
		}
	});
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("work", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		fauxAssistantMessage("Final answer"),
	]);
	await h.session.prompt("Synthetic request");
	await ui.flush();
	expect(ui.text()).toMatch(/Worked for 1m 30s · \d{2}:\d{2}/);
	expect(ui.text().match(/Worked for/g)).toHaveLength(1);
	expect(JSON.stringify(h.sessionManager.getEntries())).not.toContain("Worked for");

	ui.mode.rebuildChatFromMessages();
	expect(ui.text()).toMatch(/Final answer[\s\S]*Worked for 1m 30s/);
	expect(ui.text().match(/Worked for/g)).toHaveLength(1);
	ui.mode.rebuildChatFromMessages();
	expect(ui.text().match(/Worked for/g)).toHaveLength(1);
	expect(ui.chatContainer.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);

	await ui.mode.handleEvent({ type: "agent_settled", aborted: false });
	expect(ui.text().match(/Worked for/g)).toHaveLength(1);

	// A later prompt gets its own clock, excluding idle time between requests.
	now += 300_000;
	h.session.subscribe((event) => {
		if (event.type === "agent_start") now += 2000;
	});
	h.setResponses([fauxAssistantMessage("Next answer")]);
	await h.session.prompt("Next synthetic request");
	await ui.flush();
	expect(ui.text()).toContain("Worked for 2.0s");
	expect(ui.text().match(/Worked for/g)).toHaveLength(2);
});

test.each(["error", "aborted"] as const)("settles the clock after an %s response", async (stopReason) => {
	const h = await createHarness({ settings: { retry: { enabled: false } } });
	const ui = observe(h);
	h.session.subscribe((event) => {
		if (event.type === "agent_start") now += 5000;
	});
	h.setResponses([fauxAssistantMessage("Partial answer", { stopReason, errorMessage: "Synthetic interruption" })]);
	await h.session.prompt("Synthetic request");
	await ui.flush();
	expect(ui.text()).toContain("Worked for 5.0s");
	expect(ui.text()).not.toContain("Completed");
});

test("does not invent durations when rendering existing messages", async () => {
	const h = await createHarness();
	h.sessionManager.appendMessage(fauxAssistantMessage("Existing answer"));
	const ui = observe(h);
	ui.mode.rebuildChatFromMessages();
	expect(ui.text()).toContain("Existing answer");
	expect(ui.text()).not.toContain("Worked for");
	await ui.mode.handleEvent({ type: "agent_settled", aborted: false });
	expect(ui.text()).not.toContain("Worked for");
});
