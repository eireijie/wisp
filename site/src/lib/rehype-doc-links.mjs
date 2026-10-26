// Makes the repository's markdown work on the website:
// - links between docs (deploy.md, docs/computers.md#…, INSTALL.md) go to the docs pages here
// - other relative links (README.md, apps/ios/README.md, …) go to the file on GitHub
// - tables get a scrolling wrapper so they never widen the page on a phone
// It has no dependencies: it walks the HTML tree itself.

import { DOC_ORDER, REPO } from "./site.ts";

const REPO_BLOB = `${REPO}/blob/main/`;
const DOC_PAGES = new Set(DOC_ORDER.map((doc) => doc.slug));

function rewrite(href) {
  if (/^([a-z]+:|#|\/)/i.test(href)) return href;
  const [path, hash = ""] = href.split("#");
  const clean = path.replace(/^(\.\.?\/)+/, "");
  const name = clean.split("/").pop().replace(/\.md$/i, "").toLowerCase();
  const isDoc = /\.md$/i.test(clean) && DOC_PAGES.has(name) && (clean.startsWith("docs/") || !clean.includes("/"));
  if (isDoc) return `/docs/${name}/${hash ? `#${hash}` : ""}`;
  return REPO_BLOB + clean + (hash ? `#${hash}` : "");
}

function walk(node, parent) {
  if (node.type === "element") {
    if (node.tagName === "a" && typeof node.properties?.href === "string") {
      const before = node.properties.href;
      node.properties.href = rewrite(before);
      if (/^https?:/i.test(node.properties.href)) node.properties.rel = ["noopener"];
    }
    if (node.tagName === "table" && parent && !(parent.type === "element" && parent.properties?.className?.includes?.("table-wrap"))) {
      const index = parent.children.indexOf(node);
      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["table-wrap"], tabIndex: 0, role: "region", ariaLabel: "Table (scrolls sideways)" },
        children: [node],
      };
    }
  }
  if (node.children) for (const child of [...node.children]) walk(child, node);
}

export default function rehypeDocLinks() {
  return (tree) => walk(tree, null);
}
