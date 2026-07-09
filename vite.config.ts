import { defineConfig } from "vite";

// Four entry points. background/content need stable file names because the
// manifest references them; content.ts must bundle with zero runtime imports
// (MV3 content scripts are classic scripts, not ES modules).
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: "popup.html",
        options: "options.html",
        background: "src/background/index.ts",
        content: "src/content/index.ts",
        "page-youtube": "src/page/youtube.ts",
        "page-netflix": "src/page/netflix.ts",
      },
      output: {
        entryFileNames: (chunk) =>
          ["background", "content", "page-youtube", "page-netflix"].includes(chunk.name)
            ? "[name].js"
            : "assets/[name]-[hash].js",
      },
    },
  },
});
