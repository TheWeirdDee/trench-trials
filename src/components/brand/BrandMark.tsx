/**
 * The Trench Trials mark: an abstract "TT". The crossbar is three separate candidate
 * segments (A, B, C); the two stems are cut by one horizontal reveal slit, and the part
 * below the slit sits slightly offset — the read before the reveal and the call after it.
 */
export function BrandMark({
  size = 32,
  tone = 'default',
  className = '',
  title,
}: {
  size?: number;
  /** default: cream with a burgundy chosen candidate; mono: currentColor only. */
  tone?: 'default' | 'mono';
  className?: string;
  title?: string;
}) {
  const main = tone === 'mono' ? 'currentColor' : '#F3EFE7';
  const accent = tone === 'mono' ? 'currentColor' : '#941642';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* Three anonymous candidates form the crossbars. */}
      <rect x="3" y="6" width="12.5" height="8" rx="2" fill={main} />
      <rect x="17.75" y="6" width="12.5" height="8" rx="2" fill={accent} />
      <rect x="32.5" y="6" width="12.5" height="8" rx="2" fill={main} />
      {/* Stems above the reveal slit: the blind read. */}
      <rect x="10" y="16" width="6" height="11" rx="1.5" fill={main} />
      <rect x="32" y="16" width="6" height="11" rx="1.5" fill={main} />
      {/* Stems below the slit, shifted: the call after the reveal. */}
      <rect x="11.5" y="30" width="6" height="13" rx="1.5" fill={main} />
      <rect x="30.5" y="30" width="6" height="13" rx="1.5" fill={main} />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <BrandMark size={30} />
      <span className="text-[18px] font-extrabold tracking-[-0.03em] text-cream">Trench Trials</span>
    </span>
  );
}
