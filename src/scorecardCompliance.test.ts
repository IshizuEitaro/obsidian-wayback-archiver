import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("Obsidian scorecard compliance", () => {
	it("uses window-scoped browser globals in archiver", () => {
		const source = read("src/core/archiver.ts");
		expect(source).not.toMatch(/(?<![.\w])setTimeout\s*\(/);
		expect(source).not.toContain("globalThis.open");
	});

	it("uses window-scoped timers for batch delays", () => {
		expect(read("src/core/batchRun.ts")).not.toContain("globalThis.");
	});

	it("uses Obsidian element helpers for the progress chip", () => {
		const source = read("src/ui/ArchiveProgressChip.ts");
		expect(source).not.toContain("document.createElement");
		expect(source).toContain("createDiv");
		expect(source).toContain("createEl");
	});

	it("accesses optional Obsidian APIs through compatibility helpers", () => {
		const settingsTab = read("src/ui/SettingsTab.ts");
		const definitions = read("src/ui/settings/definitions.ts");
		const shared = read("src/ui/settings/shared.ts");

		expect(settingsTab).not.toContain(".secretStorage");
		expect(settingsTab).not.toMatch(/\bSecretComponent\b/);
		expect(definitions).not.toMatch(/\bSecretComponent\b/);
		expect(shared).not.toContain(".secretStorage");
	});

	it("does not call deprecated button and slider methods", () => {
		const source = read("src/ui/SettingsTab.ts");
		expect(source).not.toContain(".setWarning()");
		expect(source).not.toContain(".setDynamicTooltip()");
	});

	it("uses Node's builtin module list instead of builtin-modules", () => {
		expect(read("esbuild.config.mjs")).toContain('from "node:module"');
		expect(read("package.json")).not.toContain('"builtin-modules"');
	});

	it("minifies production builds while preserving development source maps", () => {
		const source = read("esbuild.config.mjs");
		expect(source).toContain("minify: prod");
		expect(source).toContain('sourcemap: prod ? false : "inline"');
	});

	it("does not use settings in a settings heading", () => {
		const legacySource = read("src/ui/SettingsTab.ts");
		const declarativeSource = read("src/ui/settings/definitions.ts");
		expect(legacySource).not.toMatch(
			/setName\("SPN API v2 (?:settings|options)"\)\.setHeading\(\)/,
		);
		expect(declarativeSource).not.toMatch(/name: "SPN API v2 (?:settings|options)"/);
	});

	it("manages all context-menu listeners through the plugin lifecycle", () => {
		const source = read("src/core/contextMenus.ts");
		expect(source.match(/plugin\.registerEvent\(/gu)).toHaveLength(4);
		for (const event of ["editor-menu", "file-menu", "url-menu", "files-menu"]) {
			expect(source).toContain(`workspace.on("${event}"`);
		}
	});

	it("attests release assets and installs from the frozen lockfile", () => {
		const workflow = read(".github/workflows/release.yaml");
		expect(workflow).toContain("pnpm install --frozen-lockfile");
		expect(workflow).toContain('node-version: "24.18.0"');
		expect(workflow).toContain("attestations: write");
		expect(workflow).toContain("id-token: write");
		expect(workflow).toContain("actions/attest-build-provenance");
		expect(workflow).toContain("main.js");
		expect(workflow).toContain("styles.css");
	});
});
