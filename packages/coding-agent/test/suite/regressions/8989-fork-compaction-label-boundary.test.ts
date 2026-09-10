import { describe, expect, it } from "vitest";
import { type CompactionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { userMsg } from "../../utilities.ts";

describe("regression #8989", () => {
	it("preserves legacy compaction context when a fork removes the boundary label", () => {
		const source = SessionManager.inMemory();
		const oldId = source.appendMessage(userMsg("old"));
		const labelId = source.appendLabelChange(oldId, "checkpoint");
		const keptId = source.appendMessage(userMsg("kept"));
		const compactionId = source.appendCompaction("summary", keptId, 100);
		const leafId = source.appendMessage(userMsg("after"));

		// Older/upstream sessions could persist a context-invisible label as the boundary.
		const legacyEntries = source
			.getEntries()
			.map((entry) =>
				entry.type === "compaction" && entry.id === compactionId ? { ...entry, firstKeptEntryId: labelId } : entry,
			);
		const session = SessionManager.inMemory(process.cwd(), undefined, legacyEntries);

		session.createBranchedSession(leafId);

		expect((session.getEntry(compactionId) as CompactionEntry).firstKeptEntryId).toBe(keptId);
		expect(session.buildSessionContext().messages).toMatchObject([
			{ role: "compactionSummary", summary: "summary" },
			{ role: "user", content: "kept" },
			{ role: "user", content: "after" },
		]);
	});
});
