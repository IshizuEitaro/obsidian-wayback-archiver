import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeElement {
	textContent = "";
	children: FakeElement[] = [];
	listeners = new Map<string, () => void>();

	empty(): void {
		this.textContent = "";
		this.children = [];
	}

	createEl(_tag: string, options: { text?: string } = {}): FakeElement {
		const child = new FakeElement();
		child.textContent = options.text ?? "";
		this.children.push(child);
		return child;
	}

	createDiv(options: { text?: string } = {}): FakeElement {
		return this.createEl("div", options);
	}

	addEventListener(event: string, listener: () => void): void {
		this.listeners.set(event, listener);
	}

	findByText(text: string): FakeElement | undefined {
		if (this.textContent === text) return this;
		return this.children.map((child) => child.findByText(text)).find(Boolean);
	}

	get allText(): string {
		return [this.textContent, ...this.children.map((child) => child.allText)].join(" ");
	}
}

vi.mock("obsidian", () => ({
	Modal: class Modal {
		contentEl = new FakeElement();
		constructor(_app: unknown) {}
		open() {
			(this as unknown as { onOpen(): void }).onOpen();
		}
		close() {
			(this as unknown as { onClose(): void }).onClose();
		}
	},
}));

import { BatchRunController } from "../core/batchRun";
import { ArchiveProgressModal } from "./ArchiveProgressModal";

describe("ArchiveProgressModal", () => {
	beforeEach(() => vi.clearAllMocks());

	it("shows preflight counts and updates each URL row", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const modal = new ArchiveProgressModal({} as never, {
			summary: {
				noteCount: 1,
				linkCount: 1,
				uniqueUrlCount: 1,
				items: [],
			},
			run,
			onStart: vi.fn(),
		});
		modal.open();
		const content = modal.contentEl as unknown as FakeElement;
		expect(content.allText).toContain("1 note");
		expect(content.allText).toContain("1 link");
		expect(content.allText).toContain("1 unique URL");

		modal.showProgress();
		run.updateItem("a", "success", "Captured");
		expect(content.allText).toContain("Captured");
	});

	it("cancels the run when the confirmation closes before start", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const cancel = vi.spyOn(run, "cancel");
		const modal = new ArchiveProgressModal({} as never, {
			summary: {
				noteCount: 1,
				linkCount: 1,
				uniqueUrlCount: 1,
				items: [],
			},
			run,
			onStart: vi.fn(),
		});

		modal.open();
		modal.close();

		expect(cancel).toHaveBeenCalledOnce();
	});

	it("keeps a started run active when only the progress modal closes", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const cancel = vi.spyOn(run, "cancel");
		const modal = new ArchiveProgressModal({} as never, {
			summary: {
				noteCount: 1,
				linkCount: 1,
				uniqueUrlCount: 1,
				items: [],
			},
			run,
			onStart: vi.fn(async () => undefined),
		});

		modal.open();
		const content = modal.contentEl as unknown as FakeElement;
		content.findByText("Start")?.listeners.get("click")?.();
		modal.close();

		expect(cancel).not.toHaveBeenCalled();
	});
});
