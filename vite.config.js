import { defineConfig } from "vite";

const staticWorker = () => ({
  name: "bandobrief-static-worker",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "server/index.js",
      source: 'export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };\n'
    });
  }
});

export default defineConfig({
  plugins: [staticWorker()],
  base: "./",
  server: {
    port: 5173,
    strictPort: true
  },
  preview: {
    port: 4173,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true
  }
});
