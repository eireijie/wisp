// @ts-check
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import rehypeDocLinks from "./src/lib/rehype-doc-links.mjs";

// The site's public address. The domain isn't chosen yet: change it here, and only here.
export const SITE_URL = "https://wisp-app.pages.dev";

export default defineConfig({
  site: SITE_URL,
  output: "static",
  trailingSlash: "always",
  build: { format: "directory" },
  markdown: {
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark" },
      wrap: false,
    },
    // The docs are the repo's own markdown; this plugin points their links at the right pages.
    processor: unified({ rehypePlugins: [rehypeDocLinks] }),
  },
});
