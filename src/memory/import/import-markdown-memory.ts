import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationRulesConfig } from "../config/types.js";
import {
  parseBullets,
  sha256Text,
  slugify,
  splitMemoryMarkdownSections,
  toIsoFromMs,
} from "./markdown-import-utils.js";
import type {
  ImportedMemoryLink,
  ImportedMemoryRecord,
  ImportedSessionRun,
  MarkdownImportResult,
} from "./types.js";

const MIGRATION_VERSION = "markdown-memory-v2";

function detectSensitivity(
  content: string,
  rules: MigrationRulesConfig,
  title?: string,
  kindHint?: string,
): string {
  const cfg = rules.sensitivity_rules;
  const lower = content.toLowerCase();
  const titleLower = (title ?? "").toLowerCase();
  const hint = (kindHint ?? "").toLowerCase();

  if (cfg.force_normal_kind_hints.includes(hint)) return "normal";
  if (cfg.secret_markers.some((m) => lower.includes(m))) return "secret";
  if (cfg.secret_presence_markers.some((m) => lower.includes(m))) return "secret";
  if (
    cfg.sensitive_when_kind.includes(hint) &&
    cfg.sensitive_markers.some((m) => lower.includes(m))
  )
    return "sensitive";
  for (const rule of cfg.special_title_sensitive_rules) {
    if (titleLower.includes(rule.title_contains) && lower.includes(rule.content_contains))
      return rule.sensitivity;
  }
  return "normal";
}

function inferScopeAndMentions(
  title: string,
  sectionPath: string[],
  content: string,
  rules: MigrationRulesConfig,
) {
  const joined = sectionPath.join(" / ").toLowerCase();
  const lower = `${title}\n${content}`.toLowerCase();
  let scope = "global";
  let scopeKey: string | null = null;
  const mentions: Array<[string, string, string | null]> = [];
  const reserved = new Set(rules.reserved_section_names);

  if (rules.scope_detection.generic_single_section_person_scope && sectionPath.length === 1) {
    const top = sectionPath[0]!.trim();
    if (!reserved.has(top.toLowerCase())) {
      scope = "user";
      scopeKey = slugify(top);
      mentions.push(["person", scopeKey, "subject"]);
    }
  }

  const haystack = `${joined}\n${lower}`;
  for (const projectRule of rules.scope_detection.project_rules) {
    if (projectRule.match_any.some((token) => haystack.includes(token.toLowerCase()))) {
      scope = projectRule.scope;
      scopeKey = projectRule.scope_key;
      const mention = projectRule.mention;
      if (
        !mentions.some((m) => m[0] === mention[0] && m[1] === mention[1] && m[2] === mention[2])
      ) {
        mentions.push([mention[0], mention[1], mention[2]]);
      }
      break;
    }
  }

  return { scope, scopeKey, mentions };
}

function classifySection(
  sectionPath: string[],
  title: string,
  content: string,
  tags: string[],
  rules: MigrationRulesConfig,
) {
  const top = sectionPath[0]?.toLowerCase() ?? "";
  const reserved = new Set(rules.reserved_section_names);
  let kind = rules.section_kind_rules[top] ?? "fact";
  if (!rules.section_kind_rules[top] && content.toLowerCase().includes("prefer"))
    kind = "preference";
  else if (!rules.section_kind_rules[top] && sectionPath.length === 1 && !reserved.has(top))
    kind = "person";

  let importance = rules.section_defaults.importance;
  let pinned = rules.section_defaults.pinned;
  let durable = rules.section_defaults.durable;
  const visibility = rules.section_defaults.visibility;

  for (const [key, value] of Object.entries(rules.section_kind_overrides[kind] ?? {})) {
    if (key === "importance") importance = Number(value);
    if (key === "pinned") pinned = Number(value);
    if (key === "durable") durable = Number(value);
  }
  for (const [key, value] of Object.entries(rules.section_name_overrides[top] ?? {})) {
    if (key === "importance") importance = Number(value);
    if (key === "pinned") pinned = Number(value);
    if (key === "durable") durable = Number(value);
  }

  const sensitivity = detectSensitivity(content, rules, title, kind);
  return { kind, importance, pinned, durable, visibility, sensitivity };
}

function classifyAtomicBullet(
  sectionPath: string[],
  bullet: string,
  parentKind: string,
  parentTags: string[],
  rules: MigrationRulesConfig,
) {
  const top = sectionPath[0]?.toLowerCase() ?? "";
  const reserved = new Set(rules.reserved_section_names);
  const cfg = rules.atomic_rules;
  const keyMatch = bullet.match(/^([^:]+):\s*(.*)$/);
  const key = keyMatch?.[1]?.trim() ?? null;
  const value = keyMatch?.[2]?.trim() ?? null;
  const keyLower = key?.toLowerCase() ?? "";

  let kind = parentKind;
  let importance = 70;
  let pinned = 0;
  let durable = 1;
  const visibility = cfg.default_visibility;

  if (cfg.section_kind_map[top]) {
    const mapped = cfg.section_kind_map[top]!;
    kind = String(mapped.kind ?? kind);
    importance = Number(mapped.importance ?? importance);
    pinned = Number(mapped.pinned ?? pinned);
  } else if (sectionPath.length === 1 && !reserved.has(top)) {
    kind = "person";
    importance = 80;
  }

  if (
    cfg.secret_key_names.includes(keyLower) ||
    cfg.secret_key_contains.some((token) => keyLower.includes(token))
  ) {
    kind = "credential_ref";
    importance = cfg.credential_importance;
    pinned = 1;
  } else if (cfg.identifier_key_contains.some((token) => keyLower.includes(token))) {
    if (top === "tools / accounts / environment notes") {
      kind = "fact";
      importance = Math.max(importance, cfg.tools_identifier_importance);
    } else {
      importance = Math.max(importance, 80);
    }
  } else if (cfg.person_identity_keys.includes(keyLower)) {
    if (sectionPath.length === 1 && !reserved.has(top) && top !== "people") {
      kind = "person";
      importance = Math.max(importance, cfg.person_identity_importance);
    }
  } else if (cfg.high_value_project_keys.includes(keyLower)) {
    importance = Math.max(importance, cfg.project_value_importance);
  } else if (top === "tools / accounts / environment notes") {
    importance = Math.max(importance, cfg.tools_default_importance);
  }

  const tags = [...new Set([...parentTags, ...(key ? [slugify(key)] : [])])];
  const sensitivity = detectSensitivity(bullet, rules, sectionPath.join(" / "), kind);
  return {
    kind,
    importance,
    pinned,
    durable,
    visibility,
    sensitivity,
    summary: bullet.slice(0, 240),
    metadata: {
      migration: MIGRATION_VERSION,
      atomic: true,
      parsed_key: key,
      parsed_value: value,
    },
    tags,
  };
}

function parseSessionHeader(text: string) {
  return {
    sessionKey: text.match(/\*\*Session Key\*\*:\s*(.+)/)?.[1]?.trim() ?? null,
    sessionId: text.match(/\*\*Session ID\*\*:\s*(.+)/)?.[1]?.trim() ?? null,
    source: text.match(/\*\*Source\*\*:\s*(.+)/)?.[1]?.trim() ?? null,
  };
}

export async function importMarkdownMemory(options: {
  workspacePath: string;
  rules: MigrationRulesConfig;
}): Promise<MarkdownImportResult> {
  const workspacePath = path.resolve(options.workspacePath);
  const memoryMdPath = path.join(workspacePath, "MEMORY.md");
  const memoryDir = path.join(workspacePath, "memory");
  const memoryMdText = await fs.readFile(memoryMdPath, "utf8");
  const memoryMdStat = await fs.stat(memoryMdPath);
  const baseCreated = toIsoFromMs(memoryMdStat.mtimeMs);

  const records: ImportedMemoryRecord[] = [];
  const links: ImportedMemoryLink[] = [];
  const sessions: ImportedSessionRun[] = [];

  for (const section of splitMemoryMarkdownSections(memoryMdText)) {
    const block = section.contentLines.join("\n").trim();
    if (!block) continue;
    const title = section.path.join(" / ");
    const bullets = parseBullets(block);
    const parentTags = [...section.path.map((p) => slugify(p)), "section-memory", "imported"];
    const scopeInfo = inferScopeAndMentions(title, section.path, block, options.rules);
    const sectionInfo = classifySection(section.path, title, block, parentTags, options.rules);
    const parentId = `mem_${slugify(title)}`;
    const summary = (bullets[0] ?? block.split(/\r?\n/)[0] ?? "").slice(0, 240);

    records.push({
      id: parentId,
      created_at: baseCreated,
      updated_at: baseCreated,
      kind: sectionInfo.kind,
      status: "active",
      scope: scopeInfo.scope,
      scope_key: scopeInfo.scopeKey,
      visibility: sectionInfo.visibility,
      sensitivity: sectionInfo.sensitivity,
      title,
      content: block,
      content_format: "markdown",
      summary,
      importance: sectionInfo.importance,
      confidence: 1,
      pinned: sectionInfo.pinned,
      durable: sectionInfo.durable,
      source_type: "file",
      source_ref: "MEMORY.md",
      source_excerpt: summary,
      author_type: "assistant",
      author_id: "yuki",
      session_id: null,
      parent_memory_id: null,
      checksum: sha256Text(`MEMORY.md::${title}::${block}::${MIGRATION_VERSION}::section`),
      metadata_json: JSON.stringify({
        migration: MIGRATION_VERSION,
        source_file: "MEMORY.md",
        section_path: section.path,
        bullet_count: bullets.length,
        atomic_children: bullets.length,
        record_role: "section",
      }),
      tags: [...new Set(parentTags)],
      mentions: scopeInfo.mentions,
    });

    bullets.forEach((bullet, index) => {
      const atomicId = `${parentId}__b${String(index + 1).padStart(3, "0")}`;
      const atomicTitle = `${title} :: ${bullet.slice(0, 80)}`;
      const atomicInfo = classifyAtomicBullet(
        section.path,
        bullet,
        sectionInfo.kind,
        parentTags,
        options.rules,
      );
      const bulletScope = inferScopeAndMentions(atomicTitle, section.path, bullet, options.rules);
      const mentions = [...scopeInfo.mentions];
      for (const mention of bulletScope.mentions) {
        if (
          !mentions.some((m) => m[0] === mention[0] && m[1] === mention[1] && m[2] === mention[2])
        ) {
          mentions.push(mention);
        }
      }

      records.push({
        id: atomicId,
        created_at: baseCreated,
        updated_at: baseCreated,
        kind: atomicInfo.kind,
        status: "active",
        scope: bulletScope.scope !== "global" ? bulletScope.scope : scopeInfo.scope,
        scope_key: bulletScope.scope !== "global" ? bulletScope.scopeKey : scopeInfo.scopeKey,
        visibility: atomicInfo.visibility,
        sensitivity: atomicInfo.sensitivity,
        title: atomicTitle,
        content: bullet,
        content_format: "markdown",
        summary: atomicInfo.summary,
        importance: atomicInfo.importance,
        confidence: 1,
        pinned: atomicInfo.pinned,
        durable: atomicInfo.durable,
        source_type: "file",
        source_ref: "MEMORY.md",
        source_excerpt: bullet.slice(0, 240),
        author_type: "assistant",
        author_id: "yuki",
        session_id: null,
        parent_memory_id: parentId,
        checksum: sha256Text(
          `MEMORY.md::${title}::${bullet}::${index + 1}::${MIGRATION_VERSION}::atomic`,
        ),
        metadata_json: JSON.stringify({
          ...atomicInfo.metadata,
          source_file: "MEMORY.md",
          section_path: section.path,
          bullet_index: index + 1,
          record_role: "atomic-bullet",
        }),
        tags: atomicInfo.tags,
        mentions,
      });

      links.push({
        id: `lnk_${atomicId}_to_${parentId}`,
        from_memory_id: atomicId,
        to_memory_id: parentId,
        relation: "belongs_to",
        weight: 1,
        created_at: baseCreated,
        metadata_json: JSON.stringify({ migration: MIGRATION_VERSION }),
      });
      links.push({
        id: `lnk_${parentId}_to_${atomicId}`,
        from_memory_id: parentId,
        to_memory_id: atomicId,
        relation: "has_part",
        weight: 1,
        created_at: baseCreated,
        metadata_json: JSON.stringify({ migration: MIGRATION_VERSION }),
      });
    });
  }

  let memoryFiles: string[] = [];
  try {
    memoryFiles = (await fs.readdir(memoryDir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    memoryFiles = [];
  }

  for (const file of memoryFiles) {
    const filePath = path.join(memoryDir, file);
    const text = await fs.readFile(filePath, "utf8");
    const stat = await fs.stat(filePath);
    const createdAt = toIsoFromMs(stat.mtimeMs);
    const rel = path.join("memory", file).replace(/\\/g, "/");

    if (text.startsWith("# Session:")) {
      const header = parseSessionHeader(text);
      const sid = header.sessionId ?? `session_${slugify(path.basename(file, ".md"))}`;
      sessions.push({
        id: sid,
        started_at: createdAt,
        ended_at: createdAt,
        agent: "main",
        model: null,
        chat_id: header.sessionKey,
        chat_type: header.sessionKey?.includes(":direct:") ? "direct" : null,
        user_id: header.sessionKey?.includes("8241756142") ? "8241756142" : null,
        channel: header.source,
        title: path.basename(file, ".md"),
        cwd: workspacePath,
        metadata_json: JSON.stringify({ migration: MIGRATION_VERSION, source_file: rel }),
      });
      records.push({
        id: `mem_${slugify(path.basename(file, ".md"))}`,
        created_at: createdAt,
        updated_at: createdAt,
        kind: "summary",
        status: "active",
        scope: "session",
        scope_key: sid,
        visibility: "private",
        sensitivity: detectSensitivity(text, options.rules, `Session summary: ${file}`, "summary"),
        title: `Session summary: ${path.basename(file, ".md")}`,
        content: text.trim(),
        content_format: "markdown",
        summary: "Imported session summary from markdown daily memory.",
        importance: 55,
        confidence: 1,
        pinned: 0,
        durable: 0,
        source_type: "file",
        source_ref: rel,
        source_excerpt: `Session summary: ${path.basename(file, ".md")}`,
        author_type: "assistant",
        author_id: "yuki",
        session_id: sid,
        parent_memory_id: null,
        checksum: sha256Text(`${rel}::${text.trim()}::${MIGRATION_VERSION}`),
        metadata_json: JSON.stringify({
          migration: MIGRATION_VERSION,
          kind_hint: "session-summary",
        }),
        tags: ["daily-note", "session-summary", "imported"],
        mentions: options.rules.daily_rules.session_summary_mentions as Array<
          [string, string, string | null]
        >,
      });
    } else {
      const lower = text.toLowerCase();
      const mentions: Array<[string, string, string | null]> = [];
      for (const mentionRule of options.rules.daily_rules.daily_note_content_mentions) {
        if (mentionRule.match_any.some((token) => lower.includes(token.toLowerCase()))) {
          mentions.push([mentionRule.mention[0], mentionRule.mention[1], mentionRule.mention[2]]);
        }
      }
      records.push({
        id: `mem_${slugify(path.basename(file, ".md"))}`,
        created_at: createdAt,
        updated_at: createdAt,
        kind: "note",
        status: "active",
        scope: "chat",
        scope_key: "telegram:8241756142",
        visibility: "private",
        sensitivity: detectSensitivity(text, options.rules, `Daily notes: ${file}`, "note"),
        title: `Daily notes: ${path.basename(file, ".md")}`,
        content: text.trim(),
        content_format: "markdown",
        summary: "Imported daily note from markdown memory.",
        importance: 50,
        confidence: 1,
        pinned: 0,
        durable: 0,
        source_type: "file",
        source_ref: rel,
        source_excerpt: `Daily notes: ${path.basename(file, ".md")}`,
        author_type: "assistant",
        author_id: "yuki",
        session_id: null,
        parent_memory_id: null,
        checksum: sha256Text(`${rel}::${text.trim()}::${MIGRATION_VERSION}`),
        metadata_json: JSON.stringify({ migration: MIGRATION_VERSION, kind_hint: "daily-note" }),
        tags: ["daily-note", "imported"],
        mentions,
      });
    }
  }

  const sectionRecords = records.filter(
    (r) => r.parent_memory_id == null && r.source_ref === "MEMORY.md",
  ).length;
  const atomicRecords = records.filter((r) => r.parent_memory_id != null).length;
  const dailyRecords = records.filter((r) => r.source_ref !== "MEMORY.md").length;

  return {
    sessions,
    records,
    links,
    summary: {
      recordsTotal: records.length,
      sectionRecords,
      atomicRecords,
      dailyRecords,
      sessions: sessions.length,
      links: links.length,
    },
  };
}
