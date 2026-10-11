import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { createRequire } from "node:module";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];

function createFileSpecifier(fromDirectory, path) {
	const relativePath = relative(fromDirectory, path);
	return isAbsolute(relativePath) ? pathToFileURL(path).href : `file:./${relativePath.replaceAll("\\", "/")}`;
}

function detectIndentation(contents) {
	return contents.match(/\n([\t ]+)"/)?.[1] ?? "\t";
}

function packageDirectory(directory, packageName) {
	return join(directory, "node_modules", ...packageName.split("/"));
}

// Generic consumers run Node ESM, so other export conditions are outside this smoke test's scope.
function runtimeTarget(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const candidate of value) {
			const target = runtimeTarget(candidate);
			if (target) return target;
		}
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	for (const condition of ["import", "node", "default"]) {
		const target = runtimeTarget(value[condition]);
		if (target) return target;
	}
	return undefined;
}

function typesTarget(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return typeof value.types === "string" ? value.types : undefined;
}

// Generic validation covers literal exports only; wildcard exports need package-specific test inputs.
function literalExports(manifest) {
	// Packages without an exports map are still checked through main, types, and the root import.
	if (manifest.exports === undefined) return [];
	if (typeof manifest.exports === "string" || Array.isArray(manifest.exports)) return [[".", manifest.exports]];
	const keys = Object.keys(manifest.exports);
	if (!keys.some((key) => key.startsWith("."))) return [[".", manifest.exports]];
	return Object.entries(manifest.exports).filter(([subpath]) => !subpath.includes("*"));
}

function assertPackageFile(directory, target, description) {
	if (typeof target !== "string") throw new Error(`${description} must be a package path, found ${String(target)}`);
	const path = resolve(directory, target);
	const relativePath = relative(directory, path);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`${description} must stay inside the package, found ${target}`);
	}
	if (!existsSync(path)) throw new Error(`${description} does not exist: ${path}`);
}

function preparePnpmWorkspace(consumerDirectory, specifiers) {
	const workspacePath = join(consumerDirectory, "pnpm-workspace.yaml");
	const contents = existsSync(workspacePath) ? readFileSync(workspacePath, "utf8") : "";
	const document = parseDocument(contents);
	if (document.errors.length > 0) {
		throw new Error(
			`Invalid pnpm workspace file ${workspacePath}: ${document.errors.map((error) => error.message).join("; ")}`,
		);
	}
	const workspace = document.toJS();
	if (workspace !== null && (typeof workspace !== "object" || Array.isArray(workspace))) {
		throw new Error(`Invalid pnpm workspace file ${workspacePath}: root must be a mapping`);
	}
	if (
		workspace?.overrides !== undefined &&
		(typeof workspace.overrides !== "object" || workspace.overrides === null || Array.isArray(workspace.overrides))
	) {
		throw new Error(`Invalid pnpm workspace file ${workspacePath}: overrides must be a mapping`);
	}
	if (document.contents === null) document.contents = document.createNode({});
	for (const [name, specifier] of Object.entries(specifiers)) document.setIn(["overrides", name], specifier);
	return { contents: String(document), path: workspacePath };
}

export function wireConsumer({ artifactSet, consumerDirectory, packageNames, packageManager = "npm" }) {
	if (packageManager !== "npm" && packageManager !== "pnpm")
		throw new Error(`Unsupported package manager: ${packageManager}`);
	if (packageNames.length === 0) throw new Error("At least one package is required");
	const packageJsonPath = join(consumerDirectory, "package.json");
	if (!existsSync(packageJsonPath)) throw new Error(`Consumer package.json does not exist: ${packageJsonPath}`);
	const contents = readFileSync(packageJsonPath, "utf8");
	const manifest = JSON.parse(contents);
	const artifacts = new Map(artifactSet.packages.map((pkg) => [pkg.name, pkg]));
	for (const packageName of packageNames) artifactSet.getPackage(packageName);
	const specifiers = Object.fromEntries(
		artifactSet.packages.map((pkg) => [pkg.name, createFileSpecifier(consumerDirectory, pkg.tarballPath)]),
	);

	const directPackages = new Set(packageNames);
	for (const section of dependencySections) {
		for (const name of Object.keys(manifest[section] ?? {})) {
			if (artifacts.has(name)) directPackages.add(name);
		}
	}
	for (const name of directPackages) {
		const targetSection =
			dependencySections.find((section) => Object.hasOwn(manifest[section] ?? {}, name)) ?? "dependencies";
		for (const section of dependencySections) {
			if (section !== targetSection && manifest[section]) delete manifest[section][name];
		}
		manifest[targetSection] = { ...manifest[targetSection], [name]: specifiers[name] };
	}
	if (packageManager === "npm") manifest.overrides = { ...manifest.overrides, ...specifiers };
	const pnpmWorkspace = packageManager === "pnpm" ? preparePnpmWorkspace(consumerDirectory, specifiers) : undefined;
	writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, detectIndentation(contents))}\n`);
	if (pnpmWorkspace) writeFileSync(pnpmWorkspace.path, pnpmWorkspace.contents);
	return manifest;
}

export function installConsumer({
	artifactSet,
	directory,
	packageNames,
	packageManager = "npm",
	repoRoot = artifactSet.repoRoot ?? process.cwd(),
	extraDependencies = [],
}) {
	if (packageManager !== "npm" && packageManager !== "bun")
		throw new Error(`Unsupported package manager: ${packageManager}`);
	if (packageNames.length === 0) throw new Error("At least one package is required");
	for (const name of packageNames) artifactSet.getPackage(name);
	directory = resolve(directory);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
	wireConsumer({ artifactSet, consumerDirectory: directory, packageNames });
	const artifacts = new Map(artifactSet.packages.map((pkg) => [pkg.name, pkg]));
	const sourceDirectories = new Map(
		getPublicWorkspacePackages(join(repoRoot, "packages")).map((pkg) => [pkg.name, pkg.directory]),
	);
	// Copy the already-hydrated graph; never resolve versions or acquire code here.
	// Distinct physical dependency instances stay distinct, including peer variants.
	const installed = new Map();
	function stage(name, from, optional = false) {
		const artifact = artifacts.get(name);
		const source =
			sourceDirectories.get(name) ??
			createRequire(join(from, "package.json"))
				.resolve.paths(name)
				?.map((path) => join(path, name))
				.find((path) => existsSync(join(path, "package.json")));
		if (!source) {
			if (optional) return undefined;
			throw new Error(`Missing frozen dependency ${name} from ${from}; hydrate the reviewed lock first`);
		}
		const identity = realpathSync(source);
		if (installed.has(identity)) return installed.get(identity);
		const target = artifact
			? join(directory, "node_modules", name)
			: join(directory, "node_modules/.pi-dependencies", String(installed.size), "node_modules", name);
		installed.set(identity, target);
		mkdirSync(target, { recursive: true });
		if (artifact) {
			execFileSync("tar", ["-xzf", artifact.tarballPath, "--strip-components=1", "-C", target]);
		} else {
			cpSync(identity, target, {
				recursive: true,
				verbatimSymlinks: true,
				filter: (path) => basename(path) !== "node_modules",
			});
		}
		const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
		for (const dependency of new Set([
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.optionalDependencies ?? {}),
			...Object.keys(pkg.peerDependencies ?? {}),
		])) {
			const child = stage(
				dependency,
				identity,
				dependency in (pkg.optionalDependencies ?? {}) || pkg.peerDependenciesMeta?.[dependency]?.optional === true,
			);
			if (!child) continue;
			const link = join(target, "node_modules", dependency);
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(relative(dirname(link), child), link, "junction");
		}
		return target;
	}
	for (const name of packageNames) stage(name, repoRoot);
	for (const { name, sourceDirectory } of extraDependencies) {
		const target = stage(name, sourceDirectory);
		const link = join(directory, "node_modules", name);
		if (target === link) continue;
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(relative(dirname(link), target), link, "junction");
	}

	const binDirectory = join(directory, "node_modules/.bin");
	mkdirSync(binDirectory, { recursive: true });
	for (const target of installed.values()) {
		const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
		const bins = typeof pkg.bin === "string" ? { [pkg.name.split("/").at(-1)]: pkg.bin } : (pkg.bin ?? {});
		for (const [name, path] of Object.entries(bins)) {
			const link = join(binDirectory, name);
			if (existsSync(link)) continue;
			if (process.platform === "win32") {
				const entry = relative(binDirectory, join(target, path)).replaceAll("/", "\\");
				writeFileSync(link + ".cmd", `@ECHO off\r\nnode "%~dp0${entry}" %*\r\n`);
			} else symlinkSync(relative(binDirectory, join(target, path)), link);
		}
	}
}

export function smokeTestNpmConsumer({ directory, artifactSet, packageName }) {
	const artifact = artifactSet.getPackage(packageName);
	const installedDirectory = packageDirectory(directory, packageName);
	const manifest = JSON.parse(readFileSync(join(installedDirectory, "package.json"), "utf8"));
	if (manifest.version !== artifact.version) {
		throw new Error(`${packageName} version mismatch: expected ${artifact.version}, found ${manifest.version}`);
	}
	if (typeof manifest.main !== "string")
		throw new Error(`Public Pi package ${packageName} must declare a string main field`);
	if (typeof manifest.types !== "string")
		throw new Error(`Public Pi package ${packageName} must declare a string types field`);
	assertPackageFile(installedDirectory, manifest.main, `${packageName} main`);
	assertPackageFile(installedDirectory, manifest.types, `${packageName} types`);

	const runtimeSpecifiers = [];
	for (const [subpath, value] of literalExports(manifest)) {
		const runtime = runtimeTarget(value);
		const types = typesTarget(value);
		if (runtime) {
			assertPackageFile(installedDirectory, runtime, `${packageName} export ${subpath}`);
			runtimeSpecifiers.push(subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`);
		}
		if (types) assertPackageFile(installedDirectory, types, `${packageName} types export ${subpath}`);
	}
	for (const [name, target] of Object.entries(
		typeof manifest.bin === "string" ? { [packageName.split("/").at(-1)]: manifest.bin } : (manifest.bin ?? {}),
	)) {
		assertPackageFile(
			installedDirectory,
			target.startsWith("./") ? target : `./${target}`,
			`${packageName} bin ${name}`,
		);
	}

	const smokePath = join(directory, "artifact-smoke.mjs");
	const resolveChecks = runtimeSpecifiers
		.map((specifier) => `assert.ok(existsSync(fileURLToPath(import.meta.resolve(${JSON.stringify(specifier)}))));`)
		.join("\n");
	writeFileSync(
		smokePath,
		`import assert from "node:assert/strict";\nimport { existsSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nimport ${JSON.stringify(packageName)};\n${resolveChecks}\n`,
	);
	try {
		execFileSync(process.execPath, [smokePath], { cwd: directory, stdio: "inherit", timeout: 300_000 });
	} finally {
		rmSync(smokePath, { force: true });
	}
}

export function packageConsumerDirectoryName(packageName) {
	return packageName.replace(/^@/, "").replaceAll("/", "-");
}
