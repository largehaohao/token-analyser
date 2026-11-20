const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

export function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function markdownTables(markdown: string): string[][][] {
  const tables: string[][][] = [];
  let current: string[][] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) {
      if (current) tables.push(current);
      current = null;
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    current ??= [];
    current.push(cells);
  }
  if (current) tables.push(current);
  return tables;
}

export function parseMoney(cell: string): number | null {
  const match = cell.replace(/,/g, "").match(/\$(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function calendarDate(monthName: string, day: string, year: string): string | null {
  const month = MONTHS[monthName.toLowerCase()];
  const dayNumber = Number(day);
  const yearNumber = Number(year);
  if (!month || !Number.isInteger(dayNumber) || !Number.isInteger(yearNumber)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
}

/**
 * Pick the USD amount that applies on `now`. Storage prices and audio-only
 * rates are ignored when a text price is also present. A bare amount applies
 * on every date.
 */
export function selectUsd(cell: string, now: Date): number | null {
  const today = now.toISOString().slice(0, 10);
  const candidates: { amount: number; audioOnly: boolean; text: boolean }[] = [];
  for (const match of cell.matchAll(/\$(\d[\d,]*(?:\.\d+)?)([^$]*)/g)) {
    const amount = Number(match[1]!.replace(/,/g, ""));
    const tail = match[2] ?? "";
    if (!Number.isFinite(amount) || /storage/i.test(tail)) continue;
    const through = tail.match(/through\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
    const starting = tail.match(/starting\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
    if (through) {
      const end = calendarDate(through[1]!, through[2]!, through[3]!);
      if (!end || today > end) continue;
    }
    if (starting) {
      const start = calendarDate(starting[1]!, starting[2]!, starting[3]!);
      if (!start || today < start) continue;
    }
    candidates.push({
      amount,
      audioOnly: /audio/i.test(tail) && !/text/i.test(tail),
      text: /text/i.test(tail),
    });
  }
  const text = candidates.filter((candidate) => candidate.text);
  const pool = text.length > 0 ? text : candidates.filter((candidate) => !candidate.audioOnly);
  return pool[0]?.amount ?? null;
}
