.headers on
.mode column
.timeout 5000

SELECT 'memories_total' AS metric, COUNT(*) AS value FROM memories;
SELECT 'memory_links_total' AS metric, COUNT(*) AS value FROM memory_links;
SELECT 'memory_mentions_total' AS metric, COUNT(*) AS value FROM memory_mentions;
SELECT 'memory_tags_total' AS metric, COUNT(*) AS value FROM memory_tags;

SELECT scope, COALESCE(scope_key, '') AS scope_key, COUNT(*) AS row_count
FROM memories
GROUP BY scope, scope_key
ORDER BY row_count DESC, scope, scope_key;

SELECT kind, COUNT(*) AS row_count
FROM memories
WHERE scope = 'project' AND scope_key = 'openclawPM'
GROUP BY kind
ORDER BY row_count DESC, kind;

SELECT id, kind, scope, COALESCE(scope_key, '') AS scope_key, title, source_ref
FROM memories
WHERE scope = 'project' AND scope_key = 'openclawPM'
ORDER BY created_at, id;

SELECT m.id, m.title, m.source_ref, mm.entity_type, mm.entity_key, COALESCE(mm.role, '') AS role
FROM memories m
JOIN memory_mentions mm ON mm.memory_id = m.id
WHERE mm.entity_type = 'project' AND mm.entity_key = 'openclawPM'
ORDER BY m.created_at, m.id;

SELECT relation, COUNT(*) AS row_count
FROM memory_links
WHERE from_memory_id LIKE 'mem_ongoing-projects-openclawpm%'
   OR to_memory_id LIKE 'mem_ongoing-projects-openclawpm%'
GROUP BY relation
ORDER BY relation;

SELECT id, title, source_ref
FROM memories
WHERE source_ref LIKE 'memory/%'
  AND LOWER(content) LIKE '%openclawpm%'
ORDER BY source_ref, id;

SELECT id, title, sensitivity, source_ref
FROM memories
WHERE scope = 'project'
  AND scope_key = 'openclawPM'
  AND sensitivity <> 'normal'
ORDER BY created_at, id;

SELECT id, title, source_ref, json_extract(metadata_json, '$.section_path[0]') AS section_root
FROM memories
WHERE scope = 'project' AND scope_key = 'openclawPM'
ORDER BY id;
