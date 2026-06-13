import { useState, useCallback } from 'react';
import ImageUpload from './components/ImageUpload';
import ResultsTable, { Product, ResolvedProduct } from './components/ResultsTable';
import {
  PillIcon,
  UploadSectionIcon,
  TableIcon,
  ExtractIcon,
  ErrorCircleIcon,
  Spinner,
  LoadingSpinner,
  DCDetailsIcon,
} from './components/icons';

type Status = 'idle' | 'loading' | 'success' | 'error';
type LaunchStatus = 'idle' | 'loading' | 'open';

const EXTRACTION_MODELS = [
  { value: 'google/gemini-2.5-flash',      label: 'Gemini 2.5 Flash',      supportsReasoning: true },
  { value: 'google/gemini-2.5-pro',        label: 'Gemini 2.5 Pro',        supportsReasoning: true },
  { value: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', supportsReasoning: false },
  { value: 'google/gemini-3.1-flash',      label: 'Gemini 3.1 Flash',      supportsReasoning: true },
  { value: 'google/gemini-3.1-pro',        label: 'Gemini 3.1 Pro',        supportsReasoning: true },
  { value: 'google/gemini-3.5-flash',      label: 'Gemini 3.5 Flash',      supportsReasoning: true },
  { value: 'google/gemini-3.5-pro',        label: 'Gemini 3.5 Pro',        supportsReasoning: true },
  { value: 'openai/gpt-4.1-mini',          label: 'GPT-4.1 Mini',          supportsReasoning: false },
  { value: 'google/gemma-4-31b-it',        label: 'Gemma 4 31b It',        supportsReasoning: false },
  { value: 'nex-agi/nex-n2-pro:free',     label: 'Nex N2 Pro (free)',     supportsReasoning: true },
];

const KNOWN_SUPPLIERS = [
  'KAPILA PHARMA',
  'KAPILA MEDICAL AGENCIES',
  'SAROJ PHARMA',
  'HEGDE BROTHERS',
  'DONNA ASSOCIATES',
  'A.K.PHARMA',
  'DHANYA PHARMA',
];

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const labelText: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const inputStyle: React.CSSProperties = {
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

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [launchStatus, setLaunchStatus] = useState<LaunchStatus>('idle');
  const [dcNumber, setDcNumber]     = useState('');
  const [dcDate, setDcDate]         = useState('');
  const [supplier, setSupplier]     = useState('');
  const [checkedBy, setCheckedBy]   = useState('GANESH HEGDE');
  const [extractionModel, setExtractionModel] = useState('google/gemini-3.1-flash-lite');
  const [reasoning, setReasoning] = useState(false);

  const selectedModelMeta = EXTRACTION_MODELS.find(m => m.value === extractionModel);
  const reasoningSupported = selectedModelMeta?.supportsReasoning ?? false;

  const handleFileSelect = useCallback((selected: File) => {
    setFile(selected);
    setProducts([]);
    setStatus('idle');
    setErrorMsg('');

    const url = URL.createObjectURL(selected);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
  }, []);

  const handleExtract = async () => {
    if (!file) return;

    setStatus('loading');
    setErrorMsg('');
    setProducts([]);

    const formData = new FormData();
    formData.append('image', file);
    formData.append('model', extractionModel);
    formData.append('reasoning', String(reasoning));

    try {
      const res = await fetch('/extract', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `Server error ${res.status}`);
      }

      setProducts(data.products ?? []);
      if (data.dc_number)     setDcNumber(data.dc_number);
      if (data.dc_date)       setDcDate(data.dc_date);
      if (data.supplier_name) setSupplier(data.supplier_name);
      setStatus('success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unexpected error. Please try again.';
      setErrorMsg(msg);
      setStatus('error');
    }
  };

  const handleLaunchBrowser = async (resolvedProducts: ResolvedProduct[]) => {
    setLaunchStatus('loading');
    try {
      await fetch('/launch-browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dc_number: dcNumber,
          dc_date: dcDate,
          supplier,
          checked_by: checkedBy,
          products: resolvedProducts,
        }),
      });
      setLaunchStatus('open');
    } catch {
      setLaunchStatus('idle');
    }
  };

  const canExtract = file !== null && status !== 'loading';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <header
        style={{
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          boxShadow: 'var(--shadow-sm)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: '0 auto',
            padding: '0 24px',
            height: 64,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(37,99,235,0.3)',
              flexShrink: 0,
            }}
          >
            <PillIcon />
          </div>
          <div>
            <h1
              style={{
                fontSize: '16px',
                fontWeight: 700,
                color: 'var(--text-primary)',
                lineHeight: 1.2,
              }}
            >
              Pharmacy Bill Extractor
            </h1>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Powered by Gemini 2.5 Flash
            </p>
          </div>
        </div>
      </header>

      {/* Main */}
      <main
        style={{
          flex: 1,
          maxWidth: 1100,
          width: '100%',
          margin: '0 auto',
          padding: '32px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        {/* Upload section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SectionCard title="Upload Invoice" icon={<UploadSectionIcon />}>
            <ImageUpload
              onFileSelect={handleFileSelect}
              selectedFile={file}
              previewUrl={previewUrl}
              disabled={status === 'loading'}
            />
          </SectionCard>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="model-selector-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ ...labelText, whiteSpace: 'nowrap' }}>Extraction Model</span>
            <select
              style={{ ...inputStyle, flex: 1 }}
              value={extractionModel}
              onChange={e => {
                setExtractionModel(e.target.value);
                const meta = EXTRACTION_MODELS.find(m => m.value === e.target.value);
                if (!meta?.supportsReasoning) setReasoning(false);
              }}
              disabled={status === 'loading'}
            >
              {EXTRACTION_MODELS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6,
              cursor: (!reasoningSupported || status === 'loading') ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap', userSelect: 'none',
              opacity: reasoningSupported ? 1 : 0.4,
            }}>
              <input
                type="checkbox"
                checked={reasoning}
                onChange={e => setReasoning(e.target.checked)}
                disabled={!reasoningSupported || status === 'loading'}
                style={{ accentColor: 'var(--accent)', width: 15, height: 15, cursor: 'inherit' }}
              />
              <span style={{ ...labelText }}>Reasoning</span>
            </label>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Use <strong>3.1 Flash Lite</strong> for smaller DCs &nbsp;·&nbsp; <strong>2.5 Pro</strong> for larger DCs with reasoning turned on
          </span>
          </div>

          <button
            onClick={handleExtract}
            disabled={!canExtract}
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: 'var(--radius)',
              border: 'none',
              background: canExtract
                ? 'linear-gradient(135deg, #2563eb, #1d4ed8)'
                : 'var(--border)',
              color: canExtract ? '#fff' : 'var(--text-muted)',
              fontSize: '15px',
              fontWeight: 600,
              cursor: canExtract ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              boxShadow: canExtract ? '0 4px 14px rgba(37,99,235,0.35)' : 'none',
              transition: 'all 0.2s',
              letterSpacing: '0.01em',
            }}
          >
            {status === 'loading' ? (
              <>
                <Spinner />
                Extracting...
              </>
            ) : (
              <>
                <ExtractIcon active={canExtract} />
                Extract Products
              </>
            )}
          </button>

          {status === 'error' && (
            <div
              style={{
                background: 'var(--error-light)',
                border: '1px solid #fca5a5',
                borderRadius: 'var(--radius-sm)',
                padding: '12px 16px',
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
              }}
            >
              <div style={{ flexShrink: 0, marginTop: 1 }}>
                <ErrorCircleIcon />
              </div>
              <p style={{ fontSize: '13px', color: 'var(--error)', lineHeight: 1.5 }}>
                {errorMsg}
              </p>
            </div>
          )}
        </div>

        {/* Results */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SectionCard title="DC Details" icon={<DCDetailsIcon />}>
            <div className="dc-details-grid">
              <label style={labelStyle}>
                <span style={labelText}>DC Number</span>
                <input
                  style={inputStyle}
                  type="text"
                  placeholder="e.g. DC-00123"
                  value={dcNumber}
                  onChange={e => setDcNumber(e.target.value)}
                />
              </label>
              <label style={labelStyle}>
                <span style={labelText}>DC Date</span>
                <input
                  style={inputStyle}
                  type="date"
                  value={dcDate}
                  onChange={e => setDcDate(e.target.value)}
                />
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Supplier</span>
                <select
                  style={inputStyle}
                  value={supplier}
                  onChange={e => setSupplier(e.target.value)}
                >
                  <option value="">— Select supplier —</option>
                  {KNOWN_SUPPLIERS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Checked By</span>
                <input
                  style={inputStyle}
                  type="text"
                  placeholder="e.g. GANESH"
                  value={checkedBy}
                  onChange={e => setCheckedBy(e.target.value.toUpperCase())}
                />
              </label>
            </div>
          </SectionCard>

          <SectionCard
            title="Extracted Products"
            icon={<TableIcon />}
            badge={status === 'success' ? products.length : undefined}
          >
            {status === 'idle' && (
              <EmptyState message="Upload an invoice and click Extract to see products here." />
            )}
            {status === 'loading' && <LoadingState />}
            {status === 'error' && (
              <EmptyState message="Extraction failed. Check the error on the left and try again." variant="error" />
            )}
            {status === 'success' && (
              <ResultsTable
                products={products}
                onOpenDCEntry={handleLaunchBrowser}
                launchStatus={launchStatus}
              />
            )}
          </SectionCard>
        </div>
      </main>

      {/* Footer */}
      <footer
        style={{
          padding: '16px 24px',
          textAlign: 'center',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
        }}
      >
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Pharmacy Bill Extractor &mdash; OpenRouter + Gemini 2.5 Flash + Tool Calling
        </p>
      </footer>
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────── */

function SectionCard({
  title,
  icon,
  badge,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  badge?: number;
  children: React.ReactNode;
}) {
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
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'var(--surface-2)',
        }}
      >
        {icon}
        <span style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', flex: 1 }}>
          {title}
        </span>
        {badge !== undefined && (
          <span
            style={{
              background: 'var(--accent)',
              color: '#fff',
              borderRadius: '20px',
              padding: '2px 9px',
              fontSize: '12px',
              fontWeight: 700,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <div style={{ padding: '20px' }}>{children}</div>
    </div>
  );
}

function EmptyState({
  message,
  variant = 'default',
}: {
  message: string;
  variant?: 'default' | 'error';
}) {
  return (
    <div
      style={{
        padding: '40px 20px',
        textAlign: 'center',
        color: variant === 'error' ? 'var(--error)' : 'var(--text-muted)',
      }}
    >
      <p style={{ fontSize: '14px', lineHeight: 1.6 }}>{message}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div
      style={{
        padding: '48px 20px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <LoadingSpinner />
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Analysing invoice...
        </p>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Gemini is reading the image
        </p>
      </div>
    </div>
  );
}
