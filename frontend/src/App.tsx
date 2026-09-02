import { useState, useCallback, useEffect, useRef, ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import ImageUpload from './components/ImageUpload';
import ResultsTable, { Product, ResolvedProduct } from './components/ResultsTable';
import AdminPage from './components/AdminPage';
import { labelStyle, labelText, inputStyle } from './styles';
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
type InboxItem = { id: string; filename: string; uploaded_at: string; thumbnail_url: string; photo_type: string };

function formatInboxTime(iso: string): string {
  const diffMins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(iso).toLocaleDateString();
}

// Vision-capable extraction models offered in the dropdown — kept to a short,
// hand-picked list (not fetched from OpenRouter's catalog) since that's this
// app's existing pattern. Each id/supportsReasoning value verified directly
// against OpenRouter's live /api/v1/models response — all four are real,
// image-input-capable, and list "reasoning" in their supported_parameters
// (Gemini 3.1 Flash Lite is the exception on reasoning — verified 2026-09-02
// per the original 3-model list; not re-checked since, unchanged from before).
// Note google/gemini-3.6-flash has no undated alias on OpenRouter — the
// pinned, dated slug below is the real id (verified 2026-09-02).
const EXTRACTION_MODELS = [
  { value: 'google/gemini-3.1-flash-lite',    label: 'Lite',   supportsReasoning: false },
  { value: 'qwen/qwen3.8-flash',              label: 'Lite 2', supportsReasoning: true },
  { value: 'google/gemini-3.7-flash',         label: 'Pro',    supportsReasoning: true },
  { value: 'google/gemini-3.6-flash-20260721', label: 'Pro 2',  supportsReasoning: true },
];



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
  const [invoiceFiles, setInvoiceFiles] = useState<File[]>([]);
  const [invoicePreviews, setInvoicePreviews] = useState<string[]>([]);
  const [productImage, setProductImage] = useState<File | null>(null);
  const [productImagePreviewUrl, setProductImagePreviewUrl] = useState<string | null>(null);
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
  // No hardcoded fallback name here (there used to be one) — the staff roster
  // is admin-editable now (see the /staff fetch below), so nothing can be
  // assumed to always exist on it.
  const [checkedBy, setCheckedBy]   = useState(() => sessionStorage.getItem('dc_checked_by') ?? '');
  const [extractionModel, setExtractionModel] = useState('google/gemini-3.1-flash-lite');
  const [reasoning, setReasoning] = useState(false);
  const [branch, setBranch] = useState(() => sessionStorage.getItem('dc_branch') ?? 'HOSPET ROAD');
  const [entryMode, setEntryMode] = useState<'excel' | 'type'>(() => (sessionStorage.getItem('dc_entry_mode') as 'excel' | 'type') ?? 'excel');
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [staffNames, setStaffNames] = useState<string[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
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
  const [pipelineSuppliers, setPipelineSuppliers] = useState<{ id: number; name: string }[]>([]);
  const [pipelineDcNumber, setPipelineDcNumber] = useState('');
  const [pipelineSupplierId, setPipelineSupplierId] = useState<number | null>(null);
  const [pipelineFetching, setPipelineFetching] = useState(false);
  const [pipelineFetchError, setPipelineFetchError] = useState('');

  useEffect(() => {
    fetch('/suppliers')
      .then(r => r.json())
      .then(d => setSuppliers(d.suppliers ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/staff')
      .then(r => r.json())
      .then(d => setStaffNames(d.staff ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/inbox/pipeline-suppliers')
      .then(r => r.json())
      .then(d => setPipelineSuppliers(d.suppliers ?? []))
      .catch(() => {});
  }, []);

  // Keep invoicePreviews in sync with invoiceFiles, revoking old object URLs.
  useEffect(() => {
    const urls = invoiceFiles.map(f => URL.createObjectURL(f));
    setInvoicePreviews(urls);
    return () => { urls.forEach(u => URL.revokeObjectURL(u)); };
  }, [invoiceFiles]);

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

  // Resets everything but the invoice images themselves — called only when
  // starting a fresh entry (both invoice page slots were empty beforehand),
  // not when adding a second page to an entry already in progress.
  const resetEntryState = () => {
    ['dc_products', 'dc_number', 'dc_date', 'dc_supplier'].forEach(k => sessionStorage.removeItem(k));
    setProducts([]);
    setStatus('idle');
    setErrorMsg('');
    setDcNumber('');
    setDcDate('');
    setSupplier('');
    setScreenshotUrl(null);
    setLaunchStatus('idle');
  };

  const handleInvoiceFilesChange = useCallback((files: File[]) => {
    if (invoiceFiles.length === 0 && files.length > 0) resetEntryState();
    setInvoiceFiles(files);
  }, [invoiceFiles]);

  const handleInvoiceRemove = useCallback((index: number) => {
    setInvoiceFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleProductImageSelect = useCallback((selected: File) => {
    setProductImage(selected);
    setProductImagePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(selected); });
  }, []);

  const handleProductImageClear = useCallback(() => {
    setProductImage(null);
    setProductImagePreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
  }, []);

  const doExtract = async (imageFiles: File[], prodImg: File | null = productImage) => {
    setStatus('loading');
    setErrorMsg('');
    setProducts([]);

    const formData = new FormData();
    imageFiles.forEach(f => formData.append('images', f));
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
    if (invoiceFiles.length === 0) return;
    doExtract(invoiceFiles);
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

  const handleFetchFromPipeline = async () => {
    if (!pipelineDcNumber.trim() || pipelineSupplierId === null) return;
    setPipelineFetching(true);
    setPipelineFetchError('');
    try {
      const params = new URLSearchParams({
        dc_number: pipelineDcNumber.trim(),
        supplier_id: String(pipelineSupplierId),
      });
      const res = await fetch(`/inbox/import-from-pipeline?${params}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || `Error ${res.status}`);
      }

      const invRes = await fetch('/inbox');
      if (invRes.ok) setInboxItems(await invRes.json());

      if (data.imported === 0) {
        setPipelineFetchError('No matching photos found for that DC (or they have expired).');
      } else {
        setPipelineDcNumber('');
      }
    } catch (err) {
      setPipelineFetchError(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setPipelineFetching(false);
    }
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

      let assigned = true;
      if (item.photo_type === 'package') {
        handleProductImageSelect(imageFile);
      } else if (invoiceFiles.length < 2) {
        handleInvoiceFilesChange([...invoiceFiles, imageFile]);
      } else {
        assigned = false;
      }

      if (!assigned) return; // both invoice page slots already full — leave it in the inbox

      fetch(`/inbox/${item.id}`, { method: 'DELETE' }).catch(() => {});
      setInboxItems(prev => prev.filter(i => i.id !== item.id));
    } catch {}
  };

  const handleLaunchBrowser = async (resolvedProducts: ResolvedProduct[]) => {
    setLaunchStatus('loading');
    setScreenshotUrl(null);
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

  const canExtract = invoiceFiles.length > 0 && status !== 'loading';
  const pipelineInputsValid = !!pipelineDcNumber.trim() && pipelineSupplierId !== null;

  if (window.location.pathname === '/inbox-upload') {
    return <InboxUploadPage />;
  }

  // Normalize a trailing slash so /admin and /admin/ both resolve here.
  if (window.location.pathname.replace(/\/$/, '') === '/admin') {
    return <AdminPage />;
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
          <a
            href="/admin"
            style={{
              marginLeft: 'auto',
              padding: '6px 14px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text-secondary)',
              fontSize: '13px',
              fontWeight: 600,
              textDecoration: 'none',
              flexShrink: 0,
            }}
          >
            Admin
          </a>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="DC Number"
              value={pipelineDcNumber}
              onChange={e => setPipelineDcNumber(e.target.value)}
              style={{ ...inputStyle, width: 130 }}
            />
            <SupplierAutocomplete
              options={pipelineSuppliers.map(s => ({ id: String(s.id), label: s.name }))}
              value={pipelineSuppliers.find(s => s.id === pipelineSupplierId)?.name ?? ''}
              onSelect={id => setPipelineSupplierId(Number(id))}
              placeholder="Search supplier…"
              style={{ width: 220 }}
            />
            <button
              onClick={handleFetchFromPipeline}
              disabled={!pipelineInputsValid || pipelineFetching}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 14px',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: pipelineInputsValid ? 'var(--accent)' : 'var(--border)',
                color: pipelineInputsValid ? '#fff' : 'var(--text-muted)',
                fontSize: '13px',
                fontWeight: 500,
                cursor: !pipelineInputsValid || pipelineFetching ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {pipelineFetching && <Spinner />}
              {pipelineFetching ? 'Fetching…' : 'Fetch from Pipeline'}
            </button>
            {pipelineFetchError && (
              <span style={{ fontSize: '12px', color: 'var(--error)' }}>{pipelineFetchError}</span>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
              marginTop: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--border)',
            }}
          >
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
                    <div style={{ position: 'relative' }}>
                      <img
                        src={item.thumbnail_url}
                        alt=""
                        style={{ width: 100, height: 80, objectFit: 'cover', display: 'block' }}
                      />
                      <span
                        style={{
                          position: 'absolute',
                          top: 4,
                          left: 4,
                          fontSize: '9px',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.03em',
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: item.photo_type === 'package' ? 'var(--accent)' : 'rgba(0,0,0,0.55)',
                          color: '#fff',
                        }}
                      >
                        {item.photo_type}
                      </span>
                    </div>
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
          <SectionCard title="Upload Invoice (up to 2 pages)" icon={<UploadSectionIcon />}>
            <ImageUpload
              onFilesChange={handleInvoiceFilesChange}
              selectedFiles={invoiceFiles}
              previewUrls={invoicePreviews}
              disabled={status === 'loading'}
              maxFiles={2}
              onRemove={handleInvoiceRemove}
            />
          </SectionCard>

          {/* Optional product image */}
          <SectionCard title="Product's Image (optional)" icon={<UploadSectionIcon />}>
            <ImageUpload
              onFilesChange={files => { const f = files[0]; if (f) handleProductImageSelect(f); }}
              selectedFiles={productImage ? [productImage] : []}
              previewUrls={productImagePreviewUrl ? [productImagePreviewUrl] : []}
              disabled={status === 'loading'}
              onRemove={handleProductImageClear}
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
            Use <strong>Lite</strong> for smaller DCs &nbsp;·&nbsp; <strong>Lite 2</strong>, <strong>Pro</strong>, or <strong>Pro 2</strong> with reasoning turned on for larger DCs
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
                <SupplierAutocomplete
                  options={suppliers.map(s => ({ id: s, label: s }))}
                  value={supplier}
                  onSelect={(_, label) => setSupplier(label)}
                  placeholder="Type to search supplier…"
                />
              </label>
              <label style={labelStyle}>
                <span style={labelText}>Checked By</span>
                <select
                  style={inputStyle}
                  value={checkedBy}
                  onChange={e => setCheckedBy(e.target.value)}
                >
                  <option value="">— Select staff —</option>
                  {staffNames.map(s => (
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
                style={{ width: '100%', borderRadius: 'var(--radius-sm)', display: 'block' }}
              />
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

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

/** rapidfuzz-style partial ratio (0-100): best-matching window of `label` against `query`,
 * with a bonus for an exact substring hit. Mirrors the >=55 threshold the backend already
 * uses for supplier fuzzy-matching (see `_match_supplier` in routes/extract.py).
 * Windows within +/-2 chars of the query length so a single typo'd insertion/deletion
 * (not just substitution) still lines up against the right slice of the label. */
function fuzzyScore(query: string, label: string): number {
  if (!query) return 0;
  const idx = label.indexOf(query);
  if (idx !== -1) return 100 - idx * 0.1;

  const qLen = query.length;
  if (label.length <= qLen + 2) {
    const dist = levenshtein(query, label);
    return 100 * (1 - dist / Math.max(qLen, label.length));
  }

  let best = 0;
  const minLen = Math.max(1, qLen - 2);
  const maxLen = qLen + 2;
  for (let winLen = minLen; winLen <= maxLen; winLen++) {
    for (let i = 0; i <= label.length - winLen; i++) {
      const dist = levenshtein(query, label.slice(i, i + winLen));
      const ratio = 100 * (1 - dist / Math.max(qLen, winLen));
      if (ratio > best) best = ratio;
    }
  }
  return best;
}

interface AutocompleteOption {
  id: string;
  label: string;
}

function SupplierAutocomplete({
  options,
  value,
  onSelect,
  placeholder,
  style,
}: {
  options: AutocompleteOption[];
  value: string;
  onSelect: (id: string, label: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  const updateRect = () => {
    const r = inputRef.current?.getBoundingClientRect();
    if (r) setRect({ top: r.bottom, left: r.left, width: r.width });
  };

  useEffect(() => {
    if (!open) return;
    updateRect();
    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);
    return () => {
      window.removeEventListener('scroll', updateRect, true);
      window.removeEventListener('resize', updateRect);
    };
  }, [open]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const matches = (() => {
    const q = query.trim().toUpperCase();
    if (!q) return options.slice(0, 8);
    return options
      .map(o => ({ o, score: fuzzyScore(q, o.label.toUpperCase()) }))
      .filter(m => m.score >= 55)
      .sort((a, b) => b.score - a.score || a.o.label.length - b.o.label.length)
      .slice(0, 8)
      .map(m => m.o);
  })();

  const select = (o: AutocompleteOption) => {
    onSelect(o.id, o.label);
    setQuery(o.label);
    setOpen(false);
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', ...style }}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={placeholder ?? 'Type to search…'}
        onChange={e => { setQuery(e.target.value); setOpen(true); setHighlightIdx(0); }}
        onFocus={() => { setOpen(true); updateRect(); }}
        onBlur={() => { setOpen(false); if (query !== value) setQuery(value); }}
        onKeyDown={e => {
          if (!open || matches.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx(i => Math.min(i + 1, matches.length - 1)); }
          if (e.key === 'ArrowUp')   { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); }
          if (e.key === 'Enter')     { e.preventDefault(); select(matches[highlightIdx]); }
          if (e.key === 'Escape')    { setOpen(false); }
        }}
        style={inputStyle}
      />
      {open && matches.length > 0 && rect && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed', top: rect.top + 4, left: rect.left, width: rect.width, zIndex: 1000,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)', maxHeight: 220, overflowY: 'auto',
          }}
        >
          {matches.map((o, i) => (
            <div
              key={o.id}
              onMouseDown={() => select(o)}
              onMouseEnter={() => setHighlightIdx(i)}
              style={{
                padding: '8px 12px', fontSize: '13px', cursor: 'pointer',
                background: i === highlightIdx ? 'var(--accent-light)' : 'transparent',
                color: 'var(--text-primary)',
              }}
            >
              {o.label}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
