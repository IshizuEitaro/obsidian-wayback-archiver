import type { WaybackArchiverSettingTab } from "../SettingsTab";
import { SETTING_IDS } from "./definitions";

export const LEGACY_SETTING_IDS: readonly string[] = SETTING_IDS;

export function renderLegacySettings(
	tab: WaybackArchiverSettingTab,
	containerEl: HTMLElement,
): void {
	tab.renderLegacySettingsInto(containerEl);
}
