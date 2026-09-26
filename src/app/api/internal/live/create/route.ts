import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedInternalRequest } from '@/lib/internalAuth';
import { createLiveRound } from '@/lib/repo/live';
import { createRealLiveSnapshot, LiveCreateError, type LiveCreateErrorCode } from '@/lib/services/liveSnapshot';

/** Caller-supplied assets/receipts are fixture data: only the test runner may use them. */
function fixtureInputsAllowed(): boolean {
  return process.env.NODE_ENV === 'test';
}

// A second request while one is spending credits in this process is refused outright;
// the repo-level advisory lock covers creators in other processes.
let liveCreateInFlight = false;

function statusFor(code: LiveCreateErrorCode): number {
  switch (code) {
    case 'active_live_round_exists':
      return 409;
    case 'nansen_insufficient_credits':
    case 'nansen_auth_rejected':
    case 'nansen_request_failed':
    case 'nansen_operation_halted':
      return 502;
    case 'nansen_budget_exhausted':
    case 'nansen_audit_log_failed':
    case 'round_persist_failed':
      return 500;
    default:
      return 422;
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthorizedInternalRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));

  if (body.customAssets) {
    if (!fixtureInputsAllowed()) {
      return NextResponse.json({ ok: false, error: 'fixture_inputs_disabled' }, { status: 403 });
    }
    try {
      // Integration test or fixture path
      const result = await createLiveRound({
        chain: body.chain ?? 'ethereum',
        assets: body.customAssets,
        timingConfig: body.timingConfig,
        sourceReceipts: body.sourceReceipts,
        snapshotPublishedAt: body.snapshotPublishedAt ? new Date(body.snapshotPublishedAt) : undefined,
        eligibility: { status: 'approved', actor: 'test_fixture', note: 'test fixture (NODE_ENV=test only)' },
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: 'live_creation_failed', message: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }

  if (liveCreateInFlight) {
    return NextResponse.json({ ok: false, error: 'live_create_in_progress' }, { status: 409 });
  }
  liveCreateInFlight = true;
  try {
    // Real Nansen API snapshot creation
    const result = await createRealLiveSnapshot({
      chain: body.chain,
      timingConfig: body.timingConfig,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof LiveCreateError) {
      return NextResponse.json(
        { ok: false, error: err.code, message: err.message, nansen: err.nansen },
        { status: statusFor(err.code) },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'live_creation_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    liveCreateInFlight = false;
  }
}
