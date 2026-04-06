import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Prompt eval tests — structural validation of the system prompt and schema files.
 * These verify that the prompt contains all required sections and instructions
 * without needing an LLM call. LLM-based eval tests would go in a separate
 * file using an API key (not shipped to users).
 */

const SCHEMA_DIR = path.resolve("schema");

describe("System prompt quality", () => {
  let promptContent: string;

  it("schema/prompt.md exists and is non-empty", () => {
    const promptPath = path.join(SCHEMA_DIR, "prompt.md");
    expect(fs.existsSync(promptPath)).toBe(true);
    promptContent = fs.readFileSync(promptPath, "utf-8");
    expect(promptContent.length).toBeGreaterThan(500);
  });

  // ── Three operations ──────────────────────────────────────────

  describe("Karpathy's three operations", () => {
    beforeAll(() => {
      promptContent = fs.readFileSync(
        path.join(SCHEMA_DIR, "prompt.md"),
        "utf-8"
      );
    });

    it("documents INGEST operation", () => {
      expect(promptContent).toContain("INGEST");
      expect(promptContent).toContain("add_source");
      expect(promptContent).toContain("apply_wiki_ops");
    });

    it("documents QUERY operation", () => {
      expect(promptContent).toContain("QUERY");
      expect(promptContent).toContain("search");
      expect(promptContent).toContain("read_page");
    });

    it("documents LINT operation", () => {
      expect(promptContent).toContain("LINT");
      expect(promptContent).toContain("lint");
      expect(promptContent).toContain("question_assumptions");
    });

    it("documents Onboarding flow", () => {
      expect(promptContent).toContain("Onboarding");
      expect(promptContent).toContain("complete_onboarding");
    });
  });

  // ── Wiki page format ──────────────────────────────────────────

  describe("wiki page format specification", () => {
    beforeAll(() => {
      promptContent = fs.readFileSync(
        path.join(SCHEMA_DIR, "prompt.md"),
        "utf-8"
      );
    });

    it("specifies TLDR section", () => {
      expect(promptContent).toContain("TLDR");
    });

    it("specifies Counter-arguments section (non-negotiable)", () => {
      expect(promptContent).toContain("Counter-arguments");
      // Must emphasize this is mandatory
      expect(promptContent).toMatch(/non-negotiable|MUST|required/i);
    });

    it("specifies wikilink format [[page-name]]", () => {
      expect(promptContent).toContain("[[");
      expect(promptContent).toContain("]]");
      expect(promptContent).toMatch(/wikilink/i);
    });

    it("specifies index.md maintenance", () => {
      expect(promptContent).toContain("index.md");
      expect(promptContent).toMatch(/update.*index|index.*update/i);
    });

    it("specifies Key Facts section", () => {
      expect(promptContent).toContain("Key Facts");
    });

    it("specifies Sources section", () => {
      expect(promptContent).toContain("Sources");
    });
  });

  // ── Rules and constraints ─────────────────────────────────────

  describe("rules and constraints", () => {
    beforeAll(() => {
      promptContent = fs.readFileSync(
        path.join(SCHEMA_DIR, "prompt.md"),
        "utf-8"
      );
    });

    it("prohibits deleting user content", () => {
      expect(promptContent).toMatch(/never delete/i);
    });

    it("prohibits fabricating sources", () => {
      expect(promptContent).toMatch(/never fabricat/i);
    });

    it("requires counter-arguments to be specific", () => {
      expect(promptContent).toMatch(/specific/i);
      // Should explicitly reject generic counter-arguments
      expect(promptContent).toMatch(/some people disagree/i);
    });

    it("mentions sacred boundary in error handling", () => {
      expect(promptContent).toContain("sacred boundary");
    });

    it("references schema/identity.md for personalization", () => {
      expect(promptContent).toContain("identity.md");
    });

    it("references schema/interests.md for priorities", () => {
      expect(promptContent).toContain("interests.md");
    });

    it("documents startup behavior", () => {
      expect(promptContent).toContain("get_status");
      expect(promptContent).toMatch(/startup|first connected/i);
    });
  });

  // ── Schema files ──────────────────────────────────────────────

  describe("schema template files", () => {
    it("identity.md is a valid editable template", () => {
      const content = fs.readFileSync(
        path.join(SCHEMA_DIR, "identity.md"),
        "utf-8"
      );
      expect(content).toContain("# Identity");
      expect(content).toContain("Who am I");
      // Should have placeholder fields to fill in
      expect(content).toContain("Name:");
      expect(content).toContain("Role:");
    });

    it("interests.md is a valid editable template", () => {
      const content = fs.readFileSync(
        path.join(SCHEMA_DIR, "interests.md"),
        "utf-8"
      );
      expect(content).toContain("# Interests");
      expect(content).toContain("Topics I follow");
    });

    it("rules.md is a valid editable template", () => {
      const content = fs.readFileSync(
        path.join(SCHEMA_DIR, "rules.md"),
        "utf-8"
      );
      expect(content).toContain("# Rules");
      expect(content).toContain("counter-arguments");
    });

    it("all schema files use HTML comments for instructions", () => {
      const files = ["identity.md", "interests.md", "rules.md"];
      for (const file of files) {
        const content = fs.readFileSync(
          path.join(SCHEMA_DIR, file),
          "utf-8"
        );
        expect(
          content,
          `${file} should have HTML comment instructions`
        ).toContain("<!--");
      }
    });
  });

  // ── Prompt completeness ───────────────────────────────────────

  describe("prompt references all MCP tools", () => {
    const tools = [
      "add_source",
      "apply_wiki_ops",
      "search",
      "read_page",
      "get_status",
      "lint",
      "question_assumptions",
    ];

    beforeAll(() => {
      promptContent = fs.readFileSync(
        path.join(SCHEMA_DIR, "prompt.md"),
        "utf-8"
      );
    });

    for (const tool of tools) {
      it(`mentions tool: ${tool}`, () => {
        expect(promptContent).toContain(tool);
      });
    }
  });
});
