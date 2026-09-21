#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const codingAgentName = "@earendil-works/pi-coding-agent";
const developmentPackages = new Set(["pi-client", "pi-protocol", "pi-server"].map((name) => `@earendil-works/${name}`));

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		encoding: "utf8",
		shell: process.platform === "win32",
		timeout: 300_000,
		...options,
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`);
	}
	return result.stdout;
}

export function packReleasePackages(packages, tarballDirectory) {
	mkdirSync(tarballDirectory, { recursive: true });
	const tarballs = new Map();
	for (const pkg of packages) {
		const manifest = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
		if (manifest.name !== pkg.name) throw new Error(`Unexpected package name in ${pkg.directory}`);
		const output = run(
			"bun",
			["pm", "pack", "--destination", tarballDirectory, "--ignore-scripts", "--quiet"],
			{ cwd: pkg.directory },
		);
		const packed = output.trim().split(/\r?\n/).at(-1);
		if (!packed) throw new Error(`No tarball produced for ${pkg.name}`);
		tarballs.set(pkg.name, {
			tarball: isAbsolute(packed) ? packed : resolve(tarballDirectory, packed),
			sourceDirectory: resolve(pkg.directory),
		});
	}
	return tarballs;
}

export function installCodingAgentConsumer(directory, tarballs, additionalDependencies = []) {
	directory = resolve(directory);
	mkdirSync(directory, { recursive: true });
	const codingAgent = tarballs.get(codingAgentName);
	if (!codingAgent) throw new Error("Missing coding-agent tarball");
	const manifest = {
		private: true,
		dependencies: { [codingAgentName]: `file:./${relative(directory, codingAgent.tarball).replaceAll("\\", "/")}` },
	};
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	// Copy the already-hydrated graph; never resolve versions or acquire code here.
	// Distinct physical dependency instances stay distinct, including peer variants.
	const installed = new Map();
	function stage(name, from, optional = false) {
		const artifact = tarballs.get(name);
		const source = artifact?.sourceDirectory ?? createRequire(join(from, "package.json")).resolve.paths(name)
			?.map((path) => join(path, name)).find((path) => existsSync(join(path, "package.json")));
		if (!source) {
			if (optional) return undefined;
			throw new Error(`Missing frozen dependency ${name} from ${from}; hydrate the reviewed lock first`);
		}
		const identity = realpathSync(source);
		if (installed.has(identity)) return installed.get(identity);
		const target = artifact ? join(directory, "node_modules", name)
			: join(directory, "node_modules/.pi-dependencies", String(installed.size), "node_modules", name);
		installed.set(identity, target);
		mkdirSync(target, { recursive: true });
		if (artifact) {
			run("tar", ["-xzf", artifact.tarball, "--strip-components=1", "-C", target]);
		} else {
			cpSync(identity, target, { recursive: true, verbatimSymlinks: true, filter: (path) => basename(path) !== "node_modules" });
		}
		const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
		for (const dependency of new Set([
			...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}),
			...Object.keys(pkg.peerDependencies ?? {}),
		])) {
			const child = stage(dependency, identity,
				dependency in (pkg.optionalDependencies ?? {}) || pkg.peerDependenciesMeta?.[dependency]?.optional === true);
			if (!child) continue;
			const link = join(target, "node_modules", dependency);
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(relative(dirname(link), child), link, "junction");
		}
		return target;
	}
	stage(codingAgentName, directory);
	for (const { name, sourceDirectory } of additionalDependencies) {
		const target = stage(name, sourceDirectory);
		const link = join(directory, "node_modules", name);
		if (target === link) continue;
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(relative(dirname(link), target), link, "junction");
	}
	const binDirectory = join(directory, "node_modules/.bin");
	mkdirSync(binDirectory, { recursive: true });
	const agent = join(directory, "node_modules", codingAgentName);
	const agentManifest = JSON.parse(readFileSync(join(agent, "package.json"), "utf8"));
	if (process.platform === "win32") {
		writeFileSync(join(binDirectory, "pi.cmd"), `@ECHO off\r\nnode "%~dp0..\\@earendil-works\\pi-coding-agent\\${agentManifest.bin.pi.replaceAll("/", "\\")}" %*\r\n`);
		writeFileSync(join(binDirectory, "pi.ps1"), `& node "$PSScriptRoot/../@earendil-works/pi-coding-agent/${agentManifest.bin.pi}" @args\n`);
	} else {
		symlinkSync(relative(binDirectory, join(agent, agentManifest.bin.pi)), join(binDirectory, "pi"));
	}
}

function checkInstalledPackages(nodeModules, seen = new Set()) {
	if (!existsSync(nodeModules)) return;
	const directories = readdirSync(nodeModules)
		.filter((name) => !name.startsWith("."))
		.flatMap((name) => name.startsWith("@")
			? readdirSync(join(nodeModules, name)).map((child) => join(nodeModules, name, child))
			: [join(nodeModules, name)]);
	for (const directory of directories) {
		if (!existsSync(join(directory, "package.json"))) continue;
		const path = realpathSync(directory);
		if (seen.has(path)) continue;
		seen.add(path);
		const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
		if (developmentPackages.has(manifest.name)) throw new Error(`${manifest.name} must not be installed: ${path}`);
		checkInstalledPackages(join(path, "node_modules"), seen);
	}
}

export function smokeTestCodingAgentConsumer(directory, runtime = process.execPath) {
	checkInstalledPackages(join(directory, "node_modules"));
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	for (const path of ["dist/client", "dist/experimental", "dist/cli/experimental", "dist/bundle/client.js", "dist/bundle/coordinator.js"]) {
		if (existsSync(join(packageDir, path))) throw new Error(`Published package contains development-only code: ${path}`);
	}
	const home = mkdtempSync(join(directory, "smoke-home-"));
	const entry = join(directory, "smoke-sdk.mjs");
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		APPDATA: home,
		LOCALAPPDATA: home,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	try {
		writeFileSync(entry, `import assert from "node:assert/strict";
import { createAgentSession, SessionManager, ModelRuntime } from "${codingAgentName}";
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof SessionManager.inMemory, "function");
assert.equal(typeof ModelRuntime.create, "function");
for (const name of ["pi-client", "pi-protocol", "pi-server"]) {
  assert.throws(() => import.meta.resolve("@earendil-works/" + name), /Cannot find|cannot find/, name + " must not be installed");
}
for (const subpath of ["/client", "/experimental/plugin"]) {
  assert.throws(() => import.meta.resolve("${codingAgentName}" + subpath), /not exported|not defined|Cannot find|cannot find/);
}
`);
		run(runtime, [entry], { cwd: directory, env, timeout: 30_000 });
		for (const cli of new Set([manifest.bin.pi, "dist/cli.js"])) {
			const output = run(runtime, [join(packageDir, cli), "--version"], { cwd: directory, env, timeout: 30_000 });
			if (output.trim() !== manifest.version) throw new Error(`Unexpected version from ${cli}: ${output}`);
		}
	} finally {
		rmSync(entry, { force: true });
		rmSync(home, { recursive: true, force: true });
	}
	console.log(`Coding-agent SDK and CLI consumer smoke tests passed (${runtime}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("Usage: bun scripts/coding-agent-consumer.mjs");
	const root = mkdtempSync(join(tmpdir(), "pi-package-consumer-"));
	try {
		const tarballs = packReleasePackages(getPublicWorkspacePackages(), join(root, "tarballs"));
		const directory = join(root, "consumer");
		installCodingAgentConsumer(directory, tarballs);
		smokeTestCodingAgentConsumer(directory);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
