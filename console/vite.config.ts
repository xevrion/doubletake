import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // Built straight into the directory Hono serves, so there is one server in
  // development and in the demo.
  build: { outDir: "../web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000", "/eval-results.json": "http://localhost:3000" },
  },
});
