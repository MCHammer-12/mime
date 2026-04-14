import { renderSections } from "./index.js";
import { EmailBlockType, Section } from "./types.js";

const sections: Section[] = [
  {
    type: EmailBlockType.SPACER,
    blockId: "a",
    sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    sectionColor: "#ffffff",
    height: 40,
  },
  {
    type: EmailBlockType.TEXT,
    blockId: "b-text",
    sectionPadding: { top: 10, right: 20, bottom: 10, left: 20 },
    sectionColor: "#ffffff",
    textColor: "#333333",
    fontSize: 16,
    fontFamily: "Arial",
    linkColor: "#0066cc",
    text: "<p>Hello world from production renderer</p>",
  } as any,
  {
    type: EmailBlockType.LINE,
    blockId: "b",
    sectionPadding: { top: 10, right: 20, bottom: 10, left: 20 },
    sectionColor: "#ffffff",
    color: "#000000",
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
  },
  {
    type: EmailBlockType.BUTTON,
    blockId: "c-btn",
    sectionPadding: { top: 10, right: 20, bottom: 10, left: 20 },
    sectionColor: "#ffffff",
    alignment: "center",
    cornerRadius: 4,
    buttonText: "Click Me",
    padding: { top: 12, right: 24, bottom: 12, left: 24 },
    buttonLink: "https://example.com",
    fillColor: "#0066cc",
    strokeColor: "#0066cc",
    textColor: "#ffffff",
    strokeWeight: 0,
    fontFamily: "Arial",
    fontSize: 16,
    linkType: "web-page",
  } as any,
  {
    type: EmailBlockType.SPACER,
    blockId: "c",
    sectionPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    sectionColor: "#f5f5f5",
    height: 20,
  },
];

const html = renderSections(sections);

const checks = [
  ["contains doctype", html.includes("<!doctype html>")],
  ["contains Hello world", html.includes("Hello world from production renderer")],
  ["contains Click Me", html.includes("Click Me")],
  ["contains background color", html.includes("#f5f5f5")],
] as const;

let allPassed = true;
for (const [name, result] of checks) {
  console.log(`${result ? "PASS" : "FAIL"}: ${name}`);
  if (!result) allPassed = false;
}

if (!allPassed) {
  process.exit(1);
}

console.log("\nAll smoke tests passed.");
