import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchCanceledError, BatchRunController, waitForBatchDelay } from "./batchRun";

describe("BatchRunController", () => {
	afterEach(() => vi.useRealTimers());

	it("keeps completed items and cancels remaining work", async () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
			{ id: "b", url: "https://b.example", filePath: "b.md" },
		]);
		run.updateItem("a", "success", "Captured");
		run.cancel();

		expect(run.snapshot().items[0].status).toBe("success");
		expect(run.snapshot().items[1].status).toBe("canceled");
		expect(run.snapshot().canceled).toBe(true);
		await expect(waitForBatchDelay(10_000, run)).rejects.toBeInstanceOf(BatchCanceledError);
	});

	it("notifies subscribers with immutable snapshots", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const snapshots = vi.fn();
		const unsubscribe = run.subscribe(snapshots);
		run.updateItem("a", "capturing", "Capturing");
		unsubscribe();
		run.updateItem("a", "success", "Captured");

		expect(snapshots).toHaveBeenCalledTimes(2);
		expect(snapshots.mock.calls[0][0].items[0].status).toBe("pending");
	});

	it("interrupts an active delay when canceled", async () => {
		vi.useFakeTimers();
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const waiting = waitForBatchDelay(10_000, run);
		run.cancel();

		await expect(waiting).rejects.toBeInstanceOf(BatchCanceledError);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("appends pending items and reopens a finished run", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		run.updateItem("a", "success", "Captured");
		run.finish();

		const added = run.addItems([
			{ id: "b", url: "https://b.example", filePath: "b.md" },
		]);

		expect(added).toBe(true);
		expect(run.snapshot()).toMatchObject({ total: 2, completed: 1, finished: false });
		expect(run.snapshot().items[1]).toMatchObject({ id: "b", status: "pending" });
	});

	it("rejects appended items after cancellation", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		run.cancel();

		const added = run.addItems([
			{ id: "b", url: "https://b.example", filePath: "b.md" },
		]);

		expect(added).toBe(false);
		expect(run.snapshot().total).toBe(1);
	});

	it("rejects duplicate item IDs", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);

		expect(() =>
			run.addItems([{ id: "a", url: "https://other.example", filePath: "other.md" }]),
		).toThrow("Duplicate archive batch item: a");
		expect(run.snapshot().total).toBe(1);
	});
});
