import { describe, expect, it } from "vitest";
import { loadMigrationRulesConfig } from "../src/memory/config/loaders.js";
import { importMarkdownMemory } from "../src/memory/import/import-markdown-memory.js";

const workspacePath = "/home/smca-tech/.openclaw/workspace";

describe("importMarkdownMemory", () => {
  it("imports the current workspace markdown corpus into section, atomic, and daily records", async () => {
    const rules = await loadMigrationRulesConfig();
    const result = await importMarkdownMemory({ workspacePath, rules });

    expect(result.summary.recordsTotal).toBeGreaterThan(50);
    expect(result.summary.sectionRecords).toBe(10);
    expect(result.summary.atomicRecords).toBe(48);
    expect(result.summary.sessions).toBeGreaterThanOrEqual(2);
    expect(result.summary.links).toBe(96);

    const witchySecret = result.records.find(
      (row) => row.id === "mem_long-term-project-context-witchy-intentions__b006",
    );
    expect(witchySecret).toBeDefined();
    expect(witchySecret?.kind).toBe("credential_ref");
    expect(witchySecret?.sensitivity).toBe("secret");
    expect(witchySecret?.scope).toBe("project");
    expect(witchySecret?.scope_key).toBe("witchy-intentions");
  });
});
