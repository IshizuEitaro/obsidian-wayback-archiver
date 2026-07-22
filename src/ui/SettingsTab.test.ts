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

const createSettingTab = () =>
	new WaybackArchiverSettingTab({} as never, {
		activeSettings: {},
		data: {},
		saveSettings: vi.fn(),
	} as never);

describe("declarative settings compatibility", () => {
	it("uses update when the 1.13 declarative host method exists", () => {
		const tab = createSettingTab();
		const update = vi.fn();
		Object.assign(tab, { update });

		tab.refreshSettingsUi(true);

		expect(update).toHaveBeenCalledOnce();
		expect(tab.containerEl.empty).not.toHaveBeenCalled();
	});

	it("falls back to display on pre-1.13 hosts", () => {
		const tab = createSettingTab();
		Object.assign(tab, { update: undefined });
		const display = vi.spyOn(tab, "display").mockImplementation(() => undefined);

		tab.refreshSettingsUi(true);

		expect(display).toHaveBeenCalledOnce();
	});
});
