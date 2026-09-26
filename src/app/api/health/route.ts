import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Liveness plus a database round trip. Reports status only — never configuration or errors. */
export async function GET() {
  try {
    await getPool().query('SELECT 1');
    return NextResponse.json({ ok: true, database: 'reachable' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false, database: 'unreachable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
