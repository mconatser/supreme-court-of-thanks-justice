import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests never touch the network: every test context is built in stub mode.
    env: { GATEWAY_MODE: "stub" },
    testTimeout: 15000,
  },
});
