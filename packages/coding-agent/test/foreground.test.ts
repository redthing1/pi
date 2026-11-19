import { afterEach, describe, expect, it, vi } from "vitest";
import { ForegroundController } from "../src/core/foreground.ts";

afterEach(() => vi.useRealTimers());

function fixture() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const controller = new ForegroundController();
	const listeners = new Set<() => void>();
	let ready = false;
	const options = {
		ready: () => ready,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		controller,
		listeners,
		options,
		finish() {
			ready = true;
			for (const listener of [...listeners]) listener();
		},
	};
}

describe("foreground waits", () => {
	it("releases other waits even if one subscription fails to dispose", async () => {
		const f = fixture();
		const failed = f.controller.wait({
			...f.options,
			subscribe: () => () => {
				throw new Error("Dispose failed");
			},
		});
		const assertion = expect(failed).rejects.toThrow("Dispose failed");
		const other = f.controller.wait(f.options);
		expect(f.controller.release()).toBe(2);
		await assertion;
		expect(await other).toBe("released");
		expect(f.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shares a nonrenewable allowance across successive and parallel joins", async () => {
		const f = fixture();
		const first = f.controller.wait({ ...f.options, timeoutMs: 10_000 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await first).toBe("timeout");
		const second = f.controller.wait(f.options);
		const parallel = f.controller.wait(f.options);
		await vi.advanceTimersByTimeAsync(19_999);
		expect(f.listeners.size).toBe(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(await second).toBe("timeout");
		expect(await parallel).toBe("timeout");
		expect(await f.controller.wait(f.options)).toBe("skipped");
		expect(f.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("releases all foreground attachments and prevents another passive join", async () => {
		const f = fixture();
		const command = f.controller.wait({ ...f.options, passive: false });
		const child = f.controller.wait(f.options);
		expect(f.controller.release()).toBe(2);
		expect(await command).toBe("released");
		expect(await child).toBe("released");
		expect(await f.controller.wait(f.options)).toBe("skipped");
		f.finish();
		expect(await f.controller.wait(f.options)).toBe("ready");
		expect(f.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("steering releases passive joins while foreground execution retains its policy", async () => {
		const f = fixture();
		const command = f.controller.wait({ ...f.options, passive: false });
		const child = f.controller.wait(f.options);
		f.controller.steer();
		expect(await child).toBe("steering");
		expect(f.listeners.size).toBe(1);
		f.finish();
		expect(await command).toBe("ready");
		f.controller.begin();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans registrations on abort, readiness errors and session replacement", async () => {
		const f = fixture();
		const abort = new AbortController();
		const pending = f.controller.wait({ ...f.options, signal: abort.signal });
		abort.abort();
		expect(await pending).toBe("aborted");
		const replacement = f.controller.wait(f.options);
		f.controller.begin();
		expect(await replacement).toBe("aborted");
		let fail = false;
		const failed = f.controller.wait({
			...f.options,
			ready: () => {
				if (fail) throw new Error("Unavailable");
				return false;
			},
		});
		const assertion = expect(failed).rejects.toThrow("Unavailable");
		fail = true;
		for (const listener of [...f.listeners]) listener();
		await assertion;
		expect(f.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("subscribes before rechecking readiness and handles synchronous notifications", async () => {
		const f = fixture();
		let ready = false;
		let disposed = 0;
		expect(
			await f.controller.wait({
				ready: () => ready,
				subscribe(changed) {
					ready = true;
					changed();
					return () => disposed++;
				},
			}),
		).toBe("ready");
		expect(disposed).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
