import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const projectPath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// GitHub Pages serves this repository under /WenFeng/ rather than the domain root.
// This build includes no Workers, D1 bindings, or hosted authentication.
export default defineConfig({
  root: projectPath("./pages/"),
  base: "/WenFeng/",
  publicDir: projectPath("./public/"),
  plugins: [react()],
  resolve: { alias: { "@": projectPath("./") } },
  css: { postcss: projectPath("./") },
  build: {
    outDir: projectPath("./dist-pages/"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
