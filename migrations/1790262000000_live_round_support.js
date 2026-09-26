/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // 1. Allow nullable price/candle fields on round_assets for open/resolving Live rounds
  pgm.dropConstraint('round_assets', 'round_assets_prices_positive');

  pgm.alterColumn('round_assets', 'entry_candle_start', { notNull: false });
  pgm.alterColumn('round_assets', 'entry_price', { notNull: false });
  pgm.alterColumn('round_assets', 'exit_candle_start', { notNull: false });
  pgm.alterColumn('round_assets', 'exit_price', { notNull: false });
  pgm.alterColumn('round_assets', 'return_ratio', { notNull: false });
  pgm.alterColumn('round_assets', 'source_response_sha256', { notNull: false });

  pgm.addConstraint('round_assets', 'round_assets_prices_positive', {
    check: '(entry_price IS NULL OR entry_price > 0) AND (exit_price IS NULL OR exit_price > 0)',
  });

  // 2. Add purpose to source_receipts for audit trail
  pgm.addColumn('source_receipts', {
    purpose: { type: 'text' },
  });

  // 3. Add explicit live timing columns to rounds
  pgm.addColumn('rounds', {
    snapshot_published_at: { type: 'timestamptz' },
    entry_close_at: { type: 'timestamptz' },
    measurement_start_at: { type: 'timestamptz' },
    measurement_end_at: { type: 'timestamptz' },
  });

  pgm.createIndex('rounds', 'entry_close_at');
  pgm.createIndex('rounds', 'measurement_end_at');
};

exports.down = (pgm) => {
  pgm.dropIndex('rounds', 'measurement_end_at');
  pgm.dropIndex('rounds', 'entry_close_at');

  pgm.dropColumn('rounds', 'measurement_end_at');
  pgm.dropColumn('rounds', 'measurement_start_at');
  pgm.dropColumn('rounds', 'entry_close_at');
  pgm.dropColumn('rounds', 'snapshot_published_at');

  pgm.dropColumn('source_receipts', 'purpose');

  pgm.dropConstraint('round_assets', 'round_assets_prices_positive');
  pgm.addConstraint('round_assets', 'round_assets_prices_positive', {
    check: 'entry_price > 0 AND exit_price > 0',
  });
  pgm.alterColumn('round_assets', 'source_response_sha256', { notNull: true });
  pgm.alterColumn('round_assets', 'return_ratio', { notNull: true });
  pgm.alterColumn('round_assets', 'exit_price', { notNull: true });
  pgm.alterColumn('round_assets', 'exit_candle_start', { notNull: true });
  pgm.alterColumn('round_assets', 'entry_price', { notNull: true });
  pgm.alterColumn('round_assets', 'entry_candle_start', { notNull: true });
};
