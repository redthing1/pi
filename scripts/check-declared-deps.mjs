import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import * as is from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";

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
		if (entry.name === "sessions" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
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
	const source = sourceProgram.getSourceFile(resolve(file));
	if (!source) throw new Error(`Cannot parse ${file}`);
	const imports = new Set();
	const add = (node) => {
		if (!node || !(is.isStringLiteral(node) || is.isNoSubstitutionTemplateLiteral(node))) return;
		const name = dependencyName(node.text);
		if (name) imports.add(name);
	};
	const visit = (node) => {
		if (is.isImportDeclaration(node) || is.isExportDeclaration(node)) add(node.moduleSpecifier);
		if (is.isImportTypeNode(node) && is.isLiteralTypeNode(node.argument)) add(node.argument.literal);
		if (is.isImportEqualsDeclaration(node) && is.isExternalModuleReference(node.moduleReference)) {
			add(node.moduleReference.expression);
		}
		if (is.isCallExpression(node)) {
			if (node.expression.kind === SyntaxKind.ImportKeyword) add(node.arguments[0]);
			if (is.isIdentifier(node.expression) && node.expression.text === "require") add(node.arguments[0]);
			if (
				is.isPropertyAccessExpression(node.expression) &&
				((is.isIdentifier(node.expression.expression) &&
					node.expression.expression.text === "require" &&
					node.expression.name.text === "resolve") ||
					(is.isMetaProperty(node.expression.expression) &&
						node.expression.expression.keywordToken === SyntaxKind.ImportKeyword &&
						node.expression.name.text === "resolve"))
			) {
				add(node.arguments[0]);
			}
		}
		node.forEachChild(visit);
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
	const project = snapshot.getProject(resolve(configPath));
	const diagnostics = project.program.getConfigFileParsingDiagnostics();
	if (diagnostics.length > 0) {
		throw new Error(diagnostics.map((diagnostic) => diagnostic.text).join("\n"));
	}
	const roots = new Set(project.rootFiles.map((file) => resolve(file)));
	return sourceFiles.filter((file) => roots.has(resolve(file)));
}

const sourceConfigPath = resolve("tsconfig.check-declared-deps.json");
const sourceConfig = JSON.stringify({ compilerOptions: { noResolve: true, noLib: true, types: [], allowJs: true }, files: walk(root).map((file) => resolve(file)) });
const buildConfigs = packageDirectories.map((directory) => resolve(directory, "tsconfig.build.json")).filter(existsSync);
const api = new API({ cwd: root, fs: {
	fileExists: (file) => resolve(file) === sourceConfigPath ? true : undefined,
	readFile: (file) => resolve(file) === sourceConfigPath ? sourceConfig : undefined,
} });
const snapshot = api.updateSnapshot({ openProjects: [sourceConfigPath, ...buildConfigs] });
const sourceProgram = snapshot.getProject(sourceConfigPath).program;
try {
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
} finally {
	api.close();
}

if (failures.length > 0) {
	console.error("Imports must be declared by the owning package:");
	for (const failure of failures.sort()) console.error(`  ${failure}`);
	process.exit(1);
}
