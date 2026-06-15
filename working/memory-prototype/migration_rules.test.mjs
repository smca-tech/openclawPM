import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const scriptPath = join(__dirname, "migrate_markdown_memory_v2.py");
const rulesPath = join(__dirname, "migration_rules.json");
const tempRulesPath = join(__dirname, "migration_rules.test.tmp.json");

function runDry(rulesFile = rulesPath) {
  const out = execFileSync("python3", [scriptPath, "--dry-run", "--rules", rulesFile], {
    encoding: "utf8",
    cwd: __dirname,
  });
  return JSON.parse(out);
}

describe("migration rule behavior", () => {
  it("uses externalized rules and preserves current baseline summary", () => {
    const result = runDry();
    expect(result.rules_version).toBe("markdown-memory-v2-rules");
    expect(result.records_total).toBe(61);
    expect(result.atomic_records).toBe(48);
    expect(result.section_records).toBe(10);
    expect(result.links_total).toBe(96);
    expect(result.kinds.credential_ref).toBe(5);
    expect(result.kinds.fact).toBe(14);
    expect(result.sensitivity.normal).toBe(53);
    expect(result.sensitivity.secret).toBe(8);
  });

  it("changing section kind mapping in config changes output behavior", () => {
    const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
    rules.section_kind_rules["tools / accounts / environment notes"] = "fact";
    writeFileSync(tempRulesPath, JSON.stringify(rules, null, 2));

    try {
      const result = runDry(tempRulesPath);
      expect(result.kinds.fact).toBeGreaterThan(14);
      expect(result.kinds.note).toBeLessThan(6);
    } finally {
      unlinkSync(tempRulesPath);
    }
  });

  it("changing sensitivity markers in config changes secret counts", () => {
    const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
    rules.sensitivity_rules.secret_markers = ["api key:", "api secret:"];
    writeFileSync(tempRulesPath, JSON.stringify(rules, null, 2));

    try {
      const result = runDry(tempRulesPath);
      expect(result.sensitivity.secret).toBeLessThan(8);
      expect(result.sensitivity.normal).toBeGreaterThan(53);
    } finally {
      unlinkSync(tempRulesPath);
    }
  });
});
