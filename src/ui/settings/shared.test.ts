import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type WaybackArchiverData } from "../../core/settings";
import {
	deleteSubstitutionRule,
	reorderSubstitutionRule,
	switchCredentialStorageMode,
} from "./shared";

const createPlugin = () => {
	const secrets = new Map<string, string>();
	const data: WaybackArchiverData = {
		activeProfileId: "default",
		profiles: { default: { ...DEFAULT_SETTINGS } },
		spnCredentialStorageMode: "plaintext",
		spnAccessKey: "access",
		spnSecretKey: "secret",
	};
	return {
		app: {
			secretStorage: {
				setSecret: vi.fn((name: string, value: string) => secrets.set(name, value)),
				getSecret: vi.fn((name: string) => secrets.get(name) ?? ""),
			},
		},
		data,
		activeSettings: {
			...DEFAULT_SETTINGS,
			substitutionRules: [
				{ find: "a", replace: "b", regex: false },
				{ find: "c", replace: "d", regex: true },
			],
		},
		saveSettings: vi.fn(async () => undefined),
	};
};

describe("shared settings mutations", () => {
	it("copies credentials without deleting plaintext when switching modes", async () => {
		const plugin = createPlugin();

		await switchCredentialStorageMode(plugin as never, "secretStorage");

		expect(plugin.data.spnCredentialStorageMode).toBe("secretStorage");
		expect(plugin.data.spnAccessKeySecretName).toBe("WaybackArchiver_spnAccessKey");
		expect(plugin.data.spnSecretKeySecretName).toBe("WaybackArchiver_spnSecretKey");
		expect(plugin.data.spnAccessKey).toBe("access");
		expect(plugin.data.spnSecretKey).toBe("secret");
	});

	it("deletes and reorders substitution rules using callback indices", async () => {
		const plugin = createPlugin();

		await reorderSubstitutionRule(plugin as never, 1, 0);
		await deleteSubstitutionRule(plugin as never, 1);

		expect(plugin.activeSettings.substitutionRules).toEqual([
			{ find: "c", replace: "d", regex: true },
		]);
	});
});
