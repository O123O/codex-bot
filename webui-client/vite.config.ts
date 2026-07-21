import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";

const favicon = `data:image/png;base64,${readFileSync(new URL("./src/favicon.png", import.meta.url)).toString("base64")}`;

// Build the whole client into ONE self-contained ../assets/webui/index.html (JS+CSS inlined), so
// the bot ships a single committed asset and the packaging/pack-tests stay unchanged.
export default defineConfig({
  plugins: [
    {
      name: "inline-favicon",
      transformIndexHtml: {
        order: "pre",
        handler: (html) => html.replace("/src/favicon.png", favicon),
      },
    },
    react(),
    viteSingleFile(),
    {
      name: "trim-generated-trailing-whitespace",
      enforce: "post",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === "asset" && typeof output.source === "string") {
            output.source = output.source.replace(/[\t ]+$/gmu, "");
          }
        }
      },
    },
  ],
  build: { outDir: "../assets/webui", emptyOutDir: true, assetsInlineLimit: 100000000, chunkSizeWarningLimit: 4000 },
});
