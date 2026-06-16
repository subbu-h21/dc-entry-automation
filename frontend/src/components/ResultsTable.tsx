import { useState, useRef, useEffect, Fragment } from 'react';
import * as XLSX from 'xlsx';
import { AlertIcon, CopyIcon, BrowserIcon, CheckSmIcon, MiniSpinner, MiniSpinnerDark, MicIcon, StopRecIcon } from './icons';

export interface Candidate {
  index: number;
  id: number;
  product: string;
  pack: string;
  mfr: string;
  score: number;
  ai_pick?: boolean;
}

export interface Product {
  product_name: string;
  batch_number: string;
  expiry: string;
  old_mrp: number;
  mrp: number;
  rate: number;
  quantity: number;
  free: number;
  disc_percent: number;
  matched_product: string | null;
  matched_pack: string | null;
  match_confidence: number | null;
  not_stocked: boolean;
  top_candidates: Candidate[];
  gemini_pick: Candidate | null;
}

interface Override {
  product: string | null;
  pack: string | null;
}

export interface ResolvedProduct {
  matched_product: string;
  batch_number: string;
  expiry: string;
  old_mrp: number;
  mrp: number;
  rate: number;
  quantity: number;
  free: number;
  disc_percent: number;
}

interface VoiceUpdate {
  row: number;
  field: string;
  value: string | number;
}

interface VoiceDCUpdate {
  field: string;
  value: string;
}

const FIELD_LABELS: Record<string, string> = {
  quantity: 'Qty', mrp: 'MRP', old_mrp: 'Old MRP', rate: 'Rate',
  disc_percent: 'Disc%', free: 'Free', batch_number: 'Batch',
  expiry: 'Expiry', product_name: 'Product Name',
};

const DC_FIELD_LABELS: Record<string, string> = {
  dc_number: 'DC Number', dc_date: 'Date',
  supplier: 'Supplier', checked_by: 'Checked By',
};

const PULSE = `@keyframes vcPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(1.5)} }`;

interface Props {
  products: Product[];
  onOpenDCEntry: (resolved: ResolvedProduct[]) => void;
  launchStatus: 'idle' | 'loading' | 'open';
  onDCUpdate: (field: string, value: string) => void;
}

export default function ResultsTable({ products, onOpenDCEntry, launchStatus, onDCUpdate }: Props) {
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [pending, setPending]         = useState<Record<number, Override | null>>({});
  const [overrides, setOverrides]     = useState<Record<number, Override | null>>({});
  const [fieldOverrides, setFieldOverrides] = useState<Record<number, Partial<Product>>>({});
  const [editingCell, setEditingCell] = useState<{ idx: number; field: keyof Product } | null>(null);
  const [cellDraft, setCellDraft]     = useState('');

  // ── Voice command state ──────────────────────────────────────
  const [voiceRecording, setVoiceRecording]   = useState(false);
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceUpdates, setVoiceUpdates]       = useState<VoiceUpdate[]>([]);
  const [voiceDCUpdates, setVoiceDCUpdates]   = useState<VoiceDCUpdate[]>([]);
  const [voiceError, setVoiceError]           = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef   = useRef<Blob[]>([]);

  const resolvedProduct = (idx: number) =>
    overrides[idx] !== undefined ? overrides[idx] : {
      product: products[idx].matched_product,
      pack:    products[idx].matched_pack,
    };

  function resolvedField<K extends keyof Product>(idx: number, field: K): Product[K] {
    const ov = fieldOverrides[idx]?.[field];
    return (ov !== undefined ? ov : products[idx][field]) as Product[K];
  }

  const startEdit = (idx: number, field: keyof Product) => {
    setCellDraft(String(resolvedField(idx, field) ?? ''));
    setEditingCell({ idx, field });
  };

  const commitEdit = (idx: number, field: keyof Product, isNumeric: boolean) => {
    const trimmed = cellDraft.trim();
    if (isNumeric) {
      const val = parseFloat(trimmed);
      if (!isNaN(val) && val >= 0) {
        setFieldOverrides(prev => ({ ...prev, [idx]: { ...(prev[idx] ?? {}), [field]: val } }));
      }
    } else if (trimmed) {
      setFieldOverrides(prev => ({ ...prev, [idx]: { ...(prev[idx] ?? {}), [field]: trimmed } }));
    }
    setEditingCell(null);
  };

  const renderEdit = (
    idx: number,
    field: keyof Product,
    isNumeric: boolean,
    inputWidth: number,
    displayNode: React.ReactNode,
    inputAlign: React.CSSProperties['textAlign'] = 'center',
  ) => {
    const editing = editingCell?.idx === idx && editingCell?.field === field;
    if (editing) {
      return (
        <input
          type={isNumeric ? 'number' : 'text'}
          min={isNumeric ? '0' : undefined}
          step={isNumeric ? 'any' : undefined}
          value={cellDraft}
          autoFocus
          onChange={e => setCellDraft(e.target.value)}
          onBlur={() => commitEdit(idx, field, isNumeric)}
          onKeyDown={e => {
            if (e.key === 'Enter') commitEdit(idx, field, isNumeric);
            if (e.key === 'Escape') setEditingCell(null);
          }}
          style={{
            width: inputWidth, textAlign: inputAlign, padding: '2px 6px',
            border: '1.5px solid var(--accent)', borderRadius: 6,
            fontSize: '12px', outline: 'none', boxSizing: 'border-box',
          }}
        />
      );
    }
    const modified = fieldOverrides[idx]?.[field] !== undefined;
    return (
      <span
        title="Click to edit"
        onClick={() => startEdit(idx, field)}
        style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 2 }}
      >
        {displayNode}
        {modified && <span style={{ fontSize: '9px', opacity: 0.7, color: 'var(--accent)' }}>✎</span>}
      </span>
    );
  };

  const hasMatching = products.some(p => p.top_candidates !== undefined);

  const totalValue = products.reduce((sum, _, idx) =>
    sum + resolvedField(idx, 'rate') * resolvedField(idx, 'quantity'), 0
  );

  const downloadExcel = () => {
    const rows = products.map((_, i) => {
      const r = resolvedProduct(i);
      return {
        'SL':         i + 1,
        'Name':       r?.product ?? resolvedField(i, 'product_name'),
        'Batch':      resolvedField(i, 'batch_number'),
        'Expiry (mm-yy)': resolvedField(i, 'expiry'),
        'MRP':        resolvedField(i, 'mrp') || '',
        'Rate':       resolvedField(i, 'rate') || '',
        'Qty':        resolvedField(i, 'quantity'),
        'Free':       resolvedField(i, 'free') || '',
        'Disc%':      resolvedField(i, 'disc_percent') || '',
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'DC Products');
    XLSX.writeFile(wb, 'dc_products.xlsx');
  };

  const matchedCount    = products.filter((_, i) => resolvedProduct(i)?.product).length;
  const notStockedCount = products.filter((p, i) => !resolvedProduct(i)?.product && (p.not_stocked || p.top_candidates?.length === 0)).length;

  const openPicker = (idx: number) => {
    const cur = resolvedProduct(idx);
    setPending(prev => ({ ...prev, [idx]: cur ?? null }));
    setExpandedRow(idx);
  };

  const applyPicker = (idx: number) => {
    setOverrides(prev => ({ ...prev, [idx]: pending[idx] ?? null }));
    setExpandedRow(null);
  };

  // ── Voice handlers ───────────────────────────────────────────
  const startVoice = async () => {
    setVoiceError(''); setVoiceTranscript(''); setVoiceUpdates([]);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const rec = new MediaRecorder(stream, { mimeType: mime });
      audioChunksRef.current = [];
      rec.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mime });
        setVoiceProcessing(true);
        try {
          const fd = new FormData();
          fd.append('audio', blob, mime.includes('ogg') ? 'recording.ogg' : 'recording.webm');
          fd.append('products', JSON.stringify(products));
          const res = await fetch('/voice/command', { method: 'POST', body: fd });
          if (!res.ok) { setVoiceError(`Error ${res.status}: ${(await res.text()).slice(0, 100)}`); return; }
          const data = await res.json();
          setVoiceTranscript(data.transcription ?? '');
          setVoiceUpdates(data.updates ?? []);
          setVoiceDCUpdates(data.dc_updates ?? []);
          if (!(data.updates ?? []).length && !(data.dc_updates ?? []).length && data.transcription)
            setVoiceError("Couldn't parse a command. Try: \"Row 1 change qty to 5\" or \"DC number is DC-123\"");
        } catch { setVoiceError('Network error — is the backend running?'); }
        finally { setVoiceProcessing(false); }
      };
      rec.start();
      mediaRecorderRef.current = rec;
      setVoiceRecording(true);
    } catch { setVoiceError('Microphone access denied.'); }
  };

  const stopVoice = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setVoiceRecording(false);
  };

  const applyVoiceUpdates = () => {
    setFieldOverrides(prev => {
      const next = { ...prev };
      for (const u of voiceUpdates) {
        if (u.row < 0 || u.row >= products.length) continue;
        next[u.row] = { ...(next[u.row] ?? {}), [u.field]: u.value };
      }
      return next;
    });
    for (const u of voiceDCUpdates) {
      onDCUpdate(u.field, u.value);
    }
    dismissVoice();
  };

  const dismissVoice = () => { setVoiceTranscript(''); setVoiceUpdates([]); setVoiceDCUpdates([]); setVoiceError(''); };

  if (products.length === 0) {
    return (
      <EmptyState
        icon={<AlertIcon color="var(--warning)" />}
        bg="var(--warning-light)"
        title="No products found"
        body="The image may not contain a recognisable invoice table."
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Stats + actions bar */}
      <div style={{
        background: 'var(--surface)', borderRadius: 'var(--radius)',
        border: '1px solid var(--border)', padding: '12px 16px',
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        boxShadow: 'var(--shadow-sm)',
      }}>
        <Pill label={`${products.length} extracted`}  color="var(--accent)"  bg="var(--accent-light)"  />
        {hasMatching && <Pill label={`${matchedCount} matched`}  color="var(--success)" bg="var(--success-light)" />}
        {notStockedCount > 0 && <Pill label={`${notStockedCount} not stocked`} color="var(--warning)" bg="var(--warning-light)" />}
        <div style={{ flex: 1 }} />
        <button onClick={downloadExcel} style={secondaryBtn(false)}>
          <CopyIcon color="var(--text-secondary)" />
          Download Excel
        </button>
        <button
          onClick={voiceRecording ? stopVoice : startVoice}
          disabled={voiceProcessing}
          title={voiceRecording ? 'Stop recording' : 'Voice command'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, position: 'relative',
            background: voiceRecording ? '#fef2f2' : 'var(--surface)',
            border: `1px solid ${voiceRecording ? '#ef4444' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', padding: '6px 12px',
            fontSize: '13px', fontWeight: 500,
            color: voiceRecording ? '#ef4444' : voiceProcessing ? 'var(--text-muted)' : 'var(--text-secondary)',
            cursor: voiceProcessing ? 'not-allowed' : 'pointer', transition: 'all 0.2s',
          }}
        >
          <style>{PULSE}</style>
          {voiceProcessing
            ? <><MiniSpinnerDark />Processing…</>
            : voiceRecording
              ? <><StopRecIcon color="#ef4444" />Stop</>
              : <><MicIcon color="var(--text-secondary)" />Voice</>}
          {voiceRecording && (
            <span style={{
              position: 'absolute', top: 5, right: 5, width: 6, height: 6,
              borderRadius: '50%', background: '#ef4444',
              animation: 'vcPulse 1s ease-in-out infinite',
            }} />
          )}
        </button>
        <button
          onClick={() => {
            const resolved: ResolvedProduct[] = products
              .map((_, i) => {
                const rp = resolvedProduct(i);
                if (!rp?.product) return null;  // "Not in catalog" — skip entirely
                return {
                  matched_product: rp.product,
                  batch_number: resolvedField(i, 'batch_number'),
                  expiry: resolvedField(i, 'expiry'),
                  old_mrp: resolvedField(i, 'old_mrp'),
                  mrp: resolvedField(i, 'mrp'),
                  rate: resolvedField(i, 'rate'),
                  quantity: resolvedField(i, 'quantity'),
                  free: resolvedField(i, 'free'),
                  disc_percent: resolvedField(i, 'disc_percent'),
                };
              })
              .filter((r): r is ResolvedProduct => r !== null);
            onOpenDCEntry(resolved);
          }}
          disabled={launchStatus === 'loading'}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '7px 14px', borderRadius: 'var(--radius-sm)', border: 'none',
            background: launchStatus === 'open' ? 'var(--success)' : 'linear-gradient(135deg,#2563eb,#1d4ed8)',
            color: '#fff', fontSize: '13px', fontWeight: 600,
            cursor: launchStatus === 'loading' ? 'not-allowed' : 'pointer',
            opacity: launchStatus === 'loading' ? 0.7 : 1,
            boxShadow: '0 2px 8px rgba(37,99,235,0.3)', transition: 'all 0.2s',
          }}
        >
          {launchStatus === 'loading' ? <MiniSpinner /> : launchStatus === 'open' ? <CheckSmIcon color="#fff" /> : <BrowserIcon />}
          {launchStatus === 'loading' ? 'Launching…' : launchStatus === 'open' ? 'Browser open' : 'Open DC Entry'}
        </button>
      </div>

      {/* Voice result panel */}
      {(voiceTranscript || voiceUpdates.length > 0 || voiceDCUpdates.length > 0 || voiceError) && (
        <div style={{
          background: 'var(--surface)', borderRadius: 'var(--radius)',
          border: '1px solid var(--border)', padding: '12px 16px',
          boxShadow: 'var(--shadow-sm)', fontSize: '13px', display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {voiceTranscript && (
            <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic', margin: 0 }}>"{voiceTranscript}"</p>
          )}
          {(voiceUpdates.length > 0 || voiceDCUpdates.length > 0) && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {voiceUpdates.map((u, i) => (
                  <div key={`pu-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '12px' }}>
                    <span style={{ background: 'var(--accent-light)', color: 'var(--accent)', borderRadius: 4, padding: '1px 7px', fontWeight: 600 }}>
                      Row {u.row + 1}
                    </span>
                    <span style={{ color: 'var(--text-secondary)' }}>{FIELD_LABELS[u.field] ?? u.field}</span>
                    <span style={{ color: 'var(--text-muted)' }}>→</span>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{String(u.value)}</span>
                  </div>
                ))}
                {voiceDCUpdates.map((u, i) => (
                  <div key={`dc-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '12px' }}>
                    <span style={{ background: '#f0fdf4', color: 'var(--success)', borderRadius: 4, padding: '1px 7px', fontWeight: 600 }}>
                      DC
                    </span>
                    <span style={{ color: 'var(--text-secondary)' }}>{DC_FIELD_LABELS[u.field] ?? u.field}</span>
                    <span style={{ color: 'var(--text-muted)' }}>→</span>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{u.value}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={applyVoiceUpdates} style={{
                  background: 'var(--accent)', color: '#fff', border: 'none',
                  borderRadius: 6, padding: '5px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                }}>Apply</button>
                <button onClick={dismissVoice} style={{
                  background: 'transparent', color: 'var(--text-secondary)',
                  border: '1px solid var(--border)', borderRadius: 6,
                  padding: '5px 12px', fontSize: '12px', cursor: 'pointer',
                }}>Dismiss</button>
              </div>
            </>
          )}
          {voiceError && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <span style={{ color: 'var(--error)', fontSize: '12px' }}>{voiceError}</span>
              <button onClick={dismissVoice} style={{
                background: 'transparent', color: 'var(--text-secondary)',
                border: '1px solid var(--border)', borderRadius: 6,
                padding: '3px 10px', fontSize: '12px', cursor: 'pointer',
              }}>Dismiss</button>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div style={{
        background: 'var(--surface)', borderRadius: 'var(--radius)',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden',
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)' }}>
                <th style={th}>#</th>
                <th style={{ ...th, textAlign: 'left', minWidth: 200 }}>Product Name (Invoice)</th>
                {hasMatching && (
                  <>
                    <th style={{ ...th, textAlign: 'left', minWidth: 240 }}>Matched CRM Product</th>
                    <th style={{ ...th, minWidth: 80 }}>Pack</th>
                    <th style={{ ...th, minWidth: 85 }}>Confidence</th>
                  </>
                )}
                <th style={{ ...th, minWidth: 60 }}>Free</th>
                <th style={{ ...th, minWidth: 70 }}>Qty</th>
                <th style={{ ...th, minWidth: 110 }}>Batch</th>
                <th style={{ ...th, minWidth: 80 }}>Expiry</th>
                <th style={{ ...th, minWidth: 75 }}>Old MRP</th>
                <th style={{ ...th, minWidth: 75 }}>MRP</th>
                <th style={{ ...th, minWidth: 75 }}>Rate</th>
                <th style={{ ...th, minWidth: 70 }}>Disc%</th>
                {hasMatching && <th style={{ ...th, minWidth: 80 }}>Value</th>}
              </tr>
            </thead>
            <tbody>
              {products.map((p, idx) => {
                const resolved = resolvedProduct(idx);
                const isOpen   = expandedRow === idx;
                const modified = overrides[idx] !== undefined;

                return (
                  <Fragment key={idx}>
                    <tr
                      style={{
                        background: isOpen ? 'var(--accent-light)' : idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                        transition: 'background 0.15s',
                      }}
                    >
                      <td style={{ ...td, textAlign: 'center', color: 'var(--text-muted)', fontWeight: 500 }}>{idx + 1}</td>

                      {/* Product Name */}
                      <td style={{ ...td, fontWeight: 500, color: 'var(--text-primary)' }}>
                        {renderEdit(idx, 'product_name', false, 180,
                          <span style={{ fontWeight: 500, color: fieldOverrides[idx]?.product_name ? 'var(--accent)' : 'var(--text-primary)' }}>
                            {resolvedField(idx, 'product_name')}
                          </span>,
                          'left',
                        )}
                      </td>

                      {hasMatching && (
                        <>
                          <td style={td}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {resolved?.product ? (
                                <span style={{ fontWeight: 500, color: modified ? 'var(--accent)' : 'var(--text-primary)' }}>
                                  {resolved.product}
                                  {modified && <span style={{ fontSize: '10px', marginLeft: 4, color: 'var(--accent)' }}>edited</span>}
                                </span>
                              ) : p.not_stocked ? (
                                <span style={pill('var(--warning)', 'var(--warning-light)')}>Not stocked</span>
                              ) : (
                                <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>No match</span>
                              )}
                              {hasMatching && (
                                <button
                                  onClick={() => isOpen ? setExpandedRow(null) : openPicker(idx)}
                                  style={{
                                    marginLeft: 'auto', flexShrink: 0,
                                    background: isOpen ? 'var(--accent)' : 'var(--surface)',
                                    border: `1px solid ${isOpen ? 'var(--accent)' : 'var(--border)'}`,
                                    borderRadius: 6, padding: '3px 9px', fontSize: '11px',
                                    fontWeight: 600, cursor: 'pointer',
                                    color: isOpen ? '#fff' : 'var(--text-secondary)',
                                    transition: 'all 0.15s',
                                  }}
                                >
                                  {isOpen ? 'Close' : 'Change'}
                                </button>
                              )}
                            </div>
                          </td>

                          <td style={{ ...td, textAlign: 'center' }}>
                            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                              {resolved?.pack ?? '—'}
                            </span>
                          </td>

                          <td style={{ ...td, textAlign: 'center' }}>
                            {p.match_confidence != null && p.match_confidence >= 0 ? (
                              <ConfBadge value={p.match_confidence} />
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>—</span>
                            )}
                          </td>
                        </>
                      )}

                      {/* Free */}
                      <td style={{ ...td, textAlign: 'center' }}>
                        {renderEdit(idx, 'free', true, 60,
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {resolvedField(idx, 'free') > 0 ? resolvedField(idx, 'free') : '—'}
                          </span>,
                        )}
                      </td>

                      {/* Qty */}
                      <td style={{ ...td, textAlign: 'center' }}>
                        {renderEdit(idx, 'quantity', true, 64,
                          <span style={pill('var(--accent)', 'var(--accent-light)')}>
                            {resolvedField(idx, 'quantity')}
                          </span>,
                        )}
                      </td>

                      {/* Batch */}
                      <td style={{ ...td, textAlign: 'center' }}>
                        {renderEdit(idx, 'batch_number', false, 100,
                          <span style={{ fontFamily: 'monospace', fontSize: '12px', background: '#f1f5f9', borderRadius: 6, padding: '2px 8px', color: 'var(--text-secondary)', letterSpacing: '0.04em' }}>
                            {resolvedField(idx, 'batch_number')}
                          </span>,
                        )}
                      </td>

                      {/* Expiry */}
                      <td style={{ ...td, textAlign: 'center' }}>
                        {renderEdit(idx, 'expiry', false, 70,
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {resolvedField(idx, 'expiry') || '—'}
                          </span>,
                        )}
                      </td>

                      {/* Old MRP */}
                      <td style={{ ...td, textAlign: 'right' }}>
                        {renderEdit(idx, 'old_mrp', true, 70,
                          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            {resolvedField(idx, 'old_mrp') > 0 ? resolvedField(idx, 'old_mrp').toFixed(2) : '—'}
                          </span>,
                          'right',
                        )}
                      </td>

                      {/* MRP */}
                      <td style={{ ...td, textAlign: 'right' }}>
                        {renderEdit(idx, 'mrp', true, 70,
                          <span style={{ fontSize: '12px' }}>
                            {resolvedField(idx, 'mrp') > 0 ? resolvedField(idx, 'mrp').toFixed(2) : '—'}
                          </span>,
                          'right',
                        )}
                      </td>

                      {/* Rate */}
                      <td style={{ ...td, textAlign: 'right' }}>
                        {renderEdit(idx, 'rate', true, 70,
                          <span style={{ fontSize: '12px' }}>
                            {resolvedField(idx, 'rate') > 0 ? resolvedField(idx, 'rate').toFixed(2) : '—'}
                          </span>,
                          'right',
                        )}
                      </td>

                      {/* Disc% */}
                      <td style={{ ...td, textAlign: 'center' }}>
                        {renderEdit(idx, 'disc_percent', true, 60,
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {resolvedField(idx, 'disc_percent') > 0 ? `${resolvedField(idx, 'disc_percent')}%` : '—'}
                          </span>,
                        )}
                      </td>

                      {hasMatching && (
                        <td style={{ ...td, textAlign: 'right' }}>
                          <span style={{ fontSize: '12px' }}>
                            {(resolvedField(idx, 'rate') * resolvedField(idx, 'quantity')).toFixed(2)}
                          </span>
                        </td>
                      )}
                    </tr>

                    {/* ── Inline candidate picker ── */}
                    {isOpen && (
                      <tr>
                        <td colSpan={hasMatching ? 14 : 10} style={{ padding: 0, borderBottom: '2px solid var(--accent)' }}>
                          <CandidatePicker
                            product={p}
                            current={pending[idx] ?? null}
                            onChange={val => setPending(prev => ({ ...prev, [idx]: val }))}
                            onApply={() => applyPicker(idx)}
                            onCancel={() => setExpandedRow(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            {hasMatching && (
              <tfoot>
                <tr style={{ background: 'var(--surface-2)', borderTop: '2px solid var(--border)' }}>
                  <td colSpan={13} style={{ ...td, textAlign: 'right', fontWeight: 600, fontSize: '12px', color: 'var(--text-secondary)', borderBottom: 'none' }}>
                    Total Value
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)', borderBottom: 'none' }}>
                    {totalValue.toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

/* ─── Candidate Picker ────────────────────────────────────── */

interface SearchResult { product: string; pack: string; score: number; }

function CandidatePicker({
  product,
  current,
  onChange,
  onApply,
  onCancel,
}: {
  product: Product;
  current: Override | null;
  onChange: (v: Override | null) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`/products/search?q=${encodeURIComponent(searchQuery)}`);
        if (res.ok) setSearchResults((await res.json()).results ?? []);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const candidates: (Candidate & { extra?: boolean })[] = [...(product.top_candidates ?? [])];
  if (product.gemini_pick) candidates.push({ ...product.gemini_pick, extra: true });

  const radioName = `cand-${product.product_name}`;
  const isSearching = searchQuery.trim().length >= 2;

  const renderOption = (
    key: string,
    productName: string,
    pack: string,
    tags: React.ReactNode,
  ) => {
    const selected = current?.product === productName;
    return (
      <label
        key={key}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
          background: selected ? '#bae6fd' : 'transparent',
          marginBottom: 3, transition: 'background 0.12s',
        }}
      >
        <input
          type="radio"
          name={radioName}
          checked={selected}
          onChange={() => onChange({ product: productName, pack })}
          style={{ accentColor: '#0369a1', flexShrink: 0 }}
        />
        <span style={{ fontWeight: 500, color: '#1e3a5f', flex: 1, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {productName}
        </span>
        <span style={{ fontSize: '11px', color: '#64748b', flexShrink: 0 }}>{pack}</span>
        {tags}
      </label>
    );
  };

  return (
    <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderTop: 'none', padding: '14px 20px' }}>
      <p style={{ fontSize: '12px', fontWeight: 700, color: '#0369a1', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Select correct product
      </p>

      {/* Search box */}
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search product database…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '7px 32px 7px 10px', borderRadius: 7,
            border: '1.5px solid #7dd3fc', fontSize: '13px',
            background: '#fff', color: '#1e3a5f', outline: 'none',
          }}
        />
        {searchLoading && (
          <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: '11px', color: '#0369a1' }}>
            ···
          </span>
        )}
        {searchQuery && !searchLoading && (
          <button
            onClick={() => { setSearchQuery(''); setSearchResults([]); }}
            style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#64748b', fontSize: '14px', lineHeight: 1, padding: '0 2px',
            }}
          >×</button>
        )}
      </div>

      {/* Results: search hits OR preset candidates */}
      {isSearching ? (
        searchResults.length > 0 ? searchResults.map((r, i) =>
          renderOption(
            `sr-${i}`, r.product, r.pack,
            <span style={{ background: '#e0f2fe', color: '#0369a1', padding: '1px 7px', borderRadius: 6, fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>
              {r.score}
            </span>,
          )
        ) : !searchLoading && (
          <p style={{ fontSize: '12px', color: '#64748b', padding: '4px 10px', marginBottom: 6 }}>No results found.</p>
        )
      ) : (
        candidates.map((cand, i) =>
          renderOption(
            `cand-${i}`, cand.product, cand.pack,
            <>
              <span style={{ background: '#e0f2fe', color: '#0369a1', padding: '1px 7px', borderRadius: 6, fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>
                {cand.score}
              </span>
              {cand.ai_pick && (
                <span style={{ background: '#7c3aed', color: '#fff', padding: '1px 7px', borderRadius: 6, fontSize: '10px', fontWeight: 700, flexShrink: 0 }}>AI</span>
              )}
              {cand.extra && (
                <span style={{ background: '#fef3c7', color: '#92400e', padding: '1px 7px', borderRadius: 6, fontSize: '10px', flexShrink: 0 }}>outside top 10</span>
              )}
            </>,
          )
        )
      )}

      {/* Not in catalog */}
      <label style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
        background: current === null ? '#fee2e2' : 'transparent',
        marginTop: 4, marginBottom: 10, transition: 'background 0.12s',
      }}>
        <input
          type="radio"
          name={radioName}
          checked={current === null}
          onChange={() => onChange(null)}
          style={{ accentColor: '#dc2626', flexShrink: 0 }}
        />
        <span style={{ fontSize: '13px', color: '#dc2626', fontStyle: 'italic' }}>Not in catalog</span>
      </label>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onApply} style={{ background: '#0369a1', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 18px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
          Apply
        </button>
        <button onClick={onCancel} style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 14px', fontSize: '13px', cursor: 'pointer' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ─── Small reusable components ──────────────────────────── */

function EmptyState({ icon, bg, title, body }: { icon: React.ReactNode; bg: string; title: string; body: string }) {
  return (
    <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', padding: '48px 24px', textAlign: 'center', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ width: 52, height: 52, borderRadius: '50%', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>{icon}</div>
      <p style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{title}</p>
      <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>{body}</p>
    </div>
  );
}

function Pill({ label, color, bg }: { label: string; color: string; bg: string }) {
  return <span style={{ background: bg, color, borderRadius: 20, padding: '3px 10px', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</span>;
}

function ConfBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--error)';
  const bg    = pct >= 80 ? 'var(--success-light)' : pct >= 50 ? 'var(--warning-light)' : 'var(--error-light)';
  return <span style={{ background: bg, color, borderRadius: 6, padding: '2px 8px', fontSize: '12px', fontWeight: 600 }}>{pct}%</span>;
}

function secondaryBtn(active: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6,
    background: active ? 'var(--success-light)' : 'var(--surface)',
    border: `1px solid ${active ? 'var(--success)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-sm)', padding: '6px 12px',
    fontSize: '13px', fontWeight: 500,
    color: active ? 'var(--success)' : 'var(--text-secondary)',
    cursor: 'pointer', transition: 'all 0.2s',
  };
}

function pill(color: string, bg: string): React.CSSProperties {
  return { display: 'inline-block', background: bg, color, borderRadius: 6, padding: '2px 10px', fontWeight: 600, fontSize: '12px' };
}

const th: React.CSSProperties = {
  padding: '11px 14px', textAlign: 'center',
  fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '11px 14px', borderBottom: '1px solid var(--border)',
  color: 'var(--text-primary)', verticalAlign: 'middle',
};
