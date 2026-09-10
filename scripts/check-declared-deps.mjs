import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import ts from "typescript";

const root = process.cwd();
const builtins = new Set([
	...builtinModules,
	...builtinModules.map((name) => `node:${name}`),
	"bun",
	"bun:test",
	"node:test",
	"node:test/reporters",
]);
const hostProvidedExtensionPackages = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
]);

function walk(directory, stopAtPackages = false) {
	if (!existsSync(directory)) return [];
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (stopAtPackages && existsSync(join(path, "package.json"))) continue;
			files.push(...walk(path, stopAtPackages));
		}
		else if ([".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extname(entry.name))) files.push(path);
	}
	return files;
}

function dependencyName(specifier) {
	if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) return;
	if (specifier.startsWith("node:")) return;
	if (builtins.has(specifier)) return;
	return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

function collectImports(file) {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const imports = new Set();
	const add = (node) => {
		if (!node || !ts.isStringLiteralLike(node)) return;
		const name = dependencyName(node.text);
		if (name) imports.add(name);
	};
	const visit = (node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
		if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			add(node.moduleReference.expression);
		}
		if (ts.isCallExpression(node)) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
			if (ts.isIdentifier(node.expression) && node.expression.text === "require") add(node.arguments[0]);
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				((ts.isIdentifier(node.expression.expression) &&
					node.expression.expression.text === "require" &&
					node.expression.name.text === "resolve") ||
					(node.expression.expression.kind === ts.SyntaxKind.ImportMeta && node.expression.name.text === "resolve"))
			) {
				add(node.arguments[0]);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return imports;
}

function declaredDependencies(packageJson, includeDevelopment) {
	return new Set([
		packageJson.name,
		...Object.keys(packageJson.dependencies ?? {}),
		...Object.keys(packageJson.optionalDependencies ?? {}),
		...Object.keys(packageJson.peerDependencies ?? {}),
		...(includeDevelopment ? Object.keys(packageJson.devDependencies ?? {}) : []),
	]);
}

const failures = [];
const packageDirectories = [root];

function collectPackageDirectories(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
		const path = join(directory, entry.name);
		if (existsSync(join(path, "package.json"))) packageDirectories.push(path);
		collectPackageDirectories(path);
	}
}

collectPackageDirectories(root);
const workspaceNames = new Set(
	packageDirectories.map((directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name),
);

function checkFiles(files, allowed, context) {
	for (const file of files) {
		for (const dependency of collectImports(file)) {
			if (!allowed.has(dependency)) failures.push(`${relative(root, file)} imports undeclared ${dependency} (${context})`);
		}
	}
}

function runtimeSourceFiles(directory, packageJson, sourceFiles) {
	if (packageJson.private) return [];
	const configPath = join(directory, "tsconfig.build.json");
	if (!existsSync(configPath)) return sourceFiles;
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
	if (parsed.errors.length > 0) {
		throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
	}
	const roots = new Set(parsed.fileNames);
	return sourceFiles.filter((file) => roots.has(file));
}

const extensionRoot = join(root, "packages", "coding-agent", "examples", "extensions");
for (const directory of packageDirectories) {
	const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const sourceDirectory = join(directory, "src");
	const sourceFiles = walk(sourceDirectory, true);
	const runtimeFiles = runtimeSourceFiles(directory, packageJson, sourceFiles);
	checkFiles(runtimeFiles, declaredDependencies(packageJson, false), `${packageJson.name} runtime`);

	const sourcePrefix = `${sourceDirectory}${sep}`;
	const runtimeFileSet = new Set(runtimeFiles);
	const developmentFiles = walk(directory, true).filter(
		(file) => !file.startsWith(sourcePrefix) || !runtimeFileSet.has(file),
	);
	const hostProvided = directory.startsWith(`${extensionRoot}${sep}`) ? hostProvidedExtensionPackages : [];
	const rootWorkspaces = directory === root ? workspaceNames : [];
	checkFiles(
		developmentFiles,
		new Set([...declaredDependencies(packageJson, true), ...hostProvided, ...rootWorkspaces]),
		`${packageJson.name} development`,
	);
}

if (failures.length > 0) {
	console.error("Imports must be declared by the owning package:");
	for (const failure of failures.sort()) console.error(`  ${failure}`);
	process.exit(1);
}
