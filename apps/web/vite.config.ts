import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const hub = process.env.WARREN_HUB ?? "http://localhost:4747";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // noVNC (live view of computers) uses top-level await
  build: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  server: {
    port: 5173,
    proxy: { "/api": hub, "/ws": { target: hub.replace(/^http/, "ws"), ws: true } },
  },
});
