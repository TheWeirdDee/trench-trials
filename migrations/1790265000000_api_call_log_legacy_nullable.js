/* eslint-disable camelcase */

/**
 * Captures a change that was applied to production by hand (by a since-removed one-off script):
 * the legacy api_call_log columns from the init schema are superseded by the columns of
 * 1790263000000_api_call_log and are no longer written, so they must accept NULL.
 * Idempotent: a no-op where they are already nullable.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE api_call_log ALTER COLUMN called_at DROP NOT NULL;
    ALTER TABLE api_call_log ALTER COLUMN is_network_call DROP NOT NULL;
    ALTER TABLE api_call_log ALTER COLUMN succeeded DROP NOT NULL;
  `);
};

exports.down = () => {
  // Restoring NOT NULL would fail on rows written by the current code; intentionally not reversible.
};
