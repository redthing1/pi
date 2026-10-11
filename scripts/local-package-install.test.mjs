import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { installConsumer, smokeTestNpmConsumer, wireConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

function createArtifactSet(t) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-local-package-install-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const root = join(temporaryRoot, "fixture with spaces");
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writePackage(
		join(repoRoot, "packages", "shared"),
		{
			name: "@pi-package-test/shared",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
			files: ["dist"],
		},
		{
			"dist/index.js": 'export const marker = "local artifact";\n',
			"dist/index.d.ts": 'export declare const marker: "local artifact";\n',
		},
	);
	writePackage(
		join(repoRoot, "packages", "target"),
		{
			name: "@pi-package-test/target",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: {
				".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
				"./feature": { types: "./dist/feature.d.ts", import: "./dist/feature.js" },
			},
			bin: { target: "./dist/cli.js" },
			files: ["dist"],
			dependencies: { "@pi-package-test/shared": "1.0.0" },
		},
		{
			"dist/index.js": 'import { marker } from "@pi-package-test/shared";\nexport { marker };\n',
			"dist/index.d.ts": 'export { marker } from "@pi-package-test/shared";\n',
			"dist/feature.js": "export const feature = true;\n",
			"dist/feature.d.ts": "export declare const feature: true;\n",
			"dist/cli.js": "#!/usr/bin/env node\n",
		},
	);
	writePackage(
		join(repoRoot, "packages", "second"),
		{
			name: "@pi-package-test/second",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			files: ["dist"],
		},
		{
			"dist/index.js": "export const second = true;\n",
			"dist/index.d.ts": "export declare const second: true;\n",
		},
	);
	return {
		artifactSet: produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot, source: null }),
		root,
	};
}

test("wires multiple direct packages without registry fallbacks", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const consumerDirectory = join(root, "consumer");
	mkdirSync(consumerDirectory);
	writeFileSync(
		join(consumerDirectory, "package.json"),
		'{"private":true,"type":"module","dependencies":{"@pi-package-test/target":"1.0.0","@pi-package-test/second":"1.0.0"}}\n',
	);
	wireConsumer({
		artifactSet,
		consumerDirectory,
		packageNames: ["@pi-package-test/target", "@pi-package-test/second"],
	});
	installConsumer({
		artifactSet,
		directory: consumerDirectory,
		packageNames: ["@pi-package-test/target", "@pi-package-test/second"],
	});

	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	assert.match(manifest.dependencies["@pi-package-test/target"], /^file:/);
	assert.match(manifest.dependencies["@pi-package-test/second"], /^file:/);
	smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" });
	smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/second" });

	assert.equal(existsSync(join(consumerDirectory, "package-lock.json")), false);

	rmSync(join(consumerDirectory, "node_modules", "@pi-package-test", "target", "dist", "feature.js"));
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/export \.\/feature does not exist/,
	);
});

test("installs a package as the only direct dependency", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const unsupportedDirectory = join(root, "unsupported-consumer");
	assert.throws(
		() =>
			installConsumer({
				artifactSet,
				directory: unsupportedDirectory,
				packageManager: "yarn",
				packageNames: ["@pi-package-test/target"],
			}),
		/Unsupported package manager: yarn/,
	);
	assert.equal(existsSync(unsupportedDirectory), false);
	const consumerDirectory = join(root, "isolated-consumer");
	installConsumer({ artifactSet, directory: consumerDirectory, packageNames: ["@pi-package-test/target"] });
	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), ["@pi-package-test/target"]);
	smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" });
	const installedManifestPath = join(consumerDirectory, "node_modules", "@pi-package-test", "target", "package.json");
	const installedManifestContents = readFileSync(installedManifestPath, "utf8");
	const installedManifest = JSON.parse(installedManifestContents);
	delete installedManifest.main;
	writeFileSync(installedManifestPath, JSON.stringify(installedManifest));
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/Public Pi package @pi-package-test\/target must declare a string main field/,
	);
	writeFileSync(installedManifestPath, installedManifestContents);
	assert.equal(existsSync(join(consumerDirectory, "package-lock.json")), false);
});

test("preserves physical peer instances and cycles without scripts or source links", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const repoRoot = artifactSet.repoRoot;
	for (const parent of ["target", "shared"]) {
		const source = join(repoRoot, "packages", parent);
		const manifestPath = join(source, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.dependencies = { ...manifest.dependencies, "fixture-dep": "1.0.0" };
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const dependency = join(source, "node_modules/fixture-dep");
		writePackage(
			dependency,
			{
				name: "fixture-dep",
				version: "1.0.0",
				main: "index.cjs",
				dependencies: { "fixture-dep": "1.0.0" },
				peerDependencies: { "fixture-peer": "1.0.0" },
				optionalDependencies: { "fixture-absent-platform": "1.0.0" },
				scripts: { postinstall: "node -e 'throw new Error(\"scripts must not run\")'" },
			},
			{ "index.cjs": 'module.exports = require("fixture-peer");\n' },
		);
		writePackage(
			join(dependency, "node_modules/fixture-peer"),
			{
				name: "fixture-peer",
				version: "1.0.0",
				main: "index.cjs",
			},
			{ "index.cjs": `module.exports = ${JSON.stringify(parent)};\n` },
		);
		symlinkSync("..", join(dependency, "node_modules/fixture-dep"), "junction");
	}
	const graph = produceArtifactSet({ repoRoot, outDir: join(root, "graph-artifacts"), build: false, source: null });
	const directory = join(root, "graph-consumer");
	installConsumer({ artifactSet: graph, directory, packageNames: ["@pi-package-test/target"] });
	rmSync(join(repoRoot, "packages"), { recursive: true });
	for (const parent of ["target", "shared"]) {
		const installed = join(directory, "node_modules/@pi-package-test", parent);
		assert.equal(createRequire(join(installed, "package.json"))("fixture-dep"), parent);
		const dependency = join(installed, "node_modules/fixture-dep");
		assert.equal(realpathSync(join(dependency, "node_modules/fixture-dep")), realpathSync(dependency));
		assert.equal(existsSync(join(dependency, "node_modules/fixture-absent-platform")), false);
		assert.ok(realpathSync(dependency).startsWith(realpathSync(directory)));
	}
});

test("wires a pnpm consumer with local artifact references", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const consumerDirectory = join(root, "pnpm-consumer");
	mkdirSync(consumerDirectory);
	writeFileSync(join(consumerDirectory, "package.json"), '{"private":true,"type":"module"}\n');
	writeFileSync(
		join(consumerDirectory, "pnpm-workspace.yaml"),
		"# existing workspace comment\npackages: []\noverrides:\n  existing: 1.2.3\n",
	);
	wireConsumer({
		artifactSet,
		consumerDirectory,
		packageManager: "pnpm",
		packageNames: ["@pi-package-test/target"],
	});

	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), ["@pi-package-test/target"]);
	assert.equal(manifest.overrides, undefined);
	const workspaceContents = readFileSync(join(consumerDirectory, "pnpm-workspace.yaml"), "utf8");
	assert.match(workspaceContents, /^# existing workspace comment/m);
	const workspace = parse(workspaceContents);
	assert.equal(workspace.overrides.existing, "1.2.3");
	for (const artifact of artifactSet.packages) {
		assert.ok(
			workspace.overrides[artifact.name].endsWith(basename(artifact.tarballPath)),
			`${artifact.name} override must reference its artifact`,
		);
	}
});
