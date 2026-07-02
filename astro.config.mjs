// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  // Apex domain on Cloudflare Pages (see DEPLOY.md). No base path: served at the root.
  site: "https://openbody.dev",
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "OpenBody™",
      description:
        "An open, vendor-neutral, language-agnostic standard for health & fitness data interoperability. A pre-v1.0 draft.",
      tagline: "Own and port your health & fitness data — without platform lock-in.",
      logo: { src: "./src/assets/openbody-mark.svg", alt: "OpenBody" },
      customCss: ["./src/styles/custom.css"],
      // NOTE: repo is not yet created/public — see DEPLOY.md manual steps.
      social: { github: "https://github.com/openbody/openbody" },
      editLink: {
        baseUrl: "https://github.com/openbody/openbody-docs/edit/main/",
      },
      lastUpdated: true,
      sidebar: [
        { label: "Home", link: "/" },
        {
          label: "Getting started",
          items: [
            { label: "Install & validate a record", link: "/getting-started/" },
            { label: "Run the conformance vectors", link: "/getting-started/vectors/" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "The data model", link: "/concepts/data-model/" },
            { label: "The two pillars", link: "/concepts/pillars/" },
            { label: "Exercise identity (§6)", link: "/concepts/exercise-identity/" },
            { label: "Canonicalization & equivalence (§8.3)", link: "/concepts/canonicalization/" },
          ],
        },
        {
          label: "Specification",
          items: [
            { label: "Overview", link: "/specification/" },
            { label: "SPEC.md", link: "/specification/spec/" },
            { label: "JSON Schema", link: "/specification/schema/" },
            { label: "Changelog", link: "/specification/changelog/" },
          ],
        },
        {
          label: "Mapping guides",
          items: [
            { label: "Overview", link: "/mapping/" },
            { label: "Hevy", link: "/mapping/hevy/" },
            { label: "Strong", link: "/mapping/strong/" },
            { label: "Strava", link: "/mapping/strava/" },
            { label: "Apple Health / Health Connect", link: "/mapping/apple-health/" },
            { label: "FIT", link: "/mapping/fit/" },
          ],
        },
        {
          label: "Conformance",
          items: [
            { label: "Profiles & vectors", link: "/conformance/" },
            { label: "Reference README", link: "/conformance/conformance-readme/" },
          ],
        },
        {
          label: "Registry",
          items: [
            { label: "Overview", link: "/registry/" },
            { label: "Exercise registry", link: "/registry/exercises/" },
            { label: "Measurement-type registry", link: "/registry/measurements/" },
          ],
        },
        {
          label: "Project",
          items: [
            { label: "Governance & contributing", link: "/governance/" },
            { label: "Licensing", link: "/licensing/" },
          ],
        },
      ],
    }),
  ],
});
