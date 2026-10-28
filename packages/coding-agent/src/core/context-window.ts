import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

export const CONTEXT_WINDOW_ENTRY = "pi.context-window";

export interface ContextWindow {
	capacity: number;
	defaultWindow?: number;
	override?: number;
	effective: number;
}

/** Decimal token counts by default; explicit binary suffixes remain available. */
export function parseContextWindow(value: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*(ki|mi|k|m)?$/i.exec(value.trim());
	const units: Record<string, number> = { k: 1_000, m: 1_000_000, ki: 1024, mi: 1024 ** 2 };
	const [whole, fraction = ""] = (match?.[1] ?? "0").split(".");
	const numerator = BigInt(whole + fraction) * BigInt(units[match?.[2]?.toLowerCase() ?? ""] ?? 1);
	const denominator = 10n ** BigInt(fraction.length);
	const tokens = Number(numerator / denominator);
	if (!Number.isSafeInteger(tokens) || tokens <= 0 || numerator % denominator !== 0n) {
		throw new Error("Use a positive token count, such as 128k, 1.5m, or 128ki.");
	}
	return tokens;
}

/** Branch-local metadata restores naturally on resume, fork, and tree navigation. */
export function getContextWindowOverride(branch: readonly SessionEntry[]): number | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === CONTEXT_WINDOW_ENTRY) {
			return typeof entry.data === "number" && Number.isSafeInteger(entry.data) && entry.data > 0
				? entry.data
				: undefined;
		}
	}
	return undefined;
}

/** Leave catalog metadata intact; constrain the model used by this request. */
export function capContextWindow<T extends Model<any>>(model: T, limit: number | undefined): T {
	if (limit === undefined || (model.contextWindow > 0 && model.contextWindow <= limit)) return model;
	return { ...model, contextWindow: limit, maxTokens: Math.min(model.maxTokens, limit) };
}
