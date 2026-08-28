import type { RolloutLine } from "./types.ts";

export type ContextItem = {
  name: string;
  chars: number;
  source?: string;
  description?: string;
};

export type ContextBucket = {
  chars: number;
  items: ContextItem[];
};

export type ContextProfile = {
  tools: ContextBucket;
  skills: ContextBucket;
};

export function emptyContextProfile(): ContextProfile {
  return {
    tools: { chars: 0, items: [] },
    skills: { chars: 0, items: [] },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentTexts(payload: Record<string, unknown>): string[] {
  const content = payload.content;
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    const record = asRecord(part);
    return record ? asString(record.text) : "";
  });
}

function contentKinds(payload: Record<string, unknown>): string[] {
  const meta = asRecord(payload.internal_chat_message_metadata_passthrough);
  const kinds = meta?.content_item_kinds;
  return Array.isArray(kinds) ? kinds.map((kind) => asString(kind)) : [];
}

function parseSkillSource(description: string): {
  source?: string;
  description: string;
} {
  const match = description.match(/\(file:\s*([^)]+)\)\s*$/);
  if (!match) return { description };
  return {
    source: match[1]!.trim(),
    description: description.slice(0, match.index).trim(),
  };
}

export function parseSkillItems(text: string): ContextItem[] {
  const items: ContextItem[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^- (\S+): (.+)$/);
    if (!match) continue;
    const parsed = parseSkillSource(match[2]!);
    items.push({
      name: match[1]!,
      chars: line.length,
      ...(parsed.source ? { source: parsed.source } : {}),
      ...(parsed.description ? { description: parsed.description } : {}),
    });
  }
  return items;
}

function extractTools(events: RolloutLine[]): ContextBucket {
  for (const event of events) {
    if (event.type !== "session_meta") continue;
    const payload = event.payload ?? {};
    const dynamicTools = payload.dynamic_tools;
    if (!Array.isArray(dynamicTools) || dynamicTools.length === 0) continue;
    const items: ContextItem[] = [];
    for (const group of dynamicTools) {
      const record = asRecord(group);
      if (!record) continue;
      const nested = record.tools;
      const source = asString(record.name) || undefined;
      if (!Array.isArray(nested)) continue;
      for (const tool of nested) {
        const toolRecord = asRecord(tool);
        if (!toolRecord) continue;
        const name = asString(toolRecord.name);
        if (!name) continue;
        const description = asString(toolRecord.description) || undefined;
        items.push({
          name,
          chars: JSON.stringify(tool).length,
          ...(source ? { source } : {}),
          ...(description ? { description } : {}),
        });
      }
    }
    return { chars: JSON.stringify(dynamicTools).length, items };
  }
  return { chars: 0, items: [] };
}

function skillsFromDeveloperMessage(events: RolloutLine[]): string | null {
  for (const event of events) {
    if (event.type !== "response_item") continue;
    const payload = event.payload ?? {};
    if (payload.type !== "message") continue;
    const texts = contentTexts(payload);
    const kinds = contentKinds(payload);
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      if (kinds[i] === "host_skills.instructions") return text;
    }
    for (const text of texts) {
      if (text.startsWith("<skills_instructions>")) return text;
    }
  }
  return null;
}

function skillsFromWorldState(events: RolloutLine[]): string | null {
  for (const event of events) {
    if (event.type !== "world_state") continue;
    const payload = event.payload ?? {};
    const state = asRecord(payload.state);
    const hostSkills = state ? asRecord(state.host_skills) : null;
    const body = hostSkills ? asString(hostSkills.body) : "";
    if (body) return body;
  }
  return null;
}

function extractSkills(events: RolloutLine[]): ContextBucket {
  const text =
    skillsFromDeveloperMessage(events) ?? skillsFromWorldState(events);
  if (!text) return { chars: 0, items: [] };
  return { chars: text.length, items: parseSkillItems(text) };
}

export function extractContextProfile(events: RolloutLine[]): ContextProfile {
  return {
    tools: extractTools(events),
    skills: extractSkills(events),
  };
}
