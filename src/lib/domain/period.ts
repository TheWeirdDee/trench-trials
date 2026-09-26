/**
 * A coarse, non-identifying period label for the blind/unmasked stages (PRD §5.1:
 * "Display... a coarse historical period such as a month"). Never expose the exact
 * cutoff timestamp before verdict — that alone can make a round trivially
 * look-up-able against public price charts.
 */
export function coarsePeriod(cutoff: Date): string {
  return cutoff.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
