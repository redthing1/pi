import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { chmodSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

describe("SessionManager compaction candidates", () => {
	it.each(["before-retained", "after-retained"] as const)(
		"preserves effective system state ahead of %s content",
		(placement) => {
			const session = SessionManager.inMemory();
			session.appendMessage({
				role: "system",
				content: "base",
				sections: { cwd: "old" },
				toolsAdded: [{ name: "old", description: "old", parameters: Type.Object({}) }],
				timestamp: 1,
			});
			const anchor = session.appendMessage(userMsg("keep"));
			session.appendMessage({
				role: "system",
				content: "extra",
				sections: { cwd: "remote" },
				toolsRemoved: [{ name: "old" }],
				toolsAdded: [{ name: "read", description: "remote read", parameters: Type.Object({}) }],
				timestamp: 2,
			});
			session.appendMessage(assistantMsg("latest"));
			const effective = getCurrentSystemMessage(session.buildSessionContext().messages);
			const candidate = session.createCompactionCandidate("summary", anchor, 123, undefined, true, undefined, {
				placement,
			});
			expect(candidate.context.messages[0]).toEqual({ ...effective, timestamp: expect.any(Number) });
			expect(candidate.context.messages.filter((message) => message.role === "system")).toHaveLength(1);
			expect(candidate.context.messages.map((message) => message.role)).toEqual(
				placement === "after-retained"
					? ["system", "user", "assistant", "compactionSummary"]
					: ["system", "compactionSummary", "user", "assistant"],
			);
			session.commitCompactionCandidate(candidate);
			expect(session.buildSessionContext()).toEqual(candidate.context);
		},
	);

	it("previews the exact immutable entry without mutating the session", () => {
		const session = SessionManager.inMemory();
		const firstKeptEntryId = session.appendMessage(userMsg("keep"));
		const leafId = session.appendMessage(assistantMsg("latest"));
		const entriesBefore = session.getEntries();

		const candidate = session.createCompactionCandidate("summary", firstKeptEntryId, 123, { version: 1 }, true);

		expect(candidate.entry).toMatchObject({
			type: "compaction",
			parentId: leafId,
			summary: "summary",
			firstKeptEntryId,
			tokensBefore: 123,
			details: { version: 1 },
			fromHook: true,
		});
		expect(Object.isFrozen(candidate)).toBe(true);
		expect(Object.isFrozen(candidate.entry)).toBe(true);
		expect(Object.isFrozen(candidate.context)).toBe(true);
		expect(Object.isFrozen(candidate.context.messages)).toBe(true);
		expect(session.getEntries()).toEqual(entriesBefore);
		expect(session.getLeafId()).toBe(leafId);
		expect(session.getEntry(candidate.entry.id)).toBeUndefined();
	});

	it("previews, commits, and reloads after-retained placement", () => {
		const tempDir = join(tmpdir(), `compaction-placement-${Date.now()}-${Math.random()}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const session = SessionManager.create(tempDir, tempDir);
		const firstKeptEntryId = session.appendMessage(userMsg("keep"));
		session.appendMessage(assistantMsg("latest"));
		const candidate = session.createCompactionCandidate(
			"summary",
			firstKeptEntryId,
			123,
			undefined,
			true,
			undefined,
			{ placement: "after-retained", label: "horizon" },
		);

		expect(candidate.entry.placement).toBe("after-retained");
		expect(candidate.entry.label).toBe("horizon");
		expect(candidate.context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"compactionSummary",
		]);
		expect(candidate.context.messages.at(-1)).toMatchObject({ label: "horizon" });
		session.commitCompactionCandidate(candidate);

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = SessionManager.open(sessionFile, tempDir);
		expect(reopened.buildSessionContext()).toEqual(candidate.context);
	});

	it("rejects after-retained placement at an assistant boundary", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("request"));
		const assistantId = session.appendMessage(assistantMsg("response"));

		expect(() =>
			session.createCompactionCandidate("summary", assistantId, 123, undefined, true, undefined, {
				placement: "after-retained",
			}),
		).toThrow(/user-like turn boundary/);
	});

	it("commits the exact entry whose context was previewed", () => {
		const session = SessionManager.inMemory();
		const firstKeptEntryId = session.appendMessage(userMsg("keep"));
		session.appendMessage(assistantMsg("latest"));
		const candidate = session.createCompactionCandidate("summary", firstKeptEntryId, 123);

		expect(session.commitCompactionCandidate(candidate)).toBe(candidate.entry.id);
		expect(session.getEntry(candidate.entry.id)).toBe(candidate.entry);
		expect(session.buildSessionContext()).toEqual(candidate.context);
	});

	it("rejects a candidate after the session frontier advances", () => {
		const session = SessionManager.inMemory();
		const firstKeptEntryId = session.appendMessage(userMsg("keep"));
		const candidate = session.createCompactionCandidate("summary", firstKeptEntryId, 123);
		const newLeafId = session.appendMessage(userMsg("new"));

		expect(() => session.commitCompactionCandidate(candidate)).toThrow(/frontier is no longer/);
		expect(session.getLeafId()).toBe(newLeafId);
		expect(session.getEntry(candidate.entry.id)).toBeUndefined();
	});

	it("rejects candidates from another session and reused ids", () => {
		const source = SessionManager.inMemory();
		const firstKeptEntryId = source.appendMessage(userMsg("keep"));
		const candidate = source.createCompactionCandidate("summary", firstKeptEntryId, 123);
		const other = SessionManager.inMemory();
		other.appendMessage(userMsg("other"));

		expect(() => other.commitCompactionCandidate(candidate)).toThrow(/different session/);

		source.commitCompactionCandidate(candidate);
		source.branch(firstKeptEntryId);
		expect(() => source.commitCompactionCandidate(candidate)).toThrow(/already in use/);
	});

	it("rejects cross-branch and superseded-history anchors", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage(userMsg("root"));
		const oldBranchId = session.appendMessage(userMsg("old branch"));
		session.branch(rootId);
		const currentId = session.appendMessage(userMsg("current branch"));

		expect(() => session.createCompactionCandidate("summary", oldBranchId, 123)).toThrow(
			/not in the effective context/,
		);

		session.appendCompaction("first summary", currentId, 100);
		session.appendMessage(userMsg("after compaction"));
		expect(() => session.createCompactionCandidate("second summary", rootId, 123)).toThrow(
			/not in the effective context/,
		);
	});

	it("rejects invisible, bare-tool-result, and compaction anchors", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage(userMsg("root"));
		const customId = session.appendCustomEntry("state", { value: 1 });

		expect(() => session.createCompactionCandidate("summary", customId, 123)).toThrow(
			/context-visible non-compaction entry/,
		);

		const toolResultId = session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 2,
		});
		expect(() => session.createCompactionCandidate("summary", toolResultId, 123)).toThrow(
			/stable context-visible non-compaction entry/,
		);

		const compactionId = session.appendCompaction("summary", rootId, 123);
		expect(() => session.createCompactionCandidate("summary 2", compactionId, 456)).toThrow(
			/context-visible non-compaction entry/,
		);
	});

	it("commits against the selected branch frontier", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage(userMsg("root"));
		session.appendMessage(userMsg("abandoned"));
		session.branch(rootId);
		const branchLeafId = session.appendMessage(userMsg("selected"));
		const candidate = session.createCompactionCandidate("branch summary", rootId, 123);

		session.commitCompactionCandidate(candidate);

		expect(candidate.entry.parentId).toBe(branchLeafId);
		expect(session.getBranch().map((entry) => entry.id)).toEqual([rootId, branchLeafId, candidate.entry.id]);
		expect(session.buildSessionContext()).toEqual(candidate.context);
	});

	it("reloads the same context that was previewed and committed", () => {
		const tempDir = join(tmpdir(), `compaction-candidate-${Date.now()}-${Math.random()}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const session = SessionManager.create(tempDir, tempDir);
		const firstKeptEntryId = session.appendMessage(userMsg("keep"));
		session.appendMessage(assistantMsg("latest"));
		const candidate = session.createCompactionCandidate("summary", firstKeptEntryId, 123);
		session.commitCompactionCandidate(candidate);

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = SessionManager.open(sessionFile, tempDir);

		expect(reopened.buildSessionContext()).toEqual(candidate.context);
		expect(reopened.getEntry(candidate.entry.id)).toEqual(candidate.entry);
	});

	it("does not mutate in-memory state when persistence rejects a commit", () => {
		const tempDir = join(tmpdir(), `compaction-candidate-failure-${Date.now()}-${Math.random()}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const session = SessionManager.create(tempDir, tempDir);
		const firstKeptEntryId = session.appendMessage(userMsg("keep"));
		const leafId = session.appendMessage(assistantMsg("latest"));
		const candidate = session.createCompactionCandidate("summary", firstKeptEntryId, 123);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		chmodSync(sessionFile, 0o400);

		expect(() => session.commitCompactionCandidate(candidate)).toThrow();
		expect(session.getLeafId()).toBe(leafId);
		expect(session.getEntry(candidate.entry.id)).toBeUndefined();
	});
});
