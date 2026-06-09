import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = "/home/smca-tech/.openclaw/workspace/projects/openclawPM";
const prototypeDir = join(repoRoot, "working", "memory-prototype");
const scriptPath = join(prototypeDir, "migrate_markdown_memory_v2.py");
const rulesPath = join(prototypeDir, "migration_rules.json");
const tempRulesPath = join(prototypeDir, "migration_rules.test.tmp.json");

function runDry(rulesFile = rulesPath) {
  const out = execFileSync("python3", [scriptPath, "--dry-run", "--rules", rulesFile], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  return JSON.parse(out);
}

function queryRow(sql: string) {
  const out = execFileSync(
    "sqlite3",
    ["/home/smca-tech/.openclaw/workspace/memory-db/openclaw-memory.sqlite", "-json", sql],
    {
      encoding: "utf8",
      cwd: repoRoot,
    },
  );
  return JSON.parse(out);
}

function writeTempRules(mutator: (rules: any) => void) {
  const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
  mutator(rules);
  writeFileSync(tempRulesPath, JSON.stringify(rules, null, 2));
}

function cleanupTempRules() {
  if (existsSync(tempRulesPath)) {
    unlinkSync(tempRulesPath);
  }
}

describe("memory prototype migration rule behavior", () => {
  it("uses externalized rules and preserves current baseline summary", () => {
    const result = runDry();
    expect(result.rules_version).toBe("markdown-memory-v2-rules");
    expect(result.records_total).toBe(62);
    expect(result.atomic_records).toBe(48);
    expect(result.section_records).toBe(10);
    expect(result.links_total).toBe(96);
    expect(result.kinds.credential_ref).toBe(5);
    expect(result.kinds.fact).toBe(14);
    expect(result.kinds.note).toBe(7);
    expect(result.sensitivity.normal).toBe(54);
    expect(result.sensitivity.secret).toBe(8);
  });

  it("preserves expected row-level classification for representative records", () => {
    const rows = queryRow(
      "SELECT id, kind, sensitivity, scope, scope_key FROM memories WHERE id IN ('mem_long-term-project-context-witchy-intentions__b006','mem_tools-accounts-environment-notes__b005','mem_preferences__b001') ORDER BY id;",
    );
    const byId = Object.fromEntries(rows.map((row: any) => [row.id, row]));

    expect(byId["mem_long-term-project-context-witchy-intentions__b006"]).toMatchObject({
      kind: "credential_ref",
      sensitivity: "secret",
      scope: "project",
      scope_key: "witchy-intentions",
    });
    expect(byId["mem_tools-accounts-environment-notes__b005"]).toMatchObject({
      kind: "fact",
      sensitivity: "normal",
    });
    expect(byId["mem_preferences__b001"]).toMatchObject({
      kind: "preference",
      sensitivity: "normal",
    });
  });

  it("changing section kind mapping in config changes output behavior", () => {
    writeTempRules((rules) => {
      rules.section_kind_rules["tools / accounts / environment notes"] = "fact";
    });

    try {
      const result = runDry(tempRulesPath);
      expect(result.kinds.fact).toBeGreaterThan(14);
      expect(result.kinds.note).toBeLessThan(7);
    } finally {
      cleanupTempRules();
    }
  });

  it("changing sensitivity markers in config changes secret counts", () => {
    writeTempRules((rules) => {
      rules.sensitivity_rules.secret_markers = ["api key:", "api secret:"];
    });

    try {
      const result = runDry(tempRulesPath);
      expect(result.sensitivity.secret).toBeLessThan(8);
      expect(result.sensitivity.normal).toBeGreaterThan(54);
    } finally {
      cleanupTempRules();
    }
  });

  it("disabling generic single-section person scope does not crash dry-run behavior", () => {
    writeTempRules((rules) => {
      rules.scope_detection.generic_single_section_person_scope = false;
    });

    try {
      const result = runDry(tempRulesPath);
      expect(result.records_total).toBe(62);
      expect(result.atomic_records).toBe(48);
    } finally {
      cleanupTempRules();
    }
  });

  it("removing project scope aliases does not change classification counts by itself", () => {
    writeTempRules((rules) => {
      rules.scope_detection.project_rules = [];
    });

    try {
      const result = runDry(tempRulesPath);
      expect(result.kinds.project).toBe(12);
      expect(result.records_total).toBe(62);
    } finally {
      cleanupTempRules();
    }
  });

  it("promoting identifier markers to secret increases secret counts", () => {
    writeTempRules((rules) => {
      rules.sensitivity_rules.secret_markers = [
        ...rules.sensitivity_rules.secret_markers,
        "username:",
        "email:",
      ];
    });

    try {
      const result = runDry(tempRulesPath);
      expect(result.sensitivity.secret).toBeGreaterThan(8);
    } finally {
      cleanupTempRules();
    }
  });

  it("rejects invalid migration config shape", () => {
    writeTempRules((rules) => {
      delete rules.section_defaults.visibility;
    });

    try {
      expect(() => runDry(tempRulesPath)).toThrow();
    } finally {
      cleanupTempRules();
    }
  });
});
