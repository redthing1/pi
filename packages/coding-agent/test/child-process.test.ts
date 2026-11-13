import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { waitForChildProcess } from "../src/utils/child-process.ts";

afterEach(() => vi.useRealTimers());

it.each([false, true])("bounds cancellation settlement without inventing an exit (exited=%s)", async (exited) => {
	vi.useFakeTimers();
	const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
	const controller = new AbortController();
	const result = waitForChildProcess(child as unknown as ChildProcess, controller.signal);
	const outcome = result.then(
		(code) => code,
		(error: Error) => error,
	);
	if (exited) child.emit("exit", 0);
	controller.abort();
	for (let index = 0; index < 100; index++) {
		child.stdout.write("trailing output");
		await vi.advanceTimersByTimeAsync(50);
	}
	if (exited) expect(await outcome).toBe(0);
	else expect(await outcome).toMatchObject({ message: "Command termination could not be confirmed" });
	expect(child.stdout.destroyed).toBe(true);
	expect(child.stderr.destroyed).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});
