import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { slug as githubSlug } from "github-slugger";

const SPEC_PATH = fileURLToPath(
  new URL("../content/docs/specification/spec.md", import.meta.url),
);
const SPEC_URL = "/specification/spec/";

// Matches §N or §N.N but not §§ (range citations like §§4–7 have no single anchor).
const CITATION_RE = /(?<!§)§(?!§)(\d+(?:\.\d+)*)/g;
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;
const SECTION_NUMBER_RE = /^(\d+(?:\.\d+)*)\.?\s+/;

let sectionMapCache = null;

function buildSectionMap() {
  if (sectionMapCache) return sectionMapCache;
  sectionMapCache = new Map();

  if (!existsSync(SPEC_PATH)) {
    console.warn(
      `[remark-spec-links] ${SPEC_PATH} not found (run \`npm run sync\` first) — § citations will be left as plain text for this build.`,
    );
    return sectionMapCache;
  }

  for (const line of readFileSync(SPEC_PATH, "utf-8").split("\n")) {
    const heading = line.match(HEADING_RE);
    if (!heading) continue;
    const number = heading[1].match(SECTION_NUMBER_RE);
    if (!number) continue;
    // Slugged from the raw heading text (number + title) — same input Starlight's
    // own heading-id generation slugs, so anchors match without reimplementing markdown stripping.
    sectionMapCache.set(number[1], githubSlug(heading[1]));
  }

  return sectionMapCache;
}

function linkifyText(node, sectionMap, filePath) {
  const { value } = node;
  let lastIndex = 0;
  let match;
  const parts = [];

  while ((match = CITATION_RE.exec(value))) {
    const [full, number] = match;
    const anchor = sectionMap.get(number);
    if (!anchor) {
      console.warn(`[remark-spec-links] ${filePath}: unresolved section §${number}`);
      continue;
    }
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: value.slice(lastIndex, match.index) });
    }
    parts.push({
      type: "link",
      url: `${SPEC_URL}#${anchor}`,
      children: [{ type: "text", value: full }],
    });
    lastIndex = match.index + full.length;
  }

  if (parts.length === 0) return null;
  if (lastIndex < value.length) {
    parts.push({ type: "text", value: value.slice(lastIndex) });
  }
  return parts;
}

function transform(node, sectionMap, filePath) {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === "text") {
      const replacement = linkifyText(child, sectionMap, filePath);
      if (replacement) {
        node.children.splice(i, 1, ...replacement);
        i += replacement.length - 1;
      }
    } else {
      transform(child, sectionMap, filePath);
    }
  }
}

export default function remarkSpecLinks() {
  return (tree, file) => {
    const sectionMap = buildSectionMap();
    if (sectionMap.size === 0) return;
    transform(tree, sectionMap, file.path ?? "unknown file");
  };
}
