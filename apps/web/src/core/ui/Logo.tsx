import { useState } from 'react';

export function Logo({ variant = 'dark', compact = false, size = 'sidebar' }: { variant?: 'light' | 'dark'; compact?: boolean; size?: 'sidebar' | 'login' }) {
  const [failed, setFailed] = useState(false);
  const src = '/assets/brand/citihub.png';
  return failed ? (
    <span className={`brand-wordmark ${compact ? 'compact' : ''}`} aria-label="CITi Hub">CITi <span>Hub</span></span>
  ) : (
    <img className={`brand-logo brand-logo-${size} ${compact ? 'compact' : ''}`} src={src} alt="CITi Hub" data-variant={variant} onError={() => setFailed(true)} />
  );
}
