import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../core/settings";
import {
	getDeclarativeSettingValue,
	setDeclarativeSettingValue,
	validateDateFormat,
	validateIntegerRange,
	validateNonNegativeInteger,
} from "./bindings";

const createPluginData = () => ({
	activeSettings: {
		...DEFAULT_SETTINGS,
		dateFormat: "yyyy-MM-dd",
		ignorePatterns: ["archive\\.org", "internal"],
		ignoredDomains: [],
		defaultArchiveProviders: ["wayback", "archiveToday"],
	},
	saveSettings: vi.fn(async () => undefined),
});

describe("declarative settings bindings", () => {
	it("reads active-profile values without flattening saved data", () => {
		const plugin = createPluginData();
		expect(getDeclarativeSettingValue(plugin as never, "profile.dateFormat")).toBe(
			"yyyy-MM-dd",
		);
		expect(getDeclarativeSettingValue(plugin as never, "profile.archiveLinkMode")).toBe(
			"append",
		);
		expect(getDeclarativeSettingValue(plugin as never, "profile.ignorePatternsText")).toBe(
			"archive\\.org\ninternal",
		);
		expect(getDeclarativeSettingValue(plugin as never, "profile.provider.archiveToday")).toBe(
			true,
		);
	});

	it("writes profile, array, domain, and provider values through saveSettings", async () => {
		const plugin = createPluginData();
		expect(await setDeclarativeSettingValue(plugin as never, "profile.apiDelay", 2500)).toBe(
			"none",
		);
		await setDeclarativeSettingValue(
			plugin as never,
			"profile.ignorePatternsText",
			" one \n\n two ",
		);
		await setDeclarativeSettingValue(
			plugin as never,
			"profile.ignoredDomainsText",
			"Example.com, api.example.org\nnews.example.net",
		);
		await setDeclarativeSettingValue(plugin as never, "profile.provider.megalodon", true);
		await setDeclarativeSettingValue(plugin as never, "profile.archiveLinkMode", "replace");

		expect(plugin.activeSettings.apiDelay).toBe(2500);
		expect(plugin.activeSettings.archiveLinkMode).toBe("replace");
		expect(plugin.activeSettings.ignorePatterns).toEqual(["one", "two"]);
		expect(plugin.activeSettings.ignoredDomains).toEqual([
			"example.com",
			"api.example.org",
			"news.example.net",
		]);
		expect(plugin.activeSettings.defaultArchiveProviders).toContain("megalodon");
		expect(plugin.saveSettings).toHaveBeenCalledTimes(5);
	});

	it("requests a visibility refresh without clearing append-only values", async () => {
		const plugin = createPluginData();
		const dateFormat = plugin.activeSettings.dateFormat;
		const archiveLinkText = plugin.activeSettings.archiveLinkText;

		expect(
			await setDeclarativeSettingValue(plugin as never, "profile.archiveLinkMode", "replace"),
		).toBe("visibility");
		expect(plugin.activeSettings.dateFormat).toBe(dateFormat);
		expect(plugin.activeSettings.archiveLinkText).toBe(archiveLinkText);
	});

	it("validates number ranges and date formats", () => {
		expect(validateNonNegativeInteger(0)).toBeUndefined();
		expect(validateNonNegativeInteger(-1)).toBeTruthy();
		expect(validateIntegerRange(1, 10)(11)).toBeTruthy();
		expect(validateDateFormat("yyyy-MM-dd")).toBeUndefined();
		expect(validateDateFormat("unterminated '")).toBeTruthy();
	});
});
