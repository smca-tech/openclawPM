import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = "/home/smca-tech/.openclaw/workspace/projects/openclawPM";
const prototypeDir = join(repoRoot, "working", "memory-prototype");
const sourceDb = "/home/smca-tech/.openclaw/workspace/memory-db/openclaw-memory.sqlite";
const managerPath = join(prototypeDir, "memory_manager.py");
const presetsPath = join(prototypeDir, "recall_presets.json");
const tempPresetsPath = join(prototypeDir, "recall_presets.test.tmp.json");
const writeHeuristicsPath = join(prototypeDir, "write_heuristics.json");
const tempWriteHeuristicsPath = join(prototypeDir, "write_heuristics.test.tmp.json");

function withTempDb<T>(fn: (dbPath: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-memory-test-"));
  const dbPath = join(tempDir, "openclaw-memory.sqlite");
  cpSync(sourceDb, dbPath);
  try {
    return fn(dbPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runPythonSnippet(
  dbPath: string,
  code: string,
  presetFile = presetsPath,
  writeHeuristicsFile = writeHeuristicsPath,
) {
  const out = execFileSync(
    "python3",
    ["-c", code, dbPath, managerPath, presetFile, writeHeuristicsFile],
    {
      encoding: "utf8",
      cwd: repoRoot,
    },
  );
  return JSON.parse(out);
}

function writeTempPresets(mutator: (rules: any) => void) {
  const presets = JSON.parse(readFileSync(presetsPath, "utf8"));
  mutator(presets);
  writeFileSync(tempPresetsPath, JSON.stringify(presets, null, 2));
}

function cleanupTempPresets() {
  if (existsSync(tempPresetsPath)) {
    rmSync(tempPresetsPath, { force: true });
  }
}

function writeTempWriteHeuristics(mutator: (rules: any) => void) {
  const heuristics = JSON.parse(readFileSync(writeHeuristicsPath, "utf8"));
  mutator(heuristics);
  writeFileSync(tempWriteHeuristicsPath, JSON.stringify(heuristics, null, 2));
}

function cleanupTempWriteHeuristics() {
  if (existsSync(tempWriteHeuristicsPath)) {
    rmSync(tempWriteHeuristicsPath, { force: true });
  }
}

const PY_IMPORT = `
import importlib.util, json, sqlite3, sys

db_path = sys.argv[1]
manager_path = sys.argv[2]
preset_path = sys.argv[3]
write_heuristics_path = sys.argv[4]
spec = importlib.util.spec_from_file_location('memory_manager', manager_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
manager = mod.MemoryManager(db_path, preset_path, write_heuristics_path)
`;

describe("memory prototype recall presets", () => {
  it("dm preset returns a richer merged set than group preset", () => {
    withTempDb((dbPath) => {
      const dm = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='test-dm',
    chat_id='telegram:8241756142',
    user_id='8241756142',
    user_key='johnny',
    agent_key='yuki-mori',
    project_key='openclawPM',
    preset='dm',
    mentioned_entities=[('person', 'johnny'), ('project', 'openclawPM')],
)
manager.register_session(ctx)
print(json.dumps(manager.startup_hydrate(ctx), default=list))
      `,
      );
      const group = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='test-group',
    chat_id='telegram:group:test',
    user_id='8241756142',
    agent_key='yuki-mori',
    preset='group',
)
manager.register_session(ctx)
print(json.dumps(manager.startup_hydrate(ctx), default=list))
      `,
      );
      expect(dm.merged.length).toBeGreaterThan(group.merged.length);
      expect(group.merged.every((row: any) => row.sensitivity === "normal")).toBe(true);
    });
  });

  it("admin preset can include secret rows while dm default does not", () => {
    withTempDb((dbPath) => {
      const dm = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='test-dm-secret',
    chat_id='telegram:8241756142',
    user_id='8241756142',
    user_key='johnny',
    agent_key='yuki-mori',
    project_key='witchy-intentions',
    preset='dm',
)
manager.register_session(ctx)
print(json.dumps(manager.startup_hydrate(ctx), default=list))
      `,
      );
      const admin = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='test-admin-secret',
    chat_id='telegram:8241756142',
    user_id='8241756142',
    user_key='johnny',
    agent_key='yuki-mori',
    project_key='witchy-intentions',
    preset='admin',
    include_secret=True,
)
manager.register_session(ctx)
print(json.dumps(manager.startup_hydrate(ctx), default=list))
      `,
      );
      expect(dm.merged.some((row: any) => row.sensitivity === "secret")).toBe(false);
      expect(admin.merged.some((row: any) => row.sensitivity === "secret")).toBe(true);
    });
  });

  it("changing preset bucket strategies in config changes hydration behavior", () => {
    writeTempPresets((presets) => {
      presets.presets.group.bucket_strategies.pinned = "default_pinned";
    });

    try {
      withTempDb((dbPath) => {
        const group = runPythonSnippet(
          dbPath,
          `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='test-group-config',
    chat_id='telegram:group:test',
    user_id='8241756142',
    user_key='johnny',
    agent_key='yuki-mori',
    preset='group',
)
manager.register_session(ctx)
print(json.dumps(manager.startup_hydrate(ctx), default=list))
        `,
          tempPresetsPath,
        );
        expect(group.pinned.length).toBeGreaterThan(0);
      });
    } finally {
      cleanupTempPresets();
    }
  });

  it("changing scoped thresholds in config changes group scoped recall volume", () => {
    writeTempPresets((presets) => {
      presets.strategies.group_scoped.importance_thresholds.project = 95;
      presets.strategies.group_scoped.importance_thresholds.global = 95;
      presets.strategies.group_scoped.importance_thresholds.agent = 95;
    });

    try {
      withTempDb((dbPath) => {
        const group = runPythonSnippet(
          dbPath,
          `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='test-group-thresholds',
    chat_id='telegram:group:test',
    user_id='8241756142',
    agent_key='yuki-mori',
    preset='group',
)
manager.register_session(ctx)
print(json.dumps(manager.startup_hydrate(ctx), default=list))
        `,
          tempPresetsPath,
        );
        expect(group.scoped.length).toBeLessThan(25);
      });
    } finally {
      cleanupTempPresets();
    }
  });

  it("changing recent limit in config changes recent recall size", () => {
    writeTempPresets((presets) => {
      presets.strategies.group_recent.limit = 1;
    });

    try {
      withTempDb((dbPath) => {
        const group = runPythonSnippet(
          dbPath,
          `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='test-group-recent-limit',
    chat_id='telegram:8241756142',
    user_id='8241756142',
    agent_key='yuki-mori',
    preset='group',
)
manager.register_session(ctx)
print(json.dumps(manager.startup_hydrate(ctx), default=list))
        `,
          tempPresetsPath,
        );
        expect(group.recent.length).toBeLessThanOrEqual(1);
      });
    } finally {
      cleanupTempPresets();
    }
  });
});

describe("memory prototype write heuristics", () => {
  it("remember dedupes identical writes by checksum", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='dedupe-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
first = manager.remember(
    title='Duplicate test memory',
    content='same content for dedupe test',
    kind='note',
    scope='session',
    scope_key='dedupe-session',
    session_id='dedupe-session',
    tags=['demo'],
)
second = manager.remember(
    title='Duplicate test memory',
    content='same content for dedupe test',
    kind='note',
    scope='session',
    scope_key='dedupe-session',
    session_id='dedupe-session',
    tags=['demo'],
)
print(json.dumps({'first': first, 'second': second}))
      `,
      );
      expect(result.first).toBe(result.second);
    });
  });

  it("remember persists tags and mentions for new runtime memories", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='tag-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Tagged runtime memory',
    content='runtime memory with tags and mentions',
    kind='note',
    scope='session',
    scope_key='tag-session',
    session_id='tag-session',
    tags=['demo', 'runtime'],
    mentions=[('person', 'user-123', 'subject')],
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT COUNT(*) FROM memory_tags WHERE memory_id = ?', (memory_id,))
tag_count = cur.fetchone()[0]
cur.execute('SELECT COUNT(*) FROM memory_mentions WHERE memory_id = ?', (memory_id,))
mention_count = cur.fetchone()[0]
con.close()
print(json.dumps({'memory_id': memory_id, 'tag_count': tag_count, 'mention_count': mention_count}))
      `,
      );
      expect(result.memory_id).toMatch(/^mem_runtime_/);
      expect(result.tag_count).toBe(2);
      expect(result.mention_count).toBe(1);
    });
  });

  it("changing write heuristics config changes generated runtime memory ids", () => {
    writeTempWriteHeuristics((heuristics) => {
      heuristics.remember.id_prefix = "runtime_mem_";
      heuristics.remember.id_hash_length = 6;
    });

    try {
      withTempDb((dbPath) => {
        const result = runPythonSnippet(
          dbPath,
          `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='heuristic-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Heuristic runtime memory',
    content='heuristic content',
    kind='note',
    scope='session',
    scope_key='heuristic-session',
    session_id='heuristic-session'
)
print(json.dumps({'memory_id': memory_id}))
        `,
          presetsPath,
          tempWriteHeuristicsPath,
        );
        expect(result.memory_id).toMatch(/^runtime_mem_/);
      });
    } finally {
      cleanupTempWriteHeuristics();
    }
  });

  it("rejects invalid recall preset config shape", () => {
    writeTempPresets((presets) => {
      delete presets.bucket_order;
    });

    try {
      withTempDb((dbPath) => {
        expect(() =>
          runPythonSnippet(
            dbPath,
            `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='invalid-recall',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
print(json.dumps({'ok': True}))
        `,
            tempPresetsPath,
          ),
        ).toThrow();
      });
    } finally {
      cleanupTempPresets();
    }
  });

  it("rejects invalid write heuristics config shape", () => {
    writeTempWriteHeuristics((heuristics) => {
      delete heuristics.remember.id_prefix;
    });

    try {
      withTempDb((dbPath) => {
        expect(() =>
          runPythonSnippet(
            dbPath,
            `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='invalid-write',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
print(json.dumps({'ok': True}))
        `,
            presetsPath,
            tempWriteHeuristicsPath,
          ),
        ).toThrow();
      });
    } finally {
      cleanupTempWriteHeuristics();
    }
  });

  it("supersede_memory marks old memory superseded and creates relation link", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='supersede-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
old_id = manager.remember(
    title='Old lifecycle memory',
    content='old content',
    kind='note',
    scope='session',
    scope_key='supersede-session',
    session_id='supersede-session'
)
new_id = manager.remember(
    title='New lifecycle memory',
    content='new content',
    kind='note',
    scope='session',
    scope_key='supersede-session',
    session_id='supersede-session'
)
manager.supersede_memory(old_id, new_id)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT status FROM memories WHERE id = ?', (old_id,))
old_status = cur.fetchone()[0]
cur.execute('SELECT relation FROM memory_links WHERE from_memory_id = ? AND to_memory_id = ?', (new_id, old_id))
relation = cur.fetchone()[0]
con.close()
print(json.dumps({'old_id': old_id, 'new_id': new_id, 'old_status': old_status, 'relation': relation}))
      `,
      );
      expect(result.old_status).toBe("superseded");
      expect(result.relation).toBe("supersedes");
    });
  });

  it("changing supersede config changes status and relation semantics", () => {
    writeTempWriteHeuristics((heuristics) => {
      heuristics.supersede.status = "archived";
      heuristics.supersede.link_relation = "replaces";
      heuristics.supersede.link_weight = 2.5;
    });

    try {
      withTempDb((dbPath) => {
        const result = runPythonSnippet(
          dbPath,
          `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='supersede-config-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
old_id = manager.remember(
    title='Old config lifecycle memory',
    content='old config content',
    kind='note',
    scope='session',
    scope_key='supersede-config-session',
    session_id='supersede-config-session'
)
new_id = manager.remember(
    title='New config lifecycle memory',
    content='new config content',
    kind='note',
    scope='session',
    scope_key='supersede-config-session',
    session_id='supersede-config-session'
)
manager.supersede_memory(old_id, new_id)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT status FROM memories WHERE id = ?', (old_id,))
old_status = cur.fetchone()[0]
cur.execute('SELECT relation, weight FROM memory_links WHERE from_memory_id = ? AND to_memory_id = ?', (new_id, old_id))
relation, weight = cur.fetchone()
con.close()
print(json.dumps({'old_status': old_status, 'relation': relation, 'weight': weight}))
        `,
          presetsPath,
          tempWriteHeuristicsPath,
        );
        expect(result.old_status).toBe("archived");
        expect(result.relation).toBe("replaces");
        expect(result.weight).toBe(2.5);
      });
    } finally {
      cleanupTempWriteHeuristics();
    }
  });

  it("remember does not overwrite an existing active memory with same checksum", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='update-semantics-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
first = manager.remember(
    title='Stable memory title',
    content='stable content',
    kind='note',
    scope='session',
    scope_key='update-semantics-session',
    session_id='update-semantics-session',
    tags=['alpha']
)
second = manager.remember(
    title='Stable memory title',
    content='stable content',
    kind='note',
    scope='session',
    scope_key='update-semantics-session',
    session_id='update-semantics-session',
    tags=['beta']
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT COUNT(*) FROM memory_tags WHERE memory_id = ?', (first,))
tag_count = cur.fetchone()[0]
con.close()
print(json.dumps({'first': first, 'second': second, 'tag_count': tag_count}))
      `,
      );
      expect(result.first).toBe(result.second);
      expect(result.tag_count).toBe(1);
    });
  });

  it("update_memory performs an in-place update of the target row", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='update-memory-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Mutable memory',
    content='old body',
    kind='note',
    scope='session',
    scope_key='update-memory-session',
    session_id='update-memory-session'
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT metadata_json FROM memories WHERE id = ?', (memory_id,))
expected_version = json.loads(cur.fetchone()[0]).get('revision', 0)
con.close()
manager.update_memory(
    memory_id,
    expected_version=expected_version,
    content='new body',
    importance=88,
    session_id='update-memory-session'
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT content, importance FROM memories WHERE id = ?', (memory_id,))
content, importance = cur.fetchone()
con.close()
print(json.dumps({'memory_id': memory_id, 'content': content, 'importance': importance}))
      `,
      );
      expect(result.content).toBe("new body");
      expect(result.importance).toBe(88);
    });
  });

  it("update_memory merges tags and mentions by default", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='update-merge-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Merge target memory',
    content='merge body',
    kind='note',
    scope='session',
    scope_key='update-merge-session',
    session_id='update-merge-session',
    tags=['alpha'],
    mentions=[('person', 'user-a', 'subject')]
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT metadata_json FROM memories WHERE id = ?', (memory_id,))
expected_version = json.loads(cur.fetchone()[0]).get('revision', 0)
con.close()
manager.update_memory(
    memory_id,
    expected_version=expected_version,
    tags=['beta'],
    mentions=[('person', 'user-b', 'subject')],
    session_id='update-merge-session'
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT COUNT(*) FROM memory_tags WHERE memory_id = ?', (memory_id,))
tag_count = cur.fetchone()[0]
cur.execute('SELECT COUNT(*) FROM memory_mentions WHERE memory_id = ?', (memory_id,))
mention_count = cur.fetchone()[0]
con.close()
print(json.dumps({'tag_count': tag_count, 'mention_count': mention_count}))
      `,
      );
      expect(result.tag_count).toBe(2);
      expect(result.mention_count).toBe(2);
    });
  });

  it("update heuristics can switch from merge to replace semantics", () => {
    writeTempWriteHeuristics((heuristics) => {
      heuristics.update.merge_tags = false;
      heuristics.update.merge_mentions = false;
    });

    try {
      withTempDb((dbPath) => {
        const result = runPythonSnippet(
          dbPath,
          `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='update-replace-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Replace target memory',
    content='replace body',
    kind='note',
    scope='session',
    scope_key='update-replace-session',
    session_id='update-replace-session',
    tags=['alpha'],
    mentions=[('person', 'user-a', 'subject')]
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT metadata_json FROM memories WHERE id = ?', (memory_id,))
expected_version = json.loads(cur.fetchone()[0]).get('revision', 0)
con.close()
manager.update_memory(
    memory_id,
    expected_version=expected_version,
    tags=['beta'],
    mentions=[('person', 'user-b', 'subject')],
    session_id='update-replace-session'
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT COUNT(*) FROM memory_tags WHERE memory_id = ?', (memory_id,))
tag_count = cur.fetchone()[0]
cur.execute('SELECT COUNT(*) FROM memory_mentions WHERE memory_id = ?', (memory_id,))
mention_count = cur.fetchone()[0]
con.close()
print(json.dumps({'tag_count': tag_count, 'mention_count': mention_count}))
      `,
          presetsPath,
          tempWriteHeuristicsPath,
        );
        expect(result.tag_count).toBe(1);
        expect(result.mention_count).toBe(1);
      });
    } finally {
      cleanupTempWriteHeuristics();
    }
  });

  it("later updates win when each update provides the current version token", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='stale-update-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Race target memory',
    content='base body',
    kind='note',
    scope='session',
    scope_key='stale-update-session',
    session_id='stale-update-session'
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT metadata_json FROM memories WHERE id = ?', (memory_id,))
first_expected_version = json.loads(cur.fetchone()[0]).get('revision', 0)
con.close()
manager.update_memory(memory_id, expected_version=first_expected_version, content='first update body', session_id='stale-update-session')
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT metadata_json FROM memories WHERE id = ?', (memory_id,))
second_expected_version = json.loads(cur.fetchone()[0]).get('revision', 0)
con.close()
manager.update_memory(memory_id, expected_version=second_expected_version, content='second update body', session_id='stale-update-session')
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT content FROM memories WHERE id = ?', (memory_id,))
content = cur.fetchone()[0]
con.close()
print(json.dumps({'content': content}))
      `,
      );
      expect(result.content).toBe("second update body");
    });
  });

  it("stale updates are rejected when expected_updated_at is outdated", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='stale-reject-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Stale reject memory',
    content='base stale body',
    kind='note',
    scope='session',
    scope_key='stale-reject-session',
    session_id='stale-reject-session'
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT metadata_json FROM memories WHERE id = ?', (memory_id,))
stale_token = json.loads(cur.fetchone()[0]).get('revision', 0)
con.close()
manager.update_memory(memory_id, expected_version=stale_token, content='fresh body', session_id='stale-reject-session')
try:
    manager.update_memory(memory_id, expected_version=stale_token, content='stale body', session_id='stale-reject-session')
    rejected = False
except Exception as e:
    rejected = True
    error = str(e)
print(json.dumps({'rejected': rejected, 'error': error if rejected else ''}))
      `,
      );
      expect(result.rejected).toBe(true);
      expect(result.error).toContain("Stale update");
    });
  });

  it("checksum/content changes produce a new dedupe identity after in-place update", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='checksum-drift-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
original_id = manager.remember(
    title='Checksum drift memory',
    content='original content',
    kind='note',
    scope='session',
    scope_key='checksum-drift-session',
    session_id='checksum-drift-session'
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT metadata_json FROM memories WHERE id = ?', (original_id,))
expected_version = json.loads(cur.fetchone()[0]).get('revision', 0)
con.close()
manager.update_memory(original_id, expected_version=expected_version, content='mutated content', session_id='checksum-drift-session')
repeat_id = manager.remember(
    title='Checksum drift memory',
    content='original content',
    kind='note',
    scope='session',
    scope_key='checksum-drift-session',
    session_id='checksum-drift-session'
)
print(json.dumps({'original_id': original_id, 'repeat_id': repeat_id}))
      `,
      );
      expect(result.original_id).not.toBe(result.repeat_id);
    });
  });

  it("update_memory recomputes checksum when content changes", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='checksum-store-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Checksum store memory',
    content='initial content',
    kind='note',
    scope='session',
    scope_key='checksum-store-session',
    session_id='checksum-store-session'
)
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT checksum FROM memories WHERE id = ?', (memory_id,))
checksum_before = cur.fetchone()[0]
cur.execute('SELECT metadata_json FROM memories WHERE id = ?', (memory_id,))
expected_version = json.loads(cur.fetchone()[0]).get('revision', 0)
con.close()
manager.update_memory(memory_id, expected_version=expected_version, content='changed content', session_id='checksum-store-session')
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute('SELECT checksum, content FROM memories WHERE id = ?', (memory_id,))
checksum_after, content = cur.fetchone()
con.close()
print(json.dumps({'checksum_before': checksum_before, 'checksum_after': checksum_after, 'content': content}))
      `,
      );
      expect(result.content).toBe("changed content");
      expect(result.checksum_before).not.toBe(result.checksum_after);
    });
  });

  it("get_memory_version returns the current optimistic concurrency token", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='helper-version-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Helper version memory',
    content='helper content',
    kind='note',
    scope='session',
    scope_key='helper-version-session',
    session_id='helper-version-session'
)
version = manager.get_memory_version(memory_id)
print(json.dumps({'memory_id': memory_id, 'version': version}))
      `,
      );
      expect(result.version).toBe(0);
    });
  });

  it("read_for_update returns row data plus version, tags, and mentions", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='helper-read-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Helper read memory',
    content='helper read content',
    kind='note',
    scope='session',
    scope_key='helper-read-session',
    session_id='helper-read-session',
    tags=['alpha', 'beta'],
    mentions=[('person', 'user-x', 'subject')]
)
record = manager.read_for_update(memory_id)
print(json.dumps({'version': record['version'], 'tag_count': len(record['tags']), 'mention_count': len(record['mentions']), 'title': record['title']}))
      `,
      );
      expect(result.version).toBe(0);
      expect(result.tag_count).toBe(2);
      expect(result.mention_count).toBe(1);
      expect(result.title).toBe("Helper read memory");
    });
  });

  it("helper workflow supports safe update then stale rejection", () => {
    withTempDb((dbPath) => {
      const result = runPythonSnippet(
        dbPath,
        `${PY_IMPORT}
ctx = mod.build_default_session_context(
    session_id='helper-workflow-session',
    chat_id='telegram:test',
    user_id='user-1',
    preset='dm',
)
manager.register_session(ctx)
memory_id = manager.remember(
    title='Helper workflow memory',
    content='helper workflow content',
    kind='note',
    scope='session',
    scope_key='helper-workflow-session',
    session_id='helper-workflow-session'
)
record = manager.read_for_update(memory_id)
manager.update_memory(memory_id, expected_version=record['version'], content='helper updated content', session_id='helper-workflow-session')
new_version = manager.get_memory_version(memory_id)
try:
    manager.update_memory(memory_id, expected_version=record['version'], content='stale helper content', session_id='helper-workflow-session')
    rejected = False
except Exception as e:
    rejected = True
    error = str(e)
print(json.dumps({'new_version': new_version, 'rejected': rejected, 'error': error if rejected else ''}))
      `,
      );
      expect(result.new_version).toBe(1);
      expect(result.rejected).toBe(true);
      expect(result.error).toContain("Stale update");
    });
  });
});
