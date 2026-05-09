import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeReadFile, safeWriteFile, readFileOrThrow, writeFileOrThrow } from "./FileUtils";

const { noticeMock } = vi.hoisted(() => ({
	noticeMock: vi.fn(),
}));

vi.mock("obsidian", () => ({
	Notice: noticeMock,
}));

describe("FileUtils", () => {
	beforeEach(() => {
		noticeMock.mockReset();
	});

	it("safeReadFile returns null when vault.read fails", async () => {
		const vault = {
			read: vi.fn(async () => {
				throw new Error("read failed");
			}),
		};
		const file = { path: "notes/test.md" };

		await expect(safeReadFile(vault as never, file as never)).resolves.toBeNull();
		expect(noticeMock).toHaveBeenCalledWith("Error reading file: notes/test.md");
	});

	it("safeReadFile returns file content when vault.read succeeds", async () => {
		const vault = {
			read: vi.fn(async () => "hello"),
		};
		const file = { path: "notes/test.md" };

		await expect(safeReadFile(vault as never, file as never)).resolves.toBe("hello");
		expect(vault.read).toHaveBeenCalledWith(file);
		expect(noticeMock).not.toHaveBeenCalled();
	});

	it("readFileOrThrow propagates vault.read failures", async () => {
		const error = new Error("read failed");
		const vault = {
			read: vi.fn(async () => {
				throw error;
			}),
		};
		const file = { path: "notes/test.md" };

		await expect(readFileOrThrow(vault as never, file as never)).rejects.toBe(error);
	});

	it("writeFileOrThrow propagates vault.modify failures", async () => {
		const error = new Error("write failed");
		const vault = {
			modify: vi.fn(async () => {
				throw error;
			}),
		};
		const file = { path: "notes/test.md" };

		await expect(writeFileOrThrow(vault as never, file as never, "content")).rejects.toBe(
			error,
		);
	});

	it("safeWriteFile shows a notice and does not throw when vault.modify fails", async () => {
		const vault = {
			modify: vi.fn(async () => {
				throw new Error("write failed");
			}),
		};
		const file = { path: "notes/test.md" };

		await expect(safeWriteFile(vault as never, file as never, "content")).resolves.toBeUndefined();

		expect(noticeMock).toHaveBeenCalledWith("Error saving file: notes/test.md");
	});
});
