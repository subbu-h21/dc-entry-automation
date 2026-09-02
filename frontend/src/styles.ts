// Shared style-object constants, used by App.tsx and AdminPage.tsx for
// visually consistent labeled form fields. Moved out of App.tsx so AdminPage
// doesn't need its own duplicate copy.

import type { CSSProperties } from 'react';

export const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

export const labelText: CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

export const inputStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  fontSize: '13px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};
