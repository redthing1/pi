import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const cliPath = resolve("packages/coding-agent/dist/cli.js");
if (!existsSync(cliPath)) {
	throw new Error(`Local Pi CLI has not been built: ${cliPath}`);
}

// Query Bun's configured bin directory using this checkout's manifest, without
// requiring or creating a global package installation.
const globalBinDir = execFileSync(process.execPath, ["pm", "bin", "--global"], {
	encoding: "utf8",
	env: { ...process.env, BUN_INSTALL_GLOBAL_DIR: process.cwd() },
}).trim();
if (!globalBinDir) {
	throw new Error("Bun did not report a global binary directory");
}

mkdirSync(globalBinDir, { recursive: true });
const linkPath = join(globalBinDir, "pi");
const temporaryLinkPath = join(globalBinDir, `.pi-link-${process.pid}`);

rmSync(temporaryLinkPath, { force: true });
try {
	symlinkSync(cliPath, temporaryLinkPath);
	renameSync(temporaryLinkPath, linkPath);
} finally {
	rmSync(temporaryLinkPath, { force: true });
}

console.log(`Linked pi to ${cliPath}`);
