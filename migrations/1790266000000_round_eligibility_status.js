/* eslint-disable camelcase */

/**
 * Reversible round eligibility (2026-09-26 contract audit, docs/NANSEN-CONTRACT-AUDIT.md).
 *
 * A round is player-facing only when eligibility_status = 'approved' AND it was approved
 * under the current eligibility policy version (src/lib/domain/assetPolicy.ts). Every
 * existing round starts at 'pending_review' — nothing is grandfathered — and withdrawal
 * changes only this status: rounds, assets, receipts, commitments and attempts are never
 * deleted or rewritten. Each change is kept in round_eligibility_events.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE rounds ADD COLUMN IF NOT EXISTS eligibility_status text NOT NULL DEFAULT 'pending_review';
    ALTER TABLE rounds ADD COLUMN IF NOT EXISTS eligibility_policy_version integer;
    ALTER TABLE rounds ADD COLUMN IF NOT EXISTS eligibility_reviewed_at timestamptz;
    ALTER TABLE rounds ADD COLUMN IF NOT EXISTS eligibility_note text;
    ALTER TABLE rounds ADD CONSTRAINT rounds_eligibility_status_check
      CHECK (eligibility_status IN ('pending_review', 'approved', 'investigate', 'withdrawn'));

    CREATE TABLE IF NOT EXISTS round_eligibility_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      round_id uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      from_status text,
      to_status text NOT NULL,
      policy_version integer,
      note text,
      actor text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS round_eligibility_events_round_id_idx ON round_eligibility_events (round_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS round_eligibility_events;
    ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_eligibility_status_check;
    ALTER TABLE rounds DROP COLUMN IF EXISTS eligibility_note;
    ALTER TABLE rounds DROP COLUMN IF EXISTS eligibility_reviewed_at;
    ALTER TABLE rounds DROP COLUMN IF EXISTS eligibility_policy_version;
    ALTER TABLE rounds DROP COLUMN IF EXISTS eligibility_status;
  `);
};
