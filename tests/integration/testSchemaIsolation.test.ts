import { describe, expect, it } from 'vitest';
import { createPool } from '@/lib/db';
import { CANONICAL_ROUND_IDS, testPool } from './fixtures';

const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);
const maybeDescribe = DB_AVAILABLE ? describe : describe.skip;

maybeDescribe('Test database isolation', () => {
  it('every test connection sees only the isolated test schema', async () => {
    const res = await testPool().query<{ schema: string; path: string }>(
      `SELECT current_schema() AS schema, current_setting('search_path') AS path`,
    );
    expect(res.rows[0]).toEqual({ schema: 'tt_test', path: 'tt_test' });
  });

  it('holds the canonical rounds the suites exercise (prepared by npm run test:db:setup)', async () => {
    const res = await testPool().query<{ n: number }>('SELECT count(*)::int AS n FROM rounds WHERE id = ANY($1::uuid[])', [
      CANONICAL_ROUND_IDS,
    ]);
    expect(res.rows[0]!.n).toBe(CANONICAL_ROUND_IDS.length);
  });

  it('refuses to build a pool for the production schema before connecting', () => {
    const previous = process.env.DB_SCHEMA;
    try {
      for (const schema of ['public', '']) {
        process.env.DB_SCHEMA = schema;
        expect(() => createPool()).toThrow(/isolated test schema/);
      }
    } finally {
      process.env.DB_SCHEMA = previous;
    }
  });
});
