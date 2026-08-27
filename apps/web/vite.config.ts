import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 7788,
    proxy: {
      "/sessions": "http://127.0.0.1:7789",
      "/stream": { target: "http://127.0.0.1:7789", ws: false },
      "/import": "http://127.0.0.1:7789",
    },
  },
  build: { outDir: "dist" },
});
