import { z } from "zod";

export const migrationRulesSchema = z.object({
  version: z.string(),
  reserved_section_names: z.array(z.string()),
  scope_detection: z.object({
    generic_single_section_person_scope: z.boolean(),
    project_rules: z.array(
      z.object({
        match_any: z.array(z.string()),
        scope: z.string(),
        scope_key: z.string(),
        mention: z.tuple([z.string(), z.string(), z.string()]),
      }),
    ),
  }),
  sensitivity_rules: z.object({
    force_normal_kind_hints: z.array(z.string()),
    secret_markers: z.array(z.string()),
    secret_presence_markers: z.array(z.string()),
    sensitive_markers: z.array(z.string()),
    sensitive_when_kind: z.array(z.string()),
    special_title_sensitive_rules: z.array(
      z.object({
        title_contains: z.string(),
        content_contains: z.string(),
        sensitivity: z.string(),
      }),
    ),
  }),
  section_kind_rules: z.record(z.string(), z.string()),
  section_defaults: z.object({
    importance: z.number(),
    pinned: z.number(),
    durable: z.number(),
    visibility: z.string(),
  }),
  section_kind_overrides: z.record(z.string(), z.record(z.string(), z.number())),
  section_name_overrides: z.record(z.string(), z.record(z.string(), z.number())),
  atomic_rules: z.object({
    section_kind_map: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number()]))),
    secret_key_names: z.array(z.string()),
    secret_key_contains: z.array(z.string()),
    identifier_key_contains: z.array(z.string()),
    person_identity_keys: z.array(z.string()),
    high_value_project_keys: z.array(z.string()),
    tools_identifier_importance: z.number(),
    tools_default_importance: z.number(),
    credential_importance: z.number(),
    person_identity_importance: z.number(),
    project_value_importance: z.number(),
    default_visibility: z.string(),
  }),
  daily_rules: z.object({
    session_summary_mentions: z.array(z.any()),
    daily_note_content_mentions: z.array(
      z.object({
        match_any: z.array(z.string()),
        mention: z.tuple([z.string(), z.string(), z.string()]),
      }),
    ),
  }),
});

export const recallPresetsSchema = z.object({
  version: z.string(),
  bucket_order: z.array(z.string()),
  bucket_bonus: z.record(z.string(), z.number()),
  filter_bundles: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  strategies: z.record(z.string(), z.record(z.string(), z.any())),
  presets: z.record(
    z.string(),
    z.object({
      bucket_strategies: z.record(
        z.string(),
        z.union([
          z.string(),
          z.object({
            strategy: z.string(),
            filter_bundles: z.array(z.string()).optional(),
            filters: z.record(z.string(), z.any()).optional(),
          }),
        ]),
      ),
    }),
  ),
});

export const writeHeuristicsSchema = z.object({
  version: z.string(),
  remember: z.object({
    default_visibility: z.string(),
    content_format: z.string(),
    summary_max_chars: z.number(),
    id_prefix: z.string(),
    id_hash_length: z.number(),
    checksum_fields: z.array(z.string()),
    dedupe_active_only: z.boolean(),
    event_actor_id: z.string(),
    event_type: z.string(),
    event_source_details: z.array(z.string()),
  }),
  supersede: z.object({
    status: z.string(),
    link_relation: z.string(),
    link_weight: z.number(),
    metadata_created_by: z.string(),
  }),
  update: z.object({
    summary_max_chars: z.number(),
    merge_tags: z.boolean(),
    merge_mentions: z.boolean(),
    preserve_existing_non_null: z.boolean(),
    touch_updated_at: z.boolean(),
    recompute_checksum: z.boolean(),
    require_version_match: z.boolean(),
    version_field: z.string(),
    event_type: z.string(),
    event_actor_id: z.string(),
  }),
});
