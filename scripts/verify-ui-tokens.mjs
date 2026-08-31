import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const design = readFileSync(new URL("../DESIGN.md", import.meta.url), "utf8");
const styles = readFileSync(
  new URL("../apps/web/src/styles.css", import.meta.url),
  "utf8",
);
const root = styles.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
const frontmatter = design.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
const mapping = {
  colors: {
    primary: "accent",
    background: "bg",
    surface: "bg-raised",
    inset: "bg-inset",
    border: "border",
    text: "text",
    muted: "text-muted",
    warning: "warn",
    danger: "danger",
  },
  rounded: { DEFAULT: "radius", control: "radius-control" },
  spacing: { panel: "space-panel", gap: "space-gap" },
};
let checked = 0;
for (const [group, tokens] of Object.entries(mapping)) {
  const section =
    frontmatter.match(
      new RegExp(`^${group}:\\n((?:[ \\t]+.*\\n?)+)`, "m"),
    )?.[1] ?? "";
  for (const [name, variable] of Object.entries(tokens)) {
    const declared = section.match(
      new RegExp(`^  ${name}: ["']([^"']+)["']`, "m"),
    )?.[1];
    const actual = root
      .match(new RegExp(`--${variable}:\\s*([^;]+);`))?.[1]
      .trim();
    assert.ok(declared && actual, `Missing ${group}.${name} or --${variable}`);
    assert.equal(
      actual,
      declared,
      `${group}.${name} drifted from --${variable}`,
    );
    checked += 1;
  }
}
for (const [role, variable] of Object.entries({
  body: "font",
  display: "display",
  mono: "mono",
})) {
  const declared = frontmatter.match(
    new RegExp(`^  ${role}:\\n    fontFamily: (.+)$`, "m"),
  )?.[1];
  const actual = root.match(new RegExp(`--${variable}:\\s*([^;]+);`))?.[1];
  const normalize = (value) =>
    value?.replace(/["']/g, "").replace(/\s+/g, " ").trim();
  assert.ok(declared && actual, `Missing font mapping for ${role}`);
  assert.equal(
    normalize(actual),
    normalize(declared),
    `Typography ${role} drifted`,
  );
  checked += 1;
}
console.log(`${checked} design-to-runtime token mappings verified.`);
