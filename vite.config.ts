import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "ggwave-balanced": fileURLToPath(new URL("./src/vendor/ggwave-balanced/ggwave.cjs", import.meta.url)) },
  },
  optimizeDeps: {
    include: ["ggwave-balanced"],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /vendor[\\/]ggwave-balanced/],
    },
  },
  server: {
    host: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
