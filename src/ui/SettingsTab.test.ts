import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	PluginSettingTab: class PluginSettingTab {
		containerEl = { empty: vi.fn(), createEl: vi.fn() };
		constructor(
			public app: unknown,
			public plugin: unknown,
		) {}
	},
	Setting: class Setting {},
	Notice: vi.fn(),
	ButtonComponent: class ButtonComponent {},
	Modal: class Modal {},
	SecretComponent: class SecretComponent {},
}));

import { WaybackArchiverSettingTab } from "./SettingsTab";
import { DEFAULT_SETTINGS } from "../core/settings";

const createSettingTab = () => {
	const plugin = {
		activeSettings: { ...DEFAULT_SETTINGS },
		data: {
			activeProfileId: "default",
			profiles: { default: { ...DEFAULT_SETTINGS } },
		},
		saveSettings: vi.fn(async () => undefined),
	};
	return {
		plugin,
		tab: new WaybackArchiverSettingTab({} as never, plugin as never),
	};
};

describe("declarative settings compatibility", () => {
	it("uses update when the 1.13 declarative host method exists", () => {
		const { tab } = createSettingTab();
		const update = vi.fn();
		Object.assign(tab, { update });

		tab.refreshSettingsUi(true);

		expect(update).toHaveBeenCalledOnce();
		expect(tab.containerEl.empty).not.toHaveBeenCalled();
	});

	it("falls back to display on pre-1.13 hosts", () => {
		const { tab } = createSettingTab();
		Object.assign(tab, { update: undefined });
		const display = vi.spyOn(tab, "display").mockImplementation(() => undefined);

		tab.refreshSettingsUi(true);

		expect(display).toHaveBeenCalledOnce();
	});

	it("routes declarative definitions and control values through the binding adapter", async () => {
		const { plugin, tab } = createSettingTab();

		expect(tab.getSettingDefinitions().length).toBeGreaterThan(0);
		expect(tab.getControlValue("profile.apiDelay")).toBe(DEFAULT_SETTINGS.apiDelay);
		await tab.setControlValue("profile.apiDelay", 2500);

		expect(plugin.activeSettings.apiDelay).toBe(2500);
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});
});
