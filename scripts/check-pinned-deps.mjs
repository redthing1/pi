import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigFileTextToJson } from "typescript";

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const internalPackageNames = new Set(["@earendil-works/chord"]);
const packageJsonFiles = [];

function collectPackageJsonFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				collectPackageJsonFiles(join(directory, entry.name));
			}
			continue;
		}

		if (entry.isFile() && entry.name === "package.json") {
			packageJsonFiles.push(join(directory, entry.name));
		}
	}
}

function isInternalWorkspaceDependency(name) {
	return name.startsWith("@earendil-works/pi-") || internalPackageNames.has(name);
}

function isNonRegistrySpecifier(specifier) {
	return /^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:|git:\/\/)/.test(specifier);
}

function getVersionSpecifier(specifier) {
	if (!specifier.startsWith("npm:")) return specifier;
	const aliasTarget = specifier.slice("npm:".length);
	const versionSeparator = aliasTarget.lastIndexOf("@");
	if (versionSeparator <= 0) return specifier;
	return aliasTarget.slice(versionSeparator + 1);
}

const failures = [];

collectPackageJsonFiles(".");

for (const file of packageJsonFiles.sort()) {
	const packageJson = JSON.parse(readFileSync(file, "utf8"));

	for (const section of dependencySections) {
		const dependencies = packageJson[section];
		if (!dependencies) continue;

		for (const [name, specifier] of Object.entries(dependencies)) {
			if (isInternalWorkspaceDependency(name) || isNonRegistrySpecifier(specifier)) continue;
			if (exactVersionPattern.test(getVersionSpecifier(specifier))) continue;
			failures.push(`${file}: ${section}.${name} must be pinned, found ${specifier}`);
		}
	}
}

function expandWorkspacePattern(pattern) {
	if (!pattern.includes("*")) return [pattern];
	const [prefix, suffix] = pattern.split("*");
	const parent = prefix.replace(/\/$/, "");
	return readdirSync(parent, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `${prefix}${entry.name}${suffix}`)
		.filter((directory) => packageJsonFiles.includes(join(directory, "package.json")));
}

function sortedRecord(record = {}) {
	return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

const rootPackageJson = JSON.parse(readFileSync("package.json", "utf8"));
const expectedWorkspacePaths = new Set(["", ...rootPackageJson.workspaces.flatMap(expandWorkspacePattern)]);
const parsedLockfile = parseConfigFileTextToJson("bun.lock", readFileSync("bun.lock", "utf8"));
if (parsedLockfile.error) {
	failures.push(`bun.lock: ${parsedLockfile.error.messageText}`);
} else {
	const lockWorkspaces = parsedLockfile.config.workspaces ?? {};
	for (const workspacePath of expectedWorkspacePaths) {
		const manifestPath = workspacePath ? join(workspacePath, "package.json") : "package.json";
		const packageJson = JSON.parse(readFileSync(manifestPath, "utf8"));
		const locked = lockWorkspaces[workspacePath];
		if (!locked) {
			failures.push(`bun.lock: missing workspace ${workspacePath || "."}`);
			continue;
		}
		if (locked.name !== packageJson.name) {
			failures.push(`bun.lock: ${workspacePath || "."} name is ${locked.name}, expected ${packageJson.name}`);
		}
		if (workspacePath && locked.version !== packageJson.version) {
			failures.push(`bun.lock: ${workspacePath} version is ${locked.version}, expected ${packageJson.version}`);
		}
		for (const section of dependencySections) {
			if (JSON.stringify(sortedRecord(locked[section])) !== JSON.stringify(sortedRecord(packageJson[section]))) {
				failures.push(`bun.lock: ${workspacePath || "."} ${section} does not match ${manifestPath}`);
			}
		}
	}
	for (const workspacePath of Object.keys(lockWorkspaces)) {
		if (!expectedWorkspacePaths.has(workspacePath)) failures.push(`bun.lock: unexpected workspace ${workspacePath}`);
	}
}

if (failures.length > 0) {
	console.error("Dependency metadata checks failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
