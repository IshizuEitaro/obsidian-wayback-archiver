import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("Obsidian scorecard compliance", () => {
	it("uses window-scoped browser globals in archiver", () => {
		const source = read("src/core/archiver.ts");
		expect(source).not.toMatch(/(?<![.\w])setTimeout\s*\(/);
		expect(source).not.toContain("globalThis.open");
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
		expect(read("src/ui/SettingsTab.ts")).not.toContain(
			'.setName("SPN API v2 settings").setHeading()',
		);
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
