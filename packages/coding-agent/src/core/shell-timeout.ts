import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";
import type { ShellSettings } from "./settings-schema.ts";

const MAX_SHELL_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

/** Validate shell limits and resolve the execution timeout. */
export function resolveShellTimeout(requested: number | undefined, policy: ShellSettings = {}): number {
	if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("Invalid shell settings");
	const timeout = policy.timeoutSeconds === undefined ? SETTINGS_DEFAULTS.shell.timeoutSeconds : policy.timeoutSeconds;
	const maximum =
		policy.maxTimeoutSeconds === undefined ? SETTINGS_DEFAULTS.shell.maxTimeoutSeconds : policy.maxTimeoutSeconds;
	for (const [name, value] of [
		["shell.timeoutSeconds", timeout],
		["shell.maxTimeoutSeconds", maximum],
	] as const) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_SHELL_TIMEOUT_SECONDS) {
			throw new Error(`Invalid ${name}: expected positive finite seconds up to ${MAX_SHELL_TIMEOUT_SECONDS}`);
		}
	}
	if (timeout > maximum) throw new Error("shell.timeoutSeconds must not exceed shell.maxTimeoutSeconds");
	const effective = requested === undefined ? timeout : requested;
	if (typeof effective !== "number" || !Number.isFinite(effective) || effective <= 0) {
		throw new Error("Invalid timeout: expected positive finite seconds");
	}
	if (effective > maximum) throw new Error(`Invalid timeout: maximum is ${maximum} seconds`);
	return effective;
}
