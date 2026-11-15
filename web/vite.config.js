import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "web",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split the dependencies that every page needs away from app code.
        // Assets are served `immutable` (server/index.js), so keeping these in
        // their own chunks means editing a component re-downloads ~30 KB of app
        // code instead of invalidating the whole bundle.
        //
        // The genuinely big libraries are NOT listed here on purpose — they are
        // dynamically imported at their use sites and Rollup gives each its own
        // chunk automatically: highlight.js (markdown.js, on first code block),
        // jsxgraph (figure.js, only for a ```jsxgraph fence) and xterm
        // (Terminal.jsx, only when the TUI/Shell overlay opens).
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
          markdown: ["marked", "marked-katex-extension", "katex", "dompurify"],
        },
      },
    },
    // The remaining entry chunk is well under this; the warning only fires if
    // something large sneaks back into the critical path.
    chunkSizeWarningLimit: 400,
  },
});