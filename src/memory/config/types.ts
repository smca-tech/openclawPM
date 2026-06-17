export interface MigrationRulesConfig {
  version: string;
  reserved_section_names: string[];
  scope_detection: {
    generic_single_section_person_scope: boolean;
    project_rules: Array<{
      match_any: string[];
      scope: string;
      scope_key: string;
      mention: [string, string, string];
    }>;
  };
  sensitivity_rules: {
    force_normal_kind_hints: string[];
    secret_markers: string[];
    secret_presence_markers: string[];
    sensitive_markers: string[];
    sensitive_when_kind: string[];
    special_title_sensitive_rules: Array<{
      title_contains: string;
      content_contains: string;
      sensitivity: string;
    }>;
  };
  section_kind_rules: Record<string, string>;
  section_defaults: {
    importance: number;
    pinned: number;
    durable: number;
    visibility: string;
  };
  section_kind_overrides: Record<string, Record<string, number>>;
  section_name_overrides: Record<string, Record<string, number>>;
  atomic_rules: {
    section_kind_map: Record<string, Record<string, string | number>>;
    secret_key_names: string[];
    secret_key_contains: string[];
    identifier_key_contains: string[];
    person_identity_keys: string[];
    high_value_project_keys: string[];
    tools_identifier_importance: number;
    tools_default_importance: number;
    credential_importance: number;
    person_identity_importance: number;
    project_value_importance: number;
    default_visibility: string;
  };
  daily_rules: {
    session_summary_mentions: unknown[];
    daily_note_content_mentions: Array<{
      match_any: string[];
      mention: [string, string, string];
    }>;
  };
}

export interface RecallPresetsConfig {
  version: string;
  bucket_order: string[];
  bucket_bonus: Record<string, number>;
  strategies: Record<string, Record<string, unknown>>;
  presets: Record<string, { bucket_strategies: Record<string, string> }>;
}

export interface WriteHeuristicsConfig {
  version: string;
  remember: {
    default_visibility: string;
    content_format: string;
    summary_max_chars: number;
    id_prefix: string;
    id_hash_length: number;
    checksum_fields: string[];
    dedupe_active_only: boolean;
    event_actor_id: string;
    event_type: string;
    event_source_details: string[];
  };
  supersede: {
    status: string;
    link_relation: string;
    link_weight: number;
    metadata_created_by: string;
  };
  update: {
    summary_max_chars: number;
    merge_tags: boolean;
    merge_mentions: boolean;
    preserve_existing_non_null: boolean;
    touch_updated_at: boolean;
    recompute_checksum: boolean;
    require_version_match: boolean;
    version_field: string;
    event_type: string;
    event_actor_id: string;
  };
}
