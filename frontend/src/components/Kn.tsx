import { ReactNode } from 'react';

/** The Kannada line under an English one. Staff read both, so the English stays first and in full. */
export function Kn({ children }: { children: ReactNode }) {
  return (
    <span lang="kn" style={{ display: 'block', marginTop: 2, fontWeight: 'normal', color: 'var(--text-secondary)', textTransform: 'none', letterSpacing: 'normal' }}>
      {children}
    </span>
  );
}
