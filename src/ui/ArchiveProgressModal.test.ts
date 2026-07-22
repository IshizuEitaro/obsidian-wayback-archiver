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
});
