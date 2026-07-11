import { describe, expect, it, vi } from "vitest";
import { runAsyncAction } from "./async";

describe("runAsyncAction", () => {
	it("routes a synchronous callback throw to the error handler", async () => {
		const error = new Error("sync failure");
		const onError = vi.fn();

		runAsyncAction(() => {
			throw error;
		}, onError);
		await Promise.resolve();
		await Promise.resolve();

		expect(onError).toHaveBeenCalledWith(error);
	});

	it("routes a rejected callback promise to the error handler", async () => {
		const error = new Error("async failure");
		const onError = vi.fn();

		runAsyncAction(() => Promise.reject(error), onError);
		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
	});
});
