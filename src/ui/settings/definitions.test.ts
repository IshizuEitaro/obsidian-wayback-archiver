import { describe, expect, it, vi } from "vitest";
import type { SettingDefinitionItem } from "obsidian";
import { DEFAULT_SETTINGS } from "../../core/settings";
import { buildSettingDefinitions } from "./definitions";

const createContext = (overrides = {}) => ({
	plugin: {
		activeSettings: { ...DEFAULT_SETTINGS, ...overrides },
		data: {
			activeProfileId: "default",
			profiles: { default: { ...DEFAULT_SETTINGS, ...overrides } },
		},
		saveSettings: vi.fn(),
	} as never,
	refresh: vi.fn(),
	createProfile: vi.fn(),
	renameProfile: vi.fn(),
	deleteProfile: vi.fn(),
});

const flatten = (items: SettingDefinitionItem[]): Array<Record<string, unknown>> => {
	const result: Array<Record<string, unknown>> = [];
	for (const item of items) {
		result.push(item as unknown as Record<string, unknown>);
		const children = (item as { items?: SettingDefinitionItem[] }).items;
		if (children) result.push(...flatten(children));
	}
	return result;
};

describe("declarative setting definitions", () => {
	it("defines searchable pages and all simple setting controls", () => {
		const definitions = buildSettingDefinitions(createContext());
		const flat = flatten(definitions);
		const names = flat.map((item) => item.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"Date format",
				"Archive link text",
				"Ignored domains",
				"Archive bare URLs",
				"API request delay",
				"Archive freshness",
				"Fall back to latest existing snapshot",
				"Capture screenshot",
			]),
		);
		const apiDelay = flat.find((item) => item.name === "API request delay");
		expect(apiDelay?.aliases).toContain("request interval");
	});

	it("shows archive.today queue controls only when auto-submit is enabled", () => {
		const definitions = buildSettingDefinitions(
			createContext({ archiveTodayExperimentalSubmit: false }),
		);
		const delay = flatten(definitions).find(
			(item) => item.name === "archive.today submit delay",
		);
		expect(typeof delay?.visible).toBe("function");
		expect((delay?.visible as () => boolean)()).toBe(false);
	});
});
