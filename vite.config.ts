import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    modulePreload: false,
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(rootDir, "popup.html"),
        sidepanel: resolve(rootDir, "sidepanel.html"),
        background: resolve(rootDir, "src/background.ts"),
        content: resolve(rootDir, "src/content.ts")
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" || chunk.name === "content"
            ? "[name].js"
            : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
