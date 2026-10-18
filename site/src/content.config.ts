import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

/**
 * The docs are the repository's own markdown (../docs/*.md and ../INSTALL.md), read in place
 * so the website never drifts from what's on GitHub. Each file's slug is its lowercased name.
 */
const docs = defineCollection({
  loader: glob({
    base: "..",
    pattern: ["INSTALL.md", "docs/*.md"],
    generateId: ({ entry }) => entry.split("/").pop()!.replace(/\.md$/i, "").toLowerCase(),
  }),
});

export const collections = { docs };
