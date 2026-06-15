import crypto from "node:crypto";

export function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

export function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function parseBullets(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1]?.trim() ?? null)
    .filter((value): value is string => Boolean(value));
}

export function splitMemoryMarkdownSections(
  text: string,
): Array<{ path: string[]; contentLines: string[] }> {
  const lines = text.split(/\r?\n/);
  const sections: Array<{ path: string[]; contentLines: string[] }> = [];
  const stack: Array<{ level: number; heading: string }> = [];
  let current: { path: string[]; contentLines: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(/^(#{2,3})\s+(.*)$/);
    if (match) {
      if (current) sections.push(current);
      const level = match[1].length;
      const heading = match[2].trim();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, heading });
      current = { path: stack.map((item) => item.heading), contentLines: [] };
      continue;
    }
    if (current) current.contentLines.push(line);
  }

  if (current) sections.push(current);
  return sections;
}

export function toIsoFromMs(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}
