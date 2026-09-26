/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS api_call_log (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      endpoint text NOT NULL,
      request_timestamp timestamptz NOT NULL,
      response_timestamp timestamptz NOT NULL,
      duration_ms integer NOT NULL,
      http_status integer NOT NULL,
      is_success boolean NOT NULL,
      nansen_request_id text,
      quoted_credits integer,
      credits_used integer,
      credits_remaining integer,
      error_code text,
      is_cache_hit boolean DEFAULT false NOT NULL,
      source_receipt_id uuid REFERENCES source_receipts(id) ON DELETE SET NULL,
      is_backfill boolean DEFAULT false NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL
    );
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS endpoint text;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS request_timestamp timestamptz;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS response_timestamp timestamptz;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS duration_ms integer;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS http_status integer;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS is_success boolean;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS nansen_request_id text;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS quoted_credits integer;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS credits_used integer;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS credits_remaining integer;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS error_code text;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS is_cache_hit boolean DEFAULT false;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS source_receipt_id uuid REFERENCES source_receipts(id) ON DELETE SET NULL;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS is_backfill boolean DEFAULT false;
    ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
    CREATE INDEX IF NOT EXISTS api_call_log_endpoint_idx ON api_call_log(endpoint);
    CREATE INDEX IF NOT EXISTS api_call_log_request_timestamp_idx ON api_call_log(request_timestamp);
    CREATE INDEX IF NOT EXISTS api_call_log_nansen_request_id_idx ON api_call_log(nansen_request_id);
    ALTER TABLE api_call_log ENABLE ROW LEVEL SECURITY;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('api_call_log');
};
