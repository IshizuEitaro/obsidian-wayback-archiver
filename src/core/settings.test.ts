import { describe, it, expect } from "vitest";
import {
	appendFailedArchiveEntry,
	FAILED_ARCHIVE_DUPLICATE_WINDOW_MS,
	FailedArchiveEntry,
	getSpnCredentials,
	migrateSecretStorage,
	purgePlaintextCredentials,
} from "./settings";

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
		} as any;

		const data: any = {
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
		} as any;

		const data: any = {
			spnAccessKeySecretName: "acc_secret",
			spnAccessKey: "legacy_access",
			spnSecretKey: "legacy_secret",
		};

		const creds = getSpnCredentials(mockApp, data);
		expect(creds.spnAccessKey).toBe("legacy_access");
		expect(creds.spnSecretKey).toBe("legacy_secret");
	});

	it("falls back to legacy fields if app.secretStorage is undefined", () => {
		const mockApp = {} as any;

		const data: any = {
			spnAccessKey: "legacy_access",
			spnSecretKey: "legacy_secret",
		};

		const creds = getSpnCredentials(mockApp, data);
		expect(creds.spnAccessKey).toBe("legacy_access");
		expect(creds.spnSecretKey).toBe("legacy_secret");
	});
});

describe("migrateSecretStorage & purgePlaintextCredentials", () => {
	it("auto-imports legacy keys into secretStorage without deleting legacy keys", async () => {
		const savedSecrets: Record<string, string> = {};
		const mockApp = {
			secretStorage: {
				setSecret: (name: string, value: string) => {
					savedSecrets[name] = value;
				},
			},
		} as any;

		const data: any = {
			spnAccessKey: "my_access_key",
			spnSecretKey: "my_secret_key",
		};

		const migrated = await migrateSecretStorage(mockApp, data);
		expect(migrated).toBe(true);
		expect(data.spnAccessKeySecretName).toBe("WaybackArchiver_spnAccessKey");
		expect(data.spnSecretKeySecretName).toBe("WaybackArchiver_spnSecretKey");
		expect(savedSecrets["WaybackArchiver_spnAccessKey"]).toBe("my_access_key");
		expect(savedSecrets["WaybackArchiver_spnSecretKey"]).toBe("my_secret_key");
		// Crucial requirement: keep legacy keys for synced devices until user purges
		expect(data.spnAccessKey).toBe("my_access_key");
		expect(data.spnSecretKey).toBe("my_secret_key");
	});

	it("purges plaintext credentials from data", () => {
		const data: any = {
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
		} as any;

		const data: any = {
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
		} as any;

		const data: any = {};
		await migrateSecretStorage(mockApp, data);
		expect(data.spnCredentialStorageMode).toBe("secretStorage");
	});

	it("sets default spnCredentialStorageMode to plaintext if app.secretStorage does not exist during migration", async () => {
		const mockApp = {} as any;
		const data: any = {};
		await migrateSecretStorage(mockApp, data);
		expect(data.spnCredentialStorageMode).toBe("plaintext");
	});
});



