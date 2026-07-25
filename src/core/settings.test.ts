import { describe, it, expect, vi } from "vitest";
import {
	appendFailedArchiveEntry,
	CredentialStorageData,
	DEFAULT_SETTINGS,
	FAILED_ARCHIVE_DUPLICATE_WINDOW_MS,
	FailedArchiveEntry,
	getSpnCredentials,
	migrateSecretStorage,
	normalizeProfileSettings,
	purgePlaintextCredentials,
	SPN_ACCESS_KEY_SECRET_ID,
	SPN_SECRET_KEY_SECRET_ID,
} from "./settings";

describe("normalizeProfileSettings", () => {
	it("adds safe defaults without changing legacy ignore patterns or unknown fields", () => {
		const legacy = {
			...DEFAULT_SETTINGS,
			ignorePatterns: ["youtube\\.com", "internal-wiki"],
			futureSetting: "preserve-me",
		} as Partial<typeof DEFAULT_SETTINGS> & { futureSetting: string };
		delete legacy.ignoredDomains;
		delete legacy.archiveBareUrls;

		const migrated = normalizeProfileSettings(legacy);

		expect(migrated.ignorePatterns).toEqual(["youtube\\.com", "internal-wiki"]);
		expect(migrated.ignoredDomains).toEqual([]);
		expect(migrated.archiveBareUrls).toBe(true);
		expect(migrated.archiveLinkMode).toBe("append");
		expect(migrated.fallbackToLatestSnapshot).toBe(true);
		expect(migrated.maxFreshCaptureWaitSeconds).toBe(120);
		expect(migrated.throttleRetryDelayMs).toBe(30_000);
		expect(migrated.maxThrottleRetries).toBe(3);
		expect((migrated as typeof migrated & { futureSetting: string }).futureSetting).toBe(
			"preserve-me",
		);
	});

	it("repairs unsupported archive link modes to append", () => {
		const result = normalizeProfileSettings({
			...DEFAULT_SETTINGS,
			archiveLinkMode: "unsupported" as never,
		});

		expect(result.archiveLinkMode).toBe("append");
	});

	it("repairs stored values that declarative validation would reject", () => {
		const result = normalizeProfileSettings({
			...DEFAULT_SETTINGS,
			apiDelay: -1,
			maxRetries: 0,
			archiveFreshnessDays: -5,
			archiveTodayPendingPollBatchSize: 99,
			manualSaveBatchSize: 0,
			maxFreshCaptureWaitSeconds: 0,
			throttleRetryDelayMs: -1,
			maxThrottleRetries: -1,
		});
		expect(result.apiDelay).toBe(DEFAULT_SETTINGS.apiDelay);
		expect(result.maxRetries).toBe(1);
		expect(result.archiveFreshnessDays).toBe(0);
		expect(result.archiveTodayPendingPollBatchSize).toBe(10);
		expect(result.manualSaveBatchSize).toBe(1);
		expect(result.maxFreshCaptureWaitSeconds).toBe(1);
		expect(result.throttleRetryDelayMs).toBe(0);
		expect(result.maxThrottleRetries).toBe(0);
	});
});

describe("appendFailedArchiveEntry", () => {
	it("adds a failed archive entry to an empty list", () => {
		const entry: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "Some error",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const result = appendFailedArchiveEntry([], entry);
		expect(result).toEqual([entry]);
	});

	it("appends a non-duplicate entry", () => {
		const entry1: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "Some error",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const entry2: FailedArchiveEntry = {
			url: "https://example.org",
			filePath: "notes/test.md",
			timestamp: 2000,
			error: "Another error",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const result = appendFailedArchiveEntry([entry1], entry2);
		expect(result).toEqual([entry1, entry2]);
	});

	it("coalesces a duplicate entry within the duplicate window", () => {
		const entry1: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "First error",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const entry2: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000 + FAILED_ARCHIVE_DUPLICATE_WINDOW_MS - 10,
			error: "Second error (coalesced)",
			retryCount: 1,
			stage: "wayback-timeout",
		};
		const result = appendFailedArchiveEntry([entry1], entry2);
		expect(result.length).toBe(1);
		expect(result[0]).toEqual({
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000 + FAILED_ARCHIVE_DUPLICATE_WINDOW_MS - 10,
			error: "Second error (coalesced)",
			retryCount: 1,
			stage: "wayback-timeout",
		});
	});

	it("does not coalesce duplicates beyond the duplicate window", () => {
		const entry1: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "First error",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const entry2: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000 + FAILED_ARCHIVE_DUPLICATE_WINDOW_MS + 10,
			error: "Second error",
			retryCount: 1,
			stage: "wayback-timeout",
		};
		const result = appendFailedArchiveEntry([entry1], entry2);
		expect(result).toEqual([entry1, entry2]);
	});

	it("keeps separate entries when targetUrl differs", () => {
		const entry1: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://target1.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "Error 1",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const entry2: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://target2.com",
			filePath: "notes/test.md",
			timestamp: 1500,
			error: "Error 2",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const result = appendFailedArchiveEntry([entry1], entry2);
		expect(result).toEqual([entry1, entry2]);
	});

	it("coalesces duplicate failures with latest failure fields while preserving manual metadata", () => {
		const existing: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "first error",
			retryCount: 1,
			stage: "fallback-not-found",
			manualProviderIds: ["archiveToday"],
			manualOpenedAt: 1500,
			manualOpenCount: 2,
		};

		const entry: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 2000,
			error: "latest error",
			retryCount: 0,
			stage: "fallback-not-found",
			manualProviderIds: ["megalodon"],
		};

		expect(appendFailedArchiveEntry([existing], entry, 5000)).toEqual([
			{
				url: "https://example.com",
				targetUrl: "https://example.com",
				filePath: "notes/test.md",
				timestamp: 2000,
				error: "latest error",
				retryCount: 0,
				stage: "fallback-not-found",
				manualProviderIds: ["archiveToday", "megalodon"],
				manualOpenedAt: 1500,
				manualOpenCount: 2,
			},
		]);
	});

	it("does not coalesce duplicate failures outside the duplicate window", () => {
		const existing: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "first error",
			retryCount: 0,
			stage: "fallback-not-found",
		};

		const entry: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 7000,
			error: "later error",
			retryCount: 0,
			stage: "fallback-not-found",
		};

		expect(appendFailedArchiveEntry([existing], entry, 5000)).toHaveLength(2);
	});
});

describe("getSpnCredentials", () => {
	it("retrieves credentials from secretStorage if available and secret names are set", () => {
		const mockApp = {
			secretStorage: {
				getSecret: (name: string) => {
					if (name === "acc_secret") return "secret_access_key";
					if (name === "sec_secret") return "secret_secret_key";
					return null;
				},
			},
		};

		const data: CredentialStorageData = {
			spnAccessKeySecretName: "acc_secret",
			spnSecretKeySecretName: "sec_secret",
			spnAccessKey: "legacy_access",
			spnSecretKey: "legacy_secret",
		};

		const creds = getSpnCredentials(mockApp, data);
		expect(creds.spnAccessKey).toBe("secret_access_key");
		expect(creds.spnSecretKey).toBe("secret_secret_key");
	});

	it("falls back to legacy fields if secretStorage is not available or secretName returns null", () => {
		const mockApp = {
			secretStorage: {
				getSecret: () => null,
			},
		};

		const data: CredentialStorageData = {
			spnAccessKeySecretName: "acc_secret",
			spnAccessKey: "legacy_access",
			spnSecretKey: "legacy_secret",
		};

		const creds = getSpnCredentials(mockApp, data);
		expect(creds.spnAccessKey).toBe("legacy_access");
		expect(creds.spnSecretKey).toBe("legacy_secret");
	});

	it("falls back to legacy fields if app.secretStorage is undefined", () => {
		const mockApp = {};

		const data: CredentialStorageData = {
			spnAccessKey: "legacy_access",
			spnSecretKey: "legacy_secret",
		};

		const creds = getSpnCredentials(mockApp, data);
		expect(creds.spnAccessKey).toBe("legacy_access");
		expect(creds.spnSecretKey).toBe("legacy_secret");
	});
});

describe("migrateSecretStorage & purgePlaintextCredentials", () => {
	it("uses Obsidian-compatible IDs when importing legacy credentials", async () => {
		const secretIds: string[] = [];
		const mockApp = {
			secretStorage: {
				setSecret: (name: string) => {
					if (!/^[a-z0-9-]{1,64}$/u.test(name)) {
						throw new Error(
							"Secret ID is invalid. Use only lowercase letters, numbers and dashes.",
						);
					}
					secretIds.push(name);
				},
			},
		};
		const data: CredentialStorageData = {
			spnAccessKey: "my_access_key",
			spnSecretKey: "my_secret_key",
		};

		await migrateSecretStorage(mockApp, data);

		expect(secretIds).toEqual([
			"wayback-archiver-spn-access-key",
			"wayback-archiver-spn-secret-key",
		]);
	});

	it("auto-imports legacy keys into secretStorage without deleting legacy keys", async () => {
		const savedSecrets: Record<string, string> = {};
		const mockApp = {
			secretStorage: {
				setSecret: (name: string, value: string) => {
					savedSecrets[name] = value;
				},
			},
		};

		const data: CredentialStorageData = {
			spnAccessKey: "my_access_key",
			spnSecretKey: "my_secret_key",
		};

		const migrated = await migrateSecretStorage(mockApp, data);
		expect(migrated).toBe(true);
		expect(data.spnAccessKeySecretName).toBe(SPN_ACCESS_KEY_SECRET_ID);
		expect(data.spnSecretKeySecretName).toBe(SPN_SECRET_KEY_SECRET_ID);
		expect(savedSecrets[SPN_ACCESS_KEY_SECRET_ID]).toBe("my_access_key");
		expect(savedSecrets[SPN_SECRET_KEY_SECRET_ID]).toBe("my_secret_key");
		// Crucial requirement: keep legacy keys for synced devices until user purges
		expect(data.spnAccessKey).toBe("my_access_key");
		expect(data.spnSecretKey).toBe("my_secret_key");
	});

	it("does not recreate default secrets when existing references were renamed", async () => {
		const setSecret = vi.fn();
		const mockApp = {
			secretStorage: {
				setSecret,
			},
		};
		const data: CredentialStorageData = {
			spnCredentialStorageMode: "secretStorage",
			spnAccessKeySecretName: "renamed-access-key",
			spnSecretKeySecretName: "renamed-secret-key",
			spnAccessKey: "legacy_access",
			spnSecretKey: "legacy_secret",
		};

		const migrated = await migrateSecretStorage(mockApp, data);

		expect(migrated).toBe(false);
		expect(setSecret).not.toHaveBeenCalled();
		expect(data.spnAccessKeySecretName).toBe("renamed-access-key");
		expect(data.spnSecretKeySecretName).toBe("renamed-secret-key");
		expect(data.spnAccessKey).toBe("legacy_access");
		expect(data.spnSecretKey).toBe("legacy_secret");
	});

	it("purges plaintext credentials from data", () => {
		const data: CredentialStorageData = {
			spnAccessKeySecretName: "WaybackArchiver_spnAccessKey",
			spnAccessKey: "my_access_key",
			spnSecretKey: "my_secret_key",
		};

		const purged = purgePlaintextCredentials(data);
		expect(purged).toBe(true);
		expect(data.spnAccessKey).toBeUndefined();
		expect(data.spnSecretKey).toBeUndefined();
	});

	it("respects spnCredentialStorageMode = 'plaintext' and ignores SecretStorage", () => {
		const mockApp = {
			secretStorage: {
				getSecret: () => "secretStorage_value",
			},
		};

		const data: CredentialStorageData = {
			spnCredentialStorageMode: "plaintext",
			spnAccessKeySecretName: "WaybackArchiver_spnAccessKey",
			spnSecretKeySecretName: "WaybackArchiver_spnSecretKey",
			spnAccessKey: "plaintext_access",
			spnSecretKey: "plaintext_secret",
		};

		const creds = getSpnCredentials(mockApp, data);
		expect(creds.spnAccessKey).toBe("plaintext_access");
		expect(creds.spnSecretKey).toBe("plaintext_secret");
	});

	it("sets default spnCredentialStorageMode to secretStorage if app.secretStorage exists during migration", async () => {
		const mockApp = {
			secretStorage: {
				setSecret: () => {},
			},
		};

		const data: CredentialStorageData = {};
		await migrateSecretStorage(mockApp, data);
		expect(data.spnCredentialStorageMode).toBe("secretStorage");
	});

	it("sets default spnCredentialStorageMode to plaintext if app.secretStorage does not exist during migration", async () => {
		const mockApp = {};
		const data: CredentialStorageData = {};
		await migrateSecretStorage(mockApp, data);
		expect(data.spnCredentialStorageMode).toBe("plaintext");
	});
});
