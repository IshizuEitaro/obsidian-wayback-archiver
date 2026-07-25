import { beforeEach, describe, expect, it, vi } from "vitest";

const { secretComponents } = vi.hoisted(() => ({
	secretComponents: [] as Array<{
		value: string;
		onChangeCallback?: (value: string) => unknown;
	}>,
}));
vi.mock("obsidian", () => ({
	SecretComponent: class SecretComponent {
		value = "";
		onChangeCallback?: (value: string) => unknown;

		constructor() {
			secretComponents.push(this);
		}

		setValue(value: string) {
			this.value = value;
			return this;
		}

		onChange(callback: (value: string) => unknown) {
			this.onChangeCallback = callback;
			return this;
		}
	},
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
	beforeEach(() => {
		secretComponents.length = 0;
	});

	it("defines searchable pages and all simple setting controls", () => {
		const definitions = buildSettingDefinitions(createContext());
		const flat = flatten(definitions);
		const names = flat.map((item) => item.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"Date format",
				"Archive link mode",
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
		const mode = flat.find((item) => item.name === "Archive link mode");
		expect(mode?.control).toEqual({
			type: "dropdown",
			key: "profile.archiveLinkMode",
			options: { append: "Append", replace: "Replace" },
		});
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

	it.each([
		{ archiveLinkMode: "append", expected: true },
		{ archiveLinkMode: "replace", expected: false },
	] as const)(
		"shows append-only formatting controls in $archiveLinkMode mode: $expected",
		({ archiveLinkMode, expected }) => {
			const flat = flatten(buildSettingDefinitions(createContext({ archiveLinkMode })));
			for (const name of ["Date format", "Archive link text"]) {
				const setting = flat.find((item) => item.name === name);
				expect(typeof setting?.visible).toBe("function");
				expect((setting!.visible as () => boolean)()).toBe(expected);
			}
		},
	);

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

	it.each([
		{
			settingName: "Archive.org SPN access key",
			field: "spnAccessKeySecretName",
			savedId: "custom-access-key",
		},
		{
			settingName: "Archive.org SPN secret key",
			field: "spnSecretKeySecretName",
			savedId: "custom-secret-key",
		},
	] as const)(
		"binds $settingName to the selected SecretStorage ID",
		async ({ settingName, field, savedId }) => {
			const context = createContext();
			const plugin = context.plugin as unknown as {
				app: {
					secretStorage: {
						getSecret: ReturnType<typeof vi.fn>;
						setSecret: ReturnType<typeof vi.fn>;
					};
				};
				data: Record<string, unknown>;
				saveSettings: ReturnType<typeof vi.fn>;
			};
			const setSecret = vi.fn();
			Object.assign(plugin, {
				app: {
					secretStorage: {
						getSecret: vi.fn(() => "credential-value"),
						setSecret,
					},
				},
			});
			Object.assign(plugin.data, {
				spnCredentialStorageMode: "secretStorage",
				[field]: savedId,
			});
			const definition = flatten(buildSettingDefinitions(context)).find(
				(item) => item.name === settingName,
			);

			(definition?.render as ((setting: { controlEl: object }) => void) | undefined)?.({
				controlEl: {},
			});
			const component = secretComponents[0];
			await component?.onChangeCallback?.("renamed-key");

			expect(component?.value).toBe(savedId);
			expect(plugin.data[field]).toBe("renamed-key");
			expect(setSecret).not.toHaveBeenCalled();
			expect(plugin.saveSettings).toHaveBeenCalledOnce();
		},
	);
});
