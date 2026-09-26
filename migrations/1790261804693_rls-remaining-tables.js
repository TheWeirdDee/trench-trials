/* eslint-disable camelcase */

/**
 * Follow-up to the init migration: enable RLS defense-in-depth on the remaining
 * player-decision tables. attempts holds each player's blind/final slot choices —
 * exactly the kind of per-player data that must not be readable via a leaked
 * Supabase anon key (PRD §15: cross-player access protection). decision_events is
 * the append-only audit trail of those same choices. daily_challenges is included
 * for consistency even though it only maps a UTC date to a round_id.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  for (const table of ['attempts', 'decision_events', 'daily_challenges']) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
  }
};

exports.down = (pgm) => {
  for (const table of ['attempts', 'decision_events', 'daily_challenges']) {
    pgm.sql(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
  }
};
