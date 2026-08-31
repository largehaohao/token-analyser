/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.TOKEN_ANALYSER_API_URL ?? "http://127.0.0.1:7789";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  server: {
    host: "127.0.0.1",
    port: 7788,
    proxy: {
      "/sessions": apiTarget,
      "/overview": apiTarget,
      "/stream": { target: apiTarget, ws: false },
      "/import": apiTarget,
    },
  },
  build: { outDir: "dist" },
});
