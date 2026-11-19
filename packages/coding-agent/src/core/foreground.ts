export const FOREGROUND_WAIT_MS = 30_000;

export type ForegroundWaitOutcome = "ready" | "timeout" | "skipped" | "released" | "steering" | "aborted";

export interface ForegroundWaitOptions {
	ready(): boolean;
	subscribe(changed: () => void): () => void;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Passive joins share the parent run's waiting allowance. */
	passive?: boolean;
}

export interface ForegroundControl {
	wait(options: ForegroundWaitOptions): Promise<ForegroundWaitOutcome>;
	/** Release all managed foreground waits without stopping their work. */
	release(): number;
}

interface PendingWait {
	passive: boolean;
	finish(outcome: ForegroundWaitOutcome): void;
}

/** Session-owned control of foreground waits, independent of execution. */
export class ForegroundController implements ForegroundControl {
	private readonly pending = new Set<PendingWait>();
	private remaining = FOREGROUND_WAIT_MS;
	private waitingSince?: number;
	private deferred?: "skipped" | "steering";

	begin(): void {
		for (const wait of [...this.pending]) wait.finish("aborted");
		this.remaining = FOREGROUND_WAIT_MS;
		this.waitingSince = undefined;
		this.deferred = undefined;
	}

	release(): number {
		const waits = [...this.pending];
		if (!waits.length) return 0;
		this.deferred = "skipped";
		for (const wait of waits) wait.finish("released");
		return waits.length;
	}

	steer(): void {
		this.deferred = "steering";
		for (const wait of [...this.pending]) if (wait.passive) wait.finish("steering");
	}

	wait(options: ForegroundWaitOptions): Promise<ForegroundWaitOutcome> {
		const timeout = options.timeoutMs ?? FOREGROUND_WAIT_MS;
		if (!Number.isFinite(timeout) || timeout <= 0 || timeout > FOREGROUND_WAIT_MS)
			throw new Error(`Foreground waits must be positive and at most ${FOREGROUND_WAIT_MS} milliseconds.`);
		const passive = options.passive !== false;
		if (options.signal?.aborted) return Promise.resolve("aborted");
		if (options.ready()) return Promise.resolve("ready");
		if (passive && this.deferred) return Promise.resolve(this.deferred);
		const budget = this.budget();
		if (passive && budget <= 0) return Promise.resolve("skipped");

		return new Promise<ForegroundWaitOutcome>((resolve, reject) => {
			let settled = false;
			let unsubscribe: (() => void) | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				this.account();
				this.pending.delete(wait);
				if (![...this.pending].some((item) => item.passive)) this.waitingSince = undefined;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				const dispose = unsubscribe;
				unsubscribe = undefined;
				dispose?.();
			};
			const finish = (outcome: ForegroundWaitOutcome) => {
				if (settled) return;
				settled = true;
				try {
					cleanup();
				} catch (error) {
					reject(error);
					return;
				}
				resolve(outcome);
			};
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				try {
					cleanup();
				} catch (cleanupError) {
					reject(cleanupError);
					return;
				}
				reject(error);
			};
			const check = () => {
				if (settled) return;
				try {
					if (options.ready()) finish("ready");
				} catch (error) {
					fail(error);
				}
			};
			const abort = () => finish("aborted");
			const wait: PendingWait = { passive, finish };
			this.pending.add(wait);
			if (passive && this.waitingSince === undefined) this.waitingSince = performance.now();
			try {
				unsubscribe = options.subscribe(check);
				if (settled) {
					const dispose = unsubscribe;
					unsubscribe = undefined;
					dispose();
				} else {
					options.signal?.addEventListener("abort", abort, { once: true });
					timer = setTimeout(
						() => {
							check();
							finish("timeout");
						},
						Math.ceil(passive ? Math.min(timeout, budget) : timeout),
					);
					if (options.signal?.aborted) abort();
					else check();
				}
			} catch (error) {
				fail(error);
			}
		});
	}

	private budget(): number {
		return Math.max(
			0,
			this.remaining - (this.waitingSince === undefined ? 0 : performance.now() - this.waitingSince),
		);
	}

	private account(): void {
		this.remaining = this.budget();
		if (this.waitingSince !== undefined) this.waitingSince = performance.now();
	}
}
