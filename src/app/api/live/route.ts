import { NextResponse } from 'next/server';
import { getCurrentLiveRound } from '@/lib/repo/live';
import { deriveLivePhase } from '@/lib/domain/live';

export async function GET() {
  // Only a Live round approved under the current eligibility policy is shown to players.
  const current = await getCurrentLiveRound({ playerFacingOnly: true });
  if (!current) {
    return NextResponse.json({ live: null });
  }

  const snapshotPublishedAt =
    current.snapshot_published_at?.toISOString() ?? current.created_at.toISOString();
  const entryCloseAtDate = current.entry_close_at ?? current.cutoff;
  const measurementStartAtDate = current.measurement_start_at ?? current.cutoff;
  const measurementEndAtDate = current.measurement_end_at ?? current.resolution_time;

  const livePhase = deriveLivePhase({
    status: current.status,
    entryCloseAt: entryCloseAtDate,
    measurementStartAt: measurementStartAtDate,
    measurementEndAt: measurementEndAtDate,
  });

  return NextResponse.json({
    live: {
      roundId: current.id,
      chain: current.chain,
      status: current.status,
      livePhase,
      snapshotPublishedAt,
      entryCloseAt: entryCloseAtDate.toISOString(),
      measurementStartAt: current.measurement_start_at?.toISOString() ?? null,
      measurementEndAt: measurementEndAtDate.toISOString(),
      invalidReason: current.invalid_reason ?? null,
    },
  });
}
