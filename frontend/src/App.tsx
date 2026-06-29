import { useState, useCallback, useEffect, useRef, ChangeEvent } from 'react';
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
  CameraIcon,
} from './components/icons';

type Status = 'idle' | 'loading' | 'success' | 'error';
type LaunchStatus = 'idle' | 'loading' | 'open';
type InboxItem = { id: string; filename: string; uploaded_at: string; thumbnail_url: string };

function formatInboxTime(iso: string): string {
  const diffMins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(iso).toLocaleDateString();
}

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


const STAFF_NAMES = [
  'Abhishek Seetaram Naik',
  'Akshata',
  'Archana Gopal Marathi',
  'Chaitra G Naik',
  'Dattatraya V Hegde',
  'Deepa Manjunatha Gouda',
  'Fazil Unshalli',
  'Ganesh Hegde',
  'Harsha N',
  'Harshita Suresh Naik',
  'Keerthana M',
  'Krishnamoorthy',
  'Laxmi R Palankar',
  'Manjunata D Gosavi',
  'Mohan Gowda',
  'Narendra',
  'Netravati Prakash Kothari',
  'Nivedita M K',
  'Parashuram T Naik',
  'Pooja Naik',
  'Raghavendra',
  'Raghavendra S Palankar',
  'Renuka D H',
  'Sharath Nagendra Naik',
  'Subramanya Ganesh Hegde',
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

function InboxUploadPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');

  const handleChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';
    setUploadState('uploading');
    try {
      const fd = new FormData();
      fd.append('image', f);
      const res = await fetch('/inbox/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error();
      setUploadState('done');
      setTimeout(() => setUploadState('idle'), 2500);
    } catch {
      setUploadState('error');
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 32,
      padding: 32,
    }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={handleChange}
      />

      <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        DC Invoice Inbox
      </p>

      {uploadState === 'idle' && (
        <button
          onClick={() => inputRef.current?.click()}
          style={{
            width: 200,
            height: 200,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
            border: 'none',
            color: '#fff',
            cursor: 'pointer',
            boxShadow: '0 8px 32px rgba(37,99,235,0.4)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            fontSize: '17px',
            fontWeight: 700,
          }}
        >
          <CameraIcon color="#fff" />
          Take Photo
        </button>
      )}

      {uploadState === 'uploading' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <Spinner />
          <p style={{ fontSize: '16px', fontWeight: 500, color: 'var(--text-secondary)' }}>Uploading…</p>
        </div>
      )}

      {uploadState === 'done' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="9 12 11 14 15 10" />
          </svg>
          <p style={{ fontSize: '20px', fontWeight: 700, color: 'var(--success)' }}>Sent to inbox</p>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Ready for next photo</p>
        </div>
      )}

      {uploadState === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <p style={{ fontSize: '18px', fontWeight: 600, color: 'var(--error)' }}>Upload failed</p>
          <button
            onClick={() => setUploadState('idle')}
            style={{
              padding: '12px 28px',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--error)',
              background: 'transparent',
              color: 'var(--error)',
              fontSize: '15px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [productImage, setProductImage] = useState<File | null>(null);
  const [productImagePreviewUrl, setProductImagePreviewUrl] = useState<string | null>(null);
  const productImageInputRef = useRef<HTMLInputElement>(null);
  const [products, setProducts] = useState<Product[]>(() => {
    try { return JSON.parse(sessionStorage.getItem('dc_products') || '[]'); } catch { return []; }
  });
  const [status, setStatus] = useState<Status>(() => {
    try { return JSON.parse(sessionStorage.getItem('dc_products') || '[]').length > 0 ? 'success' : 'idle'; } catch { return 'idle'; }
  });
  const [errorMsg, setErrorMsg] = useState('');
  const [launchStatus, setLaunchStatus] = useState<LaunchStatus>('idle');
  const [dcNumber, setDcNumber]     = useState(() => sessionStorage.getItem('dc_number')     ?? '');
  const [dcDate, setDcDate]         = useState(() => sessionStorage.getItem('dc_date')       ?? '');
  const [supplier, setSupplier]     = useState(() => sessionStorage.getItem('dc_supplier')   ?? '');
  const [checkedBy, setCheckedBy]   = useState(() => sessionStorage.getItem('dc_checked_by') ?? 'Ganesh Hegde');
  const [extractionModel, setExtractionModel] = useState('google/gemini-3.1-flash-lite');
  const [reasoning, setReasoning] = useState(false);
  const [branch, setBranch] = useState(() => sessionStorage.getItem('dc_branch') ?? 'HOSPET ROAD');
  const [entryMode, setEntryMode] = useState<'excel' | 'type'>(() => (sessionStorage.getItem('dc_entry_mode') as 'excel' | 'type') ?? 'excel');
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [tabId] = useState<string>(() => {
    const existing = sessionStorage.getItem('tab_id');
    if (existing) return existing;
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map(b => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem('tab_id', id);
    return id;
  });
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const inboxInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/suppliers')
      .then(r => r.json())
      .then(d => setSuppliers(d.suppliers ?? []))
      .catch(() => {});
  }, []);

  // Persist key state to sessionStorage
  useEffect(() => { sessionStorage.setItem('dc_products',   JSON.stringify(products)); }, [products]);
  useEffect(() => { sessionStorage.setItem('dc_number',     dcNumber); },    [dcNumber]);
  useEffect(() => { sessionStorage.setItem('dc_date',       dcDate); },      [dcDate]);
  useEffect(() => { sessionStorage.setItem('dc_supplier',   supplier); },    [supplier]);
  useEffect(() => { sessionStorage.setItem('dc_checked_by', checkedBy); },   [checkedBy]);
  useEffect(() => { sessionStorage.setItem('dc_branch',     branch); },      [branch]);
  useEffect(() => { sessionStorage.setItem('dc_entry_mode', entryMode); },  [entryMode]);

  // Poll inbox every 10 seconds
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/inbox');
        if (res.ok) setInboxItems(await res.json());
      } catch {}
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, []);

  // Restore screenshot on page load using this tab's persistent ID
  useEffect(() => {
    fetch(`/screenshot/${tabId}`)
      .then(r => r.ok ? r.blob() : null)
      .then(blob => { if (blob) setScreenshotUrl(URL.createObjectURL(blob)); })
      .catch(() => {});
  }, []);

  const selectedModelMeta = EXTRACTION_MODELS.find(m => m.value === extractionModel);
  const reasoningSupported = selectedModelMeta?.supportsReasoning ?? false;

  const handleFileSelect = useCallback((selected: File) => {
    // Clear all persisted state for the new entry
    ['dc_products', 'dc_number', 'dc_date', 'dc_supplier'].forEach(k => sessionStorage.removeItem(k));
    setFile(selected);
    setProducts([]);
    setStatus('idle');
    setErrorMsg('');
    setDcNumber('');
    setDcDate('');
    setSupplier('');
    setScreenshotUrl(null);
    setSaveStatus('idle');
    setLaunchStatus('idle');
    setProductImage(null);
    setProductImagePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });

    const url = URL.createObjectURL(selected);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
  }, []);

  const doExtract = async (imageFile: File, prodImg: File | null = productImage) => {
    setStatus('loading');
    setErrorMsg('');
    setProducts([]);

    const formData = new FormData();
    formData.append('image', imageFile);
    formData.append('model', extractionModel);
    formData.append('reasoning', String(reasoning));
    if (prodImg) formData.append('product_image', prodImg);

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

  const handleExtract = () => {
    if (!file) return;
    doExtract(file);
  };

  const handleInboxUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';
    try {
      const fd = new FormData();
      fd.append('image', f);
      await fetch('/inbox/upload', { method: 'POST', body: fd });
      const res = await fetch('/inbox');
      if (res.ok) setInboxItems(await res.json());
    } catch {}
  };

  const handleInboxClick = async (item: InboxItem) => {
    try {
      const res = await fetch(`/inbox/image/${item.id}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const ext = item.filename.split('.').pop() ?? 'jpg';
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg',
        png: 'image/png', webp: 'image/webp', gif: 'image/gif',
      };
      const imageFile = new File([blob], item.filename, { type: mimeMap[ext] ?? 'image/jpeg' });
      handleFileSelect(imageFile);
      fetch(`/inbox/${item.id}`, { method: 'DELETE' }).catch(() => {});
      setInboxItems(prev => prev.filter(i => i.id !== item.id));
      doExtract(imageFile, null);
    } catch {}
  };

  const handleSaveDC = async () => {
    setSaveStatus('saving');
    try {
      await fetch(`/save-dc/${tabId}`, { method: 'POST' });
      setSaveStatus('saved');
    } catch {
      setSaveStatus('idle');
    }
  };

  const handleLaunchBrowser = async (resolvedProducts: ResolvedProduct[]) => {
    setLaunchStatus('loading');
    setScreenshotUrl(null);
    setSaveStatus('idle');
    try {
      const res = await fetch('/launch-browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tab_id: tabId,
          dc_number: dcNumber,
          dc_date: dcDate,
          supplier,
          checked_by: checkedBy,
          branch,
          products: resolvedProducts,
          entry_mode: entryMode,
        }),
      });
      await res.json();
      setLaunchStatus('open');
    } catch {
      setLaunchStatus('idle');
    }
  };

  useEffect(() => {
    if (launchStatus !== 'open') return;
    const interval = setInterval(async () => {
      try {
        const r = await fetch(`/screenshot/${tabId}`);
        if (r.ok) {
          const blob = await r.blob();
          setScreenshotUrl(URL.createObjectURL(blob));
          clearInterval(interval);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [launchStatus, tabId]);

  const canExtract = file !== null && status !== 'loading';

  if (window.location.pathname === '/inbox-upload') {
    return <InboxUploadPage />;
  }

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
              Shubhada Pharma DC extractor
            </h1>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Click and Pick
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
        {/* Inbox section */}
        <SectionCard
          title="Inbox"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
              <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
            </svg>
          }
          badge={inboxItems.length > 0 ? inboxItems.length : undefined}
          pulse={inboxItems.length > 0}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            {inboxItems.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No images in inbox</p>
            ) : (
              <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4 }}>
                {inboxItems.map(item => (
                  <button
                    key={item.id}
                    onClick={() => handleInboxClick(item)}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--surface-2)',
                      padding: 0,
                      cursor: 'pointer',
                      flexShrink: 0,
                      overflow: 'hidden',
                      display: 'flex',
                      flexDirection: 'column',
                      transition: 'border-color 0.15s, box-shadow 0.15s',
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)';
                      (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 0 2px var(--accent-light)';
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
                      (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none';
                    }}
                  >
                    <img
                      src={item.thumbnail_url}
                      alt=""
                      style={{ width: 100, height: 80, objectFit: 'cover', display: 'block' }}
                    />
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '4px 8px', display: 'block', textAlign: 'center' }}>
                      {formatInboxTime(item.uploaded_at)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <input
              ref={inboxInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={handleInboxUpload}
            />
            <button
              onClick={() => inboxInputRef.current?.click()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 14px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text-secondary)',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Add Image
            </button>
          </div>
        </SectionCard>

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

          {/* Optional product image */}
          <div style={{
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius)',
            padding: '14px 16px',
            background: 'var(--surface-2)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ ...labelText }}>Product's Image <span style={{ color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Photo of the package — helps AI resolve unclear product names in the invoice
                </span>
              </div>
              <button
                onClick={() => productImageInputRef.current?.click()}
                disabled={status === 'loading'}
                style={{
                  padding: '6px 14px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: status === 'loading' ? 'var(--text-muted)' : 'var(--text-secondary)',
                  fontSize: '12px',
                  fontWeight: 500,
                  cursor: status === 'loading' ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {productImage ? 'Replace' : 'Browse'}
              </button>
              <input
                ref={productImageInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                style={{ display: 'none' }}
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  e.target.value = '';
                  setProductImage(f);
                  setProductImagePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f); });
                }}
              />
            </div>
            {productImagePreviewUrl && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <img
                  src={productImagePreviewUrl}
                  alt="Product package"
                  style={{
                    width: 80, height: 60, objectFit: 'cover',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {productImage?.name}
                  </p>
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>
                    {productImage ? `${(productImage.size / 1024).toFixed(0)} KB` : ''}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setProductImage(null);
                    setProductImagePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
                  }}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-muted)', fontSize: '16px', lineHeight: 1,
                    padding: '2px 4px', flexShrink: 0,
                  }}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            )}
          </div>

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
                  {suppliers.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Checked By</span>
                <select
                  style={inputStyle}
                  value={checkedBy}
                  onChange={e => setCheckedBy(e.target.value)}
                >
                  <option value="">— Select staff —</option>
                  {STAFF_NAMES.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Branch</span>
                <select
                  style={inputStyle}
                  value={branch}
                  onChange={e => setBranch(e.target.value)}
                >
                  <option value="HOSPET ROAD">HOSPET ROAD</option>
                  <option value="SHIVAJI CHOWK">SHIVAJI CHOWK</option>
                </select>
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Entry Mode</span>
                <select
                  style={inputStyle}
                  value={entryMode}
                  onChange={e => setEntryMode(e.target.value as 'excel' | 'type')}
                >
                  <option value="excel">Excel Import (fast)</option>
                  <option value="type">Type row by row (slow)</option>
                </select>
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
                onDCUpdate={(field, value) => {
                  if (field === 'dc_number')  setDcNumber(value);
                  if (field === 'dc_date')    setDcDate(value);
                  if (field === 'supplier')   setSupplier(value);
                  if (field === 'checked_by') setCheckedBy(value);
                }}
              />
            )}
          </SectionCard>

          {screenshotUrl && (
            <SectionCard title="DC Entry Screenshot" icon={<TableIcon />}>
              <img
                src={screenshotUrl}
                alt="DC entry screenshot"
                style={{ width: '100%', borderRadius: 'var(--radius-sm)', display: 'block', marginBottom: 16 }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={handleSaveDC}
                  disabled={saveStatus !== 'idle'}
                  style={{
                    background: saveStatus === 'saved' ? 'var(--success)' : 'var(--accent)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    padding: '10px 28px',
                    fontSize: '15px',
                    fontWeight: 600,
                    cursor: saveStatus !== 'idle' ? 'not-allowed' : 'pointer',
                    opacity: saveStatus === 'saving' ? 0.7 : 1,
                  }}
                >
                  {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved ✓' : 'Save DC'}
                </button>
              </div>
            </SectionCard>
          )}
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
  pulse,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  badge?: number;
  pulse?: boolean;
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
        {pulse && (
          <span
            className="inbox-pulse-dot"
            style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0, display: 'inline-block' }}
          />
        )}
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
