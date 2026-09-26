/* eslint-disable camelcase */

/**
 * Round lineage (docs/NANSEN-CONTRACT-AUDIT.md, F1). A round rebuilt offline from an
 * older round's preserved Nansen responses is a NEW round with its own id, manifest and
 * commitment; `rebuilt_from` points at the ancestor, which is kept unchanged (withdrawn,
 * never deleted — the reference forbids deleting it).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE rounds ADD COLUMN IF NOT EXISTS rebuilt_from uuid REFERENCES rounds(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS rounds_rebuilt_from_idx ON rounds (rebuilt_from);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS rounds_rebuilt_from_idx;
    ALTER TABLE rounds DROP COLUMN IF EXISTS rebuilt_from;
  `);
};
