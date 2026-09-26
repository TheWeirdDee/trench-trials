/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE daily_challenges ADD COLUMN IF NOT EXISTS assigned_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE daily_challenges ADD COLUMN IF NOT EXISTS assignment_source text NOT NULL DEFAULT 'admin_api';
    ALTER TABLE daily_challenges ADD COLUMN IF NOT EXISTS assigned_by_hash text;
    ALTER TABLE daily_challenges ADD COLUMN IF NOT EXISTS replacement_reason text;
    ALTER TABLE daily_challenges ADD COLUMN IF NOT EXISTS replaced_at timestamptz;
    ALTER TABLE daily_challenges ADD COLUMN IF NOT EXISTS prior_round_id uuid REFERENCES rounds(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS daily_challenges_assigned_at_idx ON daily_challenges(assigned_at);
  `);
};

exports.down = (pgm) => {
  pgm.dropIndex('daily_challenges', 'assigned_at');
  pgm.dropColumn('daily_challenges', 'prior_round_id');
  pgm.dropColumn('daily_challenges', 'replaced_at');
  pgm.dropColumn('daily_challenges', 'replacement_reason');
  pgm.dropColumn('daily_challenges', 'assigned_by_hash');
  pgm.dropColumn('daily_challenges', 'assignment_source');
  pgm.dropColumn('daily_challenges', 'assigned_at');
};
