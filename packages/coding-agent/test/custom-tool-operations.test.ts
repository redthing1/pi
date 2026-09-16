import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import {
	buildSystemPrompt,
	createBashTool,
	createEditTool,
	createFindTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/index.ts";

describe("custom tool operation isolation", () => {
	it("exports the structured system prompt builder", () => {
		const prompt = buildSystemPrompt({ cwd: "/remote/work", contextFiles: [] });
		expect(prompt).toContain("Current working directory: /remote/work");
	});

	it("does not apply local read-path variants before custom operations", async () => {
		const cwd = "/remote/work";
		const requestedPath = "Capture AM.txt";
		const receivedPaths: string[] = [];
		const tool = createReadTool(cwd, {
			operations: {
				access: async (path) => {
					receivedPaths.push(path);
				},
				readFile: async (path) => {
					receivedPaths.push(path);
					return Buffer.from("remote content", "utf8");
				},
				detectImageMimeType: async () => null,
			},
		});

		const result = await tool.execute("read-remote", { path: requestedPath });

		expect(receivedPaths).toEqual([join(cwd, requestedPath), join(cwd, requestedPath)]);
		expect(result.content).toEqual([{ type: "text", text: "remote content" }]);
	});

	it("lets custom file backends interpret raw model paths", async () => {
		const resolverInputs: string[] = [];
		const backendPaths: string[] = [];
		const resolvePath = (path: string): string => {
			resolverInputs.push(path);
			return `/home/remote/${path.slice(2)}`;
		};
		let content = "before\n";
		const access = async (path: string): Promise<void> => {
			backendPaths.push(path);
		};
		const readFile = async (path: string): Promise<Buffer> => {
			backendPaths.push(path);
			return Buffer.from(content);
		};
		const writeFile = async (path: string, next: string): Promise<void> => {
			backendPaths.push(path);
			content = next;
		};
		const exists = async (path: string): Promise<boolean> => {
			backendPaths.push(path);
			return true;
		};
		const read = createReadTool("/local/work", { operations: { resolvePath, access, readFile } });
		const write = createWriteTool("/local/work", {
			operations: { resolvePath, mkdir: access, writeFile },
		});
		const edit = createEditTool("/local/work", { operations: { resolvePath, access, readFile, writeFile } });
		const ls = createLsTool("/local/work", {
			operations: {
				resolvePath,
				exists,
				stat: async () => ({ isDirectory: () => true }),
				readdir: async () => [],
			},
		});
		const find = createFindTool("/local/work", {
			operations: { resolvePath, exists, glob: async () => [] },
		});

		await read.execute("read-remote-home", { path: "~/read.txt" });
		await write.execute("write-remote-home", { path: "~/write.txt", content: "before\n" });
		await edit.execute("edit-remote-home", {
			path: "~/edit.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
		await ls.execute("ls-remote-home", { path: "~/list" });
		await find.execute("find-remote-home", { path: "~/search", pattern: "*.txt" });

		expect(resolverInputs).toEqual(["~/read.txt", "~/write.txt", "~/edit.txt", "~/list", "~/search"]);
		expect(backendPaths.every((path) => path === "/home/remote" || path.startsWith("/home/remote/"))).toBe(true);
	});

	it("lets custom write and edit operations own mutation serialization", async () => {
		const queued: string[] = [];
		let content = "before\n";
		const mutationQueue = async <T>(path: string, mutate: () => Promise<T>): Promise<T> => {
			queued.push(path);
			return mutate();
		};
		const write = createWriteTool("/remote/work", {
			operations: {
				mkdir: async () => {},
				mutationQueue,
				writeFile: async (_path, next) => {
					content = next;
				},
			},
		});
		const edit = createEditTool("/remote/work", {
			operations: {
				access: async () => {},
				mutationQueue,
				readFile: async () => Buffer.from(content, "utf8"),
				writeFile: async (_path, next) => {
					content = next;
				},
			},
		});

		await write.execute("write-remote", { path: "alias.txt", content: "original\n" });
		await edit.execute("edit-remote", {
			path: "target.txt",
			edits: [{ oldText: "original", newText: "updated" }],
		});

		expect(queued).toEqual(["/remote/work/alias.txt", "/remote/work/target.txt"]);
		expect(content).toBe("updated\n");
	});

	it("lets custom bash operations own the full output path", async () => {
		const tool = createBashTool("/remote/work", {
			operations: {
				managesFullOutput: true,
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("x".repeat(60 * 1024), "utf8"));
					return { exitCode: 0, fullOutputPath: "/remote/tmp/full.log" };
				},
			},
		});

		const result = await tool.execute("bash-remote", { command: "generate-output" });

		expect(result.details?.fullOutputPath).toBe("/remote/tmp/full.log");
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type === "text") {
			expect(result.content[0].text).toContain("Full output: /remote/tmp/full.log");
			expect(result.content[0].text).not.toContain("undefined");
		}
	});

	it("does not create a local overflow file for backend-managed bash output", async () => {
		const result = await executeBashWithOperations("generate-output", "/remote/work", {
			managesFullOutput: true,
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("x".repeat(60 * 1024), "utf8"));
				return { exitCode: 0, fullOutputPath: "/remote/tmp/full.log" };
			},
		});

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBe("/remote/tmp/full.log");
	});
});
