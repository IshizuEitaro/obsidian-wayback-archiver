import type WaybackArchiverPlugin from "../../main";
import {
	purgePlaintextCredentials,
	SPN_ACCESS_KEY_SECRET_ID,
	SPN_SECRET_KEY_SECRET_ID,
	WaybackArchiverSettings,
} from "../../core/settings";

export type SubstitutionRule = WaybackArchiverSettings["substitutionRules"][number];

export async function switchCredentialStorageMode(
	plugin: WaybackArchiverPlugin,
	mode: "secretStorage" | "plaintext",
): Promise<void> {
	const storage = plugin.app.secretStorage;
	if (mode === "secretStorage") {
		if (plugin.data.spnAccessKey) {
			const name = plugin.data.spnAccessKeySecretName ?? SPN_ACCESS_KEY_SECRET_ID;
			storage.setSecret(name, plugin.data.spnAccessKey);
			plugin.data.spnAccessKeySecretName = name;
		}
		if (plugin.data.spnSecretKey) {
			const name = plugin.data.spnSecretKeySecretName ?? SPN_SECRET_KEY_SECRET_ID;
			storage.setSecret(name, plugin.data.spnSecretKey);
			plugin.data.spnSecretKeySecretName = name;
		}
	} else {
		if (!plugin.data.spnAccessKey && plugin.data.spnAccessKeySecretName) {
			plugin.data.spnAccessKey = storage.getSecret(plugin.data.spnAccessKeySecretName) ?? "";
		}
		if (!plugin.data.spnSecretKey && plugin.data.spnSecretKeySecretName) {
			plugin.data.spnSecretKey = storage.getSecret(plugin.data.spnSecretKeySecretName) ?? "";
		}
	}
	plugin.data.spnCredentialStorageMode = mode;
	await plugin.saveSettings();
}

export async function purgeStoredPlaintextCredentials(
	plugin: WaybackArchiverPlugin,
): Promise<void> {
	purgePlaintextCredentials(plugin.data);
	await plugin.saveSettings();
}

export async function addSubstitutionRule(plugin: WaybackArchiverPlugin): Promise<void> {
	plugin.activeSettings.substitutionRules.push({ find: "", replace: "", regex: false });
	await plugin.saveSettings();
}

export async function deleteSubstitutionRule(
	plugin: WaybackArchiverPlugin,
	index: number,
): Promise<void> {
	plugin.activeSettings.substitutionRules.splice(index, 1);
	await plugin.saveSettings();
}

export async function reorderSubstitutionRule(
	plugin: WaybackArchiverPlugin,
	oldIndex: number,
	newIndex: number,
): Promise<void> {
	const [rule] = plugin.activeSettings.substitutionRules.splice(oldIndex, 1);
	if (!rule) return;
	plugin.activeSettings.substitutionRules.splice(newIndex, 0, rule);
	await plugin.saveSettings();
}

export async function updateSubstitutionRule(
	plugin: WaybackArchiverPlugin,
	rule: SubstitutionRule,
	patch: Partial<SubstitutionRule>,
): Promise<void> {
	if (!plugin.activeSettings.substitutionRules.includes(rule)) return;
	Object.assign(rule, patch);
	await plugin.saveSettings();
}
