import { describe, expect, it } from "vitest";
import { extractContextProfile } from "../src/context-profile.ts";
import type { RolloutLine } from "../src/types.ts";

function event(type: string, payload: Record<string, unknown>): RolloutLine {
  return { timestamp: "2026-08-28T00:00:00.000Z", type, payload };
}

const SKILLS_TEXT = `<skills_instructions>
## Skills
A skill is a set of instructions.
### Available skills
- tdd: Test-driven development. (file: /tmp/tdd/SKILL.md)
- chrome:control-chrome: Control Chrome. (file: /tmp/chrome/SKILL.md)
</skills_instructions>`;

const FORK_TOOL = {
  type: "function",
  name: "fork_thread",
  description: "Fork a thread",
  inputSchema: { type: "object", properties: { title: { type: "string" } } },
};

describe("extractContextProfile", () => {
  it("returns empty buckets when the rollout has no tools or skills", () => {
    expect(extractContextProfile([event("session_meta", { id: "s1" })])).toEqual(
      {
        tools: { chars: 0, items: [] },
        skills: { chars: 0, items: [] },
      },
    );
  });

  it("reads dynamic_tools schemas and lists each tool with its JSON size", () => {
    const tools = [
      {
        type: "namespace",
        name: "codex_app",
        description: "Codex app tools",
        tools: [FORK_TOOL],
      },
    ];
    const profile = extractContextProfile([
      event("session_meta", { id: "s1", dynamic_tools: tools }),
    ]);
    expect(profile.tools.chars).toBe(JSON.stringify(tools).length);
    expect(profile.tools.items).toEqual([
      {
        name: "fork_thread",
        chars: JSON.stringify(FORK_TOOL).length,
        source: "codex_app",
        description: "Fork a thread",
      },
    ]);
  });

  it("parses skill catalog entries including names that contain a colon", () => {
    const profile = extractContextProfile([
      event("session_meta", { id: "s1" }),
      event("response_item", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: SKILLS_TEXT }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["host_skills.instructions"],
        },
      }),
    ]);
    expect(profile.skills.chars).toBe(SKILLS_TEXT.length);
    expect(profile.skills.items.map((item) => item.name)).toEqual([
      "tdd",
      "chrome:control-chrome",
    ]);
    expect(profile.skills.items[0]!.source).toBe("/tmp/tdd/SKILL.md");
    expect(profile.skills.items[0]!.chars).toBe(
      "- tdd: Test-driven development. (file: /tmp/tdd/SKILL.md)".length,
    );
  });

  it("falls back to world_state host_skills.body when no developer message exists", () => {
    const body = "### Available skills\n- research: Look things up. (file: /tmp/research/SKILL.md)\n";
    const profile = extractContextProfile([
      event("world_state", {
        full: true,
        state: { host_skills: { body, includeInstructions: true } },
      }),
    ]);
    expect(profile.skills.chars).toBe(body.length);
    expect(profile.skills.items).toEqual([
      {
        name: "research",
        chars: "- research: Look things up. (file: /tmp/research/SKILL.md)".length,
        source: "/tmp/research/SKILL.md",
        description: "Look things up.",
      },
    ]);
  });
});
