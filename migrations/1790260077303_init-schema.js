/* eslint-disable camelcase */

/**
 * Core schema for Trench Trials v1.1 — Unmask (PRD §16).
 *
 * Design notes:
 * - This app connects to Postgres only from the server (Next.js API routes / server
 *   components) using DATABASE_URL. The browser never talks to Postgres directly, so
 *   the primary leakage boundary is the app's stage-specific response allowlists
 *   (src/lib/allowlist.ts), not RLS. RLS is still enabled on sensitive tables below as
 *   defense-in-depth for a Supabase deployment, where it blocks the anon/authenticated
 *   roles by default while the server's own role (service_role, or the table owner)
 *   bypasses it.
 * - Hidden-until-stage columns (token identity, prices, manifest, nonce, source
 *   hashes) live in the same row as public columns rather than a separate table,
 *   because the state machine already gates access at the application layer via
 *   allowlisted SELECT projections — splitting tables would add join complexity
 *   without adding real security, since a compromised query layer bypasses either
 *   design equally.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  // --- players ---------------------------------------------------------
  pgm.createTable('players', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    anon_id: { type: 'text', notNull: true, unique: true },
    auth_id: { type: 'text', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // --- rounds ------------------------------------------------------------
  pgm.createTable('rounds', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    mode: { type: 'text', notNull: true },
    chain: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'draft' },
    cutoff: { type: 'timestamptz', notNull: true },
    horizon_days: { type: 'integer', notNull: true },
    candle_interval: { type: 'text', notNull: true },
    resolution_time: { type: 'timestamptz', notNull: true },
    round_forge_version: { type: 'integer', notNull: true },
    clue_schema_version: { type: 'integer', notNull: true },
    price_policy_version: { type: 'integer', notNull: true },
    decision_window_seconds: { type: 'integer', notNull: true, default: 15 },
    decision_window_version: { type: 'integer', notNull: true, default: 1 },
    // Hidden until verdict. Contains identities, clue inputs, price inputs, source hashes.
    initial_manifest: { type: 'jsonb', notNull: true },
    initial_commitment_hash: { type: 'text', notNull: true },
    initial_nonce: { type: 'text', notNull: true },
    // Live only: appended after real outcome data exists.
    resolution_manifest: { type: 'jsonb' },
    resolution_commitment_hash: { type: 'text' },
    resolution_nonce: { type: 'text' },
    invalid_reason: { type: 'text' },
    repeat_of: { type: 'uuid', references: 'rounds', onDelete: 'SET NULL' },
    eligibility_policy: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    published_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('rounds', 'rounds_mode_check', {
    check: "mode in ('replay','daily','live')",
  });
  pgm.addConstraint('rounds', 'rounds_status_check', {
    check: "status in ('draft','ready','open','resolving','resolved','invalid')",
  });
  pgm.createIndex('rounds', 'status');
  pgm.createIndex('rounds', 'mode');
  pgm.createIndex('rounds', 'cutoff');

  // --- round_assets --------------------------------------------------
  pgm.createTable('round_assets', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    round_id: { type: 'uuid', notNull: true, references: 'rounds', onDelete: 'CASCADE' },
    slot: { type: 'text', notNull: true },
    // Hidden until Unmask.
    token_symbol: { type: 'text', notNull: true },
    token_address: { type: 'text', notNull: true },
    sectors: { type: 'text[]', notNull: true, default: pgm.func("'{}'") },
    // Clues are shown (bucketed) during the blind stage; the numeric value stays
    // server-side, only the bucket label is allowlisted for the blind-stage response.
    clue_buy_sell_balance: { type: 'numeric', notNull: true },
    clue_buy_sell_balance_bucket: { type: 'text', notNull: true },
    clue_trading_acceleration: { type: 'numeric', notNull: true },
    clue_trading_acceleration_bucket: { type: 'text', notNull: true },
    clue_netflow_over_liquidity: { type: 'numeric', notNull: true },
    clue_netflow_over_liquidity_bucket: { type: 'text', notNull: true },
    clue_recent_momentum: { type: 'numeric', notNull: true },
    clue_recent_momentum_bucket: { type: 'text', notNull: true },
    // Hidden until verdict.
    entry_candle_start: { type: 'timestamptz', notNull: true },
    entry_price: { type: 'numeric', notNull: true },
    exit_candle_start: { type: 'timestamptz', notNull: true },
    exit_price: { type: 'numeric', notNull: true },
    return_ratio: { type: 'numeric', notNull: true },
    source_response_sha256: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('round_assets', 'round_assets_slot_check', { check: "slot in ('A','B','C')" });
  pgm.addConstraint('round_assets', 'round_assets_round_slot_unique', {
    unique: ['round_id', 'slot'],
  });
  pgm.addConstraint('round_assets', 'round_assets_prices_positive', {
    check: 'entry_price > 0 AND exit_price > 0',
  });

  // --- attempts ------------------------------------------------------
  pgm.createTable('attempts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    player_id: { type: 'uuid', notNull: true, references: 'players', onDelete: 'CASCADE' },
    round_id: { type: 'uuid', notNull: true, references: 'rounds', onDelete: 'CASCADE' },
    stage: { type: 'text', notNull: true, default: 'blind' },
    blind_slot: { type: 'text' },
    blind_locked_at: { type: 'timestamptz' },
    identity_disclosed_at: { type: 'timestamptz' },
    final_deadline_at: { type: 'timestamptz' },
    final_slot: { type: 'text' },
    final_action_type: { type: 'text' },
    final_locked_at: { type: 'timestamptz' },
    decision_window_seconds: { type: 'integer' },
    decision_window_version: { type: 'integer' },
    is_repeat: { type: 'boolean', notNull: true, default: false },
    recognition_slots: { type: 'text[]' },
    recognition_skipped: { type: 'boolean', notNull: true, default: false },
    recognition_submitted_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('attempts', 'attempts_player_round_unique', {
    unique: ['player_id', 'round_id'],
  });
  pgm.addConstraint('attempts', 'attempts_stage_check', {
    check: "stage in ('blind','unmasked','final_locked','verdict','pending')",
  });
  pgm.addConstraint('attempts', 'attempts_blind_slot_check', {
    check: "blind_slot is null or blind_slot in ('A','B','C')",
  });
  pgm.addConstraint('attempts', 'attempts_final_slot_check', {
    check: "final_slot is null or final_slot in ('A','B','C')",
  });
  pgm.addConstraint('attempts', 'attempts_final_action_check', {
    check: "final_action_type is null or final_action_type in ('stick','switch','timeout')",
  });
  pgm.createIndex('attempts', 'round_id');
  pgm.createIndex('attempts', 'player_id');

  // --- decision_events (append-only) ----------------------------------
  pgm.createTable('decision_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    attempt_id: { type: 'uuid', notNull: true, references: 'attempts', onDelete: 'CASCADE' },
    event_type: { type: 'text', notNull: true },
    slot: { type: 'text' },
    action_type: { type: 'text' },
    receipt_id: { type: 'uuid', notNull: true, default: pgm.func('gen_random_uuid()'), unique: true },
    decision_window_version: { type: 'integer' },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('decision_events', 'decision_events_type_check', {
    check: "event_type in ('blind_lock','identity_disclosure','final_lock','recognition')",
  });
  pgm.createIndex('decision_events', 'attempt_id');

  // --- daily_challenges -------------------------------------------------
  pgm.createTable('daily_challenges', {
    utc_date: { type: 'date', primaryKey: true },
    round_id: { type: 'uuid', notNull: true, references: 'rounds' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // --- source_receipts (Nansen call provenance per round) --------------
  pgm.createTable('source_receipts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    round_id: { type: 'uuid', references: 'rounds', onDelete: 'CASCADE' },
    endpoint: { type: 'text', notNull: true },
    request_params: { type: 'jsonb', notNull: true },
    retrieved_at: { type: 'timestamptz', notNull: true },
    covered_period: { type: 'jsonb' },
    response_sha256: { type: 'text', notNull: true },
    schema_version: { type: 'integer', notNull: true, default: 1 },
    request_id: { type: 'text' },
    credits_used: { type: 'integer' },
    private_artifact_ref: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('source_receipts', 'round_id');

  // --- api_call_log (campaign eligibility evidence) ----------------------
  pgm.createTable('api_call_log', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    endpoint: { type: 'text', notNull: true },
    called_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    http_status: { type: 'integer', notNull: true },
    request_id: { type: 'text' },
    is_cache_hit: { type: 'boolean', notNull: true, default: false },
    is_network_call: { type: 'boolean', notNull: true, default: true },
    credits_cost: { type: 'integer' },
    credits_used: { type: 'integer' },
    credits_remaining: { type: 'integer' },
    succeeded: { type: 'boolean', notNull: true },
    error_code: { type: 'text' },
    purpose: { type: 'text' },
  });
  pgm.createIndex('api_call_log', 'called_at');
  pgm.createIndex('api_call_log', 'succeeded');

  // --- RLS defense-in-depth (Supabase deployment) -----------------------
  // The app never gives the browser a direct Postgres connection, so these tables
  // are unreachable from the client regardless. RLS is enabled with zero permissive
  // policies as a second layer: if the anon/authenticated Supabase roles were ever
  // used from a client context, they would see nothing. The server's own connection
  // (service_role, or a superuser/table-owner role) bypasses RLS as usual.
  for (const table of ['rounds', 'round_assets', 'source_receipts', 'api_call_log', 'players']) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
  }
};

exports.down = (pgm) => {
  pgm.dropTable('api_call_log');
  pgm.dropTable('source_receipts');
  pgm.dropTable('daily_challenges');
  pgm.dropTable('decision_events');
  pgm.dropTable('attempts');
  pgm.dropTable('round_assets');
  pgm.dropTable('rounds');
  pgm.dropTable('players');
};
