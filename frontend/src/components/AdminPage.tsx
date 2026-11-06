import { useState, useCallback, FormEvent } from 'react';
import { labelStyle, labelText, inputStyle } from '../styles';

// PIN-gated admin page: product-catalog (.xlsx) upload. Reached at /admin (see the route branch in App.tsx).
//
// The PIN is enforced server-side on every /admin/* call (routes/admin.py),
// via the X-Admin-Pin header set on each request below — this component's
// "locked" screen is just a convenience UI in front of that same check, not
// a separate mechanism. Kept in component state only (not sessionStorage),
// so reloading or re-navigating to /admin always re-prompts.

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-2)',
          fontSize: '14px',
          fontWeight: 700,
          color: 'var(--text-primary)',
        }}
      >
        {title}
      </div>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {children}
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        background: 'var(--error-light)',
        border: '1px solid #fca5a5',
        borderRadius: 'var(--radius-sm)',
        padding: '10px 14px',
        fontSize: '13px',
        color: 'var(--text-primary)',
      }}
    >
      {message}
    </div>
  );
}

function SuccessBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        background: '#f0fdf4',
        border: '1px solid #86efac',
        borderRadius: 'var(--radius-sm)',
        padding: '10px 14px',
        fontSize: '13px',
        color: 'var(--success)',
        fontWeight: 600,
      }}
    >
      {message}
    </div>
  );
}

const buttonStyle = (enabled: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  borderRadius: 'var(--radius-sm)',
  border: 'none',
  background: enabled ? 'var(--accent)' : 'var(--border)',
  color: enabled ? '#fff' : 'var(--text-muted)',
  fontSize: '13px',
  fontWeight: 600,
  cursor: enabled ? 'pointer' : 'not-allowed',
  flexShrink: 0,
});

export default function AdminPage() {
  const [pin, setPin] = useState('');
  const [adminPin, setAdminPin] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [pinError, setPinError] = useState('');

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ families: number; products: number } | null>(null);
  const [uploadError, setUploadError] = useState('');

  // Any 401 from an authenticated call means the PIN is no longer valid
  // (e.g. rotated in .env mid-session) — drop back to the locked screen
  // rather than leaving a broken unlocked view up.
  const handleUnauthorized = useCallback(() => {
    setUnlocked(false);
    setAdminPin('');
    setPinError('Session expired — enter the PIN again.');
  }, []);

  const submitPin = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = pin.trim();
    if (!trimmed) return;
    setVerifying(true);
    setPinError('');
    try {
      const res = await fetch('/admin/verify-pin', {
        method: 'POST',
        headers: { 'X-Admin-Pin': trimmed },
      });
      if (res.ok) {
        setAdminPin(trimmed);
        setUnlocked(true);
      } else {
        setPinError('Incorrect PIN');
        setPin('');
      }
    } catch {
      setPinError('Could not reach the server. Try again.');
    } finally {
      setVerifying(false);
    }
  };

  const uploadCatalog = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setUploadError('');
    setUploadResult(null);
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      const res = await fetch('/admin/product-list', {
        method: 'POST',
        headers: { 'X-Admin-Pin': adminPin },
        body: formData,
      });
      if (res.status === 401) return handleUnauthorized();
      const data = await res.json();
      if (!res.ok) {
        setUploadError(data.detail ?? 'Upload failed');
        return;
      }
      setUploadResult({ families: data.families, products: data.products });
      setSelectedFile(null);
    } catch {
      setUploadError('Could not reach the server.');
    } finally {
      setUploading(false);
    }
  };

  const pageWrap: React.CSSProperties = {
    minHeight: '100vh',
    background: 'var(--bg)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '32px 16px',
  };

  if (!unlocked) {
    return (
      <div style={pageWrap}>
        <div style={{ width: '100%', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <a href="/" style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>← Back to Home</a>
          <Section title="Admin — Enter PIN">
            <form onSubmit={submitPin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={labelStyle}>
                <span style={labelText}>PIN</span>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  autoFocus
                  value={pin}
                  onChange={e => setPin(e.target.value)}
                  style={inputStyle}
                />
              </label>
              {pinError && <ErrorBanner message={pinError} />}
              <button
                type="submit"
                disabled={verifying || !pin.trim()}
                style={buttonStyle(!verifying && !!pin.trim())}
              >
                {verifying ? 'Checking…' : 'Unlock'}
              </button>
            </form>
          </Section>
        </div>
      </div>
    );
  }

  return (
    <div style={pageWrap}>
      <div style={{ width: '100%', maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 20 }}>
        <a href="/" style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>← Back to Home</a>

        <Section title="Product Catalog">
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Upload an Excel (.xlsx) file to replace the current product catalog. It's checked
            for the right format before anything changes — if it's invalid, nothing is replaced.
          </p>
          <input
            type="file"
            accept=".xlsx"
            onChange={e => {
              setSelectedFile(e.target.files?.[0] ?? null);
              setUploadResult(null);
              setUploadError('');
            }}
            disabled={uploading}
            style={{ fontSize: '13px' }}
          />
          <button
            onClick={uploadCatalog}
            disabled={uploading || !selectedFile}
            style={buttonStyle(!uploading && !!selectedFile)}
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </button>

          {uploadError && <ErrorBanner message={uploadError} />}
          {uploadResult && (
            <SuccessBanner
              message={`Catalog updated — ${uploadResult.products} products across ${uploadResult.families} brands loaded.`}
            />
          )}
        </Section>
      </div>
    </div>
  );
}
