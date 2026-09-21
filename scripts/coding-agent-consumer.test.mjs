import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";

const codingAgentName = "@earendil-works/pi-coding-agent";
const devPackages = ["pi-client", "pi-protocol", "pi-server"].map((name) => `@earendil-works/${name}`);

function createFixture(t, { importServer = false, declareServer = false, externalGraph = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-consumer-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packages = [codingAgentName, "@earendil-works/chord", ...devPackages].map((name) => ({
		name,
		directory: join(root, "packages", name.split("/")[1]),
	}));
	for (const pkg of packages) {
		const isAgent = pkg.name === codingAgentName;
		const manifest = {
			name: pkg.name,
			version: "1.0.0",
			type: "module",
			exports: isAgent ? {
				".": "./dist/index.js",
				"./client": { source: "./src/client/index.ts" },
				"./experimental/plugin": { source: "./src/experimental/plugin.ts" },
			} : "./dist/index.js",
			...(isAgent ? {
				bin: { pi: "dist/bundle/cli.js" },
				dependencies: {
					"@earendil-works/chord": "1.0.0",
					...(declareServer ? { "@earendil-works/pi-server": "1.0.0" } : {}),
				},
				devDependencies: Object.fromEntries(devPackages.map((name) => [name, "1.0.0"])),
			} : {}),
		};
		const files = {
			"package.json": JSON.stringify(manifest),
			"dist/index.js": isAgent ? `
${importServer ? 'import "@earendil-works/pi-server";' : ""}
import { marker } from "@earendil-works/chord";
if (marker !== "local tarball") throw new Error("Wrong Chord artifact");
export function createAgentSession() {}
export class SessionManager { static inMemory() {} }
export class ModelRuntime { static create() {} }
` : 'export const marker = "local tarball";',
			...(isAgent ? {
				"dist/cli.js": 'console.log("1.0.0");',
				"dist/bundle/cli.js": 'console.log("1.0.0");',
			} : {}),
		};
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(pkg.directory, path)), { recursive: true });
			writeFileSync(join(pkg.directory, path), content);
		}
		if (externalGraph && (isAgent || pkg.name === "@earendil-works/chord")) {
			const version = isAgent ? "1.0.0" : "2.0.0";
			manifest.dependencies = { ...manifest.dependencies, "fixture-dep": version };
			writeFileSync(join(pkg.directory, "package.json"), JSON.stringify(manifest));
			const dependency = join(pkg.directory, "node_modules/fixture-dep");
			mkdirSync(dependency, { recursive: true });
			writeFileSync(join(dependency, "package.json"), JSON.stringify({
				name: "fixture-dep", version, main: "index.cjs",
				dependencies: { "fixture-dep": version },
				optionalDependencies: { "fixture-absent-platform": "1.0.0" },
				scripts: { install: "exit 91" },
			}));
			writeFileSync(join(dependency, "index.cjs"), `module.exports = ${JSON.stringify(version)};`);
		}
	}
	const tarballs = packReleasePackages(packages, join(root, "tarballs"));
	const directory = join(root, "consumer");
	installCodingAgentConsumer(directory, tarballs);
	return directory;
}

// #9132: installing every tarball directly hid undeclared runtime imports.
test("stages coding-agent and only its declared runtime dependencies", (t) => {
	const directory = createFixture(t);
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), [codingAgentName]);
	for (const name of devPackages) {
		assert.equal(existsSync(join(directory, "node_modules", name)), false);
	}
	smokeTestCodingAgentConsumer(directory);

	const nested = join(directory, "node_modules", codingAgentName, "node_modules/@earendil-works/pi-server");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@earendil-works/pi-server", version: "1.0.0" }));
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /pi-server must not be installed/);
	rmSync(nested, { recursive: true });

	const experimental = join(directory, "node_modules", codingAgentName, "dist/experimental");
	mkdirSync(experimental);
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /contains development-only code/);
});

// #9132: smoke-test the public SDK, not just a bundled CLI that hides missing imports.
test("fails when the SDK imports an undeclared server despite a working CLI", (t) => {
	const directory = createFixture(t, { importServer: true });
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /Cannot find package '@earendil-works\/pi-server'/);
});

test("fails if a development-only dependency is added back to the published dependency tree", (t) => {
	const directory = createFixture(t, { declareServer: true });
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /pi-server must not be installed/);
});

test("stages exact installed instances and cycles without scripts or source-tree links", (t) => {
	const directory = createFixture(t, { externalGraph: true });
	rmSync(join(dirname(directory), "packages"), { recursive: true });
	for (const [name, version] of [[codingAgentName, "1.0.0"], ["@earendil-works/chord", "2.0.0"]]) {
		const packageDirectory = join(directory, "node_modules", name);
		assert.equal(createRequire(join(packageDirectory, "package.json"))("fixture-dep"), version);
		const dependency = join(packageDirectory, "node_modules/fixture-dep");
		assert.equal(realpathSync(join(dependency, "node_modules/fixture-dep")), realpathSync(dependency));
		assert.equal(existsSync(join(dependency, "node_modules/fixture-absent-platform")), false);
	}
	smokeTestCodingAgentConsumer(directory);
});
