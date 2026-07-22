import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	SecretComponent: class SecretComponent {},
}));
import type { SettingDefinitionItem } from "obsidian";
import { DEFAULT_SETTINGS } from "../../core/settings";
import { buildSettingDefinitions, DECLARATIVE_SETTING_IDS } from "./definitions";
import { LEGACY_SETTING_IDS } from "./legacyRenderer";

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
		expect(delay).toBeDefined();
		expect(typeof delay?.visible).toBe("function");
		expect((delay!.visible as () => boolean)()).toBe(false);
	});

	it("defines credential, profile, and substitution-rule controls", () => {
		const definitions = buildSettingDefinitions(createContext());
		const flat = flatten(definitions);
		expect(flat.map((item) => item.heading)).toEqual(
			expect.arrayContaining(["Archive.org API keys", "Profiles", "URL substitution rules"]),
		);
		const substitutions = flat.find((item) => item.heading === "URL substitution rules");
		expect(substitutions?.type).toBe("list");
		expect(substitutions?.addItem).toBeDefined();
	});

	it("keeps every user-facing setting available in both implementations", () => {
		expect(new Set(DECLARATIVE_SETTING_IDS)).toEqual(new Set(LEGACY_SETTING_IDS));
		expect(new Set(DECLARATIVE_SETTING_IDS).size).toBe(DECLARATIVE_SETTING_IDS.length);
	});
});
