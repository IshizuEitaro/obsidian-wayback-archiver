import { defineConfig } from "vitest/config";

process.env.TZ = "UTC";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		globals: true,
	},
});
