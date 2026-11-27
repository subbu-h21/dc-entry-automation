import { useState, useRef, useEffect, Fragment } from 'react';
import * as XLSX from 'xlsx';
import { AlertIcon, CopyIcon, MiniSpinnerDark, MicIcon, StopRecIcon } from './icons';
import { useDcSubmit, DcDetails, DcRowInput } from './DcSubmitPanel';
import { Kn } from './Kn';

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
  value?: number;   // the row's printed Value, for the arithmetic check only
}

/** One cell the second check thinks is wrong. row null = the DC's number or date. */
export interface ReviewIssue {
  row: number | null;
  field: string;
  seen: string;
  reason: string;
  reason_kn?: string;  // the same reason in Kannada, when the check gave one
}

export interface ReviewState {
  status: 'idle' | 'running' | 'done' | 'failed' | 'not_run';
  issues: ReviewIssue[];
  missing_rows: { product_name: string; reason: string; reason_kn?: string }[];
}

/** Field names for the Kannada lines. Qty, Rate, MRP and Batch stay as staff say them. */
const FLAG_LABELS_KN: Record<string, string> = {
  quantity: 'Qty', free: 'Free (ಉಚಿತ)', mrp: 'MRP', old_mrp: 'ಹಳೆಯ MRP', rate: 'Rate',
  disc_percent: 'ರಿಯಾಯಿತಿ %', batch_number: 'Batch', expiry: 'Expiry', product_name: 'ಇನ್‌ವಾಯ್ಸ್ ಹೆಸರು',
  matched_product: 'ಆಯ್ಕೆಯಾದ ಉತ್ಪನ್ನ', dc_number: 'DC ಸಂಖ್ಯೆ', dc_date: 'DC ದಿನಾಂಕ',
};

/** The DC's printed totals; 0 or missing when not printed. */
export interface PrintedTotals {
  items?: number;
  qty?: number;
}

const NUMERIC_FIELDS = new Set(['quantity', 'free', 'mrp', 'old_mrp', 'rate', 'disc_percent']);
/** The batch goes into stock exactly as shown, so it's the easiest cell to read and check. */
const BATCH_STYLE: React.CSSProperties = {
  fontFamily: 'monospace', fontSize: '15px', fontWeight: 700, letterSpacing: '0.06em',
  color: '#1e293b', background: '#fef9c3', border: '1px solid #facc15', borderRadius: 6, padding: '3px 9px',
  whiteSpace: 'nowrap',
};
const FLAG_STYLE: React.CSSProperties ={ background: '#ffedd5', outline: '1.5px solid #fb923c', borderRadius: 4, padding: '0 3px' };
const money = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
/** Extraction strips everything but letters and digits from these and keeps the case, so Use does too. */
const lettersAndDigits = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');
/** "9/27", "09-27" and "09/2027" are one expiry. */
const expiryKey = (s: string) => {
  const m = /^\s*(\d{1,2})\D+(\d{2}|\d{4})\s*$/.exec(s);
  return m ? `${Number(m[1])}/${m[2].slice(-2)}` : s.trim().toUpperCase();
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** An expiry as MM/YY, from "9/27", "09-2027" or "SEP-27"; null when it isn't clearly one. */
const expiryFromDc = (s: string): string | null => {
  const m = /^\s*([A-Za-z]+|\d{1,2})\s*[-/.\s]\s*(\d{2}|\d{4})\s*$/.exec(s);
  if (!m) return null;
  const month = /^\d+$/.test(m[1]) ? Number(m[1]) : MONTHS.indexOf(m[1].slice(0, 3).toUpperCase()) + 1;
  if (month < 1 || month > 12 || (m[2].length === 4 && !m[2].startsWith('20'))) return null;
  return `${String(month).padStart(2, '0')}/${m[2].slice(-2)}`;
};
/** A number only when that's all the DC shows ("1,250.50", "12%"); "5+1" or "10 x 15" gets no Use. */
const plainNumber = (s: string): number | null => {
  const t = s.replace(/[,\s₹]/g, '').replace(/%$/, '');
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

interface Override {
  product: string | null;
  pack: string | null;
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
  dcDetails: DcDetails;
  onDCUpdate: (field: string, value: string) => void;
  review?: ReviewState;
  printedTotals?: PrintedTotals;
}

const NO_REVIEW: ReviewState = { status: 'idle', issues: [], missing_rows: [] };

type ViewMode = 'auto' | 'table' | 'cards';

export default function ResultsTable({ products, dcDetails, onDCUpdate, review = NO_REVIEW, printedTotals = {} }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem('dc_view_mode') as ViewMode) || 'table'; } catch { return 'table'; }
  });
  useEffect(() => {
    try { localStorage.setItem('dc_view_mode', viewMode); } catch { /* ignore */ }
  }, [viewMode]);

  const [highlightedRows, setHighlightedRows] = useState<Set<number>>(() => new Set());
  const toggleHighlight = (idx: number) => {
    setHighlightedRows(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [pending, setPending]         = useState<Record<number, Override | null>>({});
  const [overrides, setOverrides]     = useState<Record<number, Override | null>>({});
  const [fieldOverrides, setFieldOverrides] = useState<Record<number, Partial<Product>>>({});
  const [editingCell, setEditingCell] = useState<{ idx: number; field: keyof Product } | null>(null);
  const [cellDraft, setCellDraft]     = useState('');
  const [ignoredFlags, setIgnoredFlags] = useState<Set<string>>(() => new Set());

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
    const flag = cellFlag(idx, field);
    return (
      <span
        title={flag ?? 'Click to edit'}
        onClick={() => startEdit(idx, field)}
        style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 2, ...(flag ? FLAG_STYLE : {}) }}
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

  const dcRows: DcRowInput[] = products.map((_, i) => ({
    row: i,
    product_name: resolvedField(i, 'product_name'),
    matched_product: resolvedProduct(i)?.product ?? null,  // null = "Not in catalog", never sent
    matched_pack: resolvedProduct(i)?.pack ?? null,
    batch_number: resolvedField(i, 'batch_number'),
    expiry: resolvedField(i, 'expiry'),
    mrp: resolvedField(i, 'mrp'),
    rate: resolvedField(i, 'rate'),
    quantity: resolvedField(i, 'quantity'),
    free: resolvedField(i, 'free'),
    disc_percent: resolvedField(i, 'disc_percent'),
  }));
  const dcSubmit = useDcSubmit(dcRows, dcDetails);

  // ── Second check: the free arithmetic check, the printed totals, Claude's flags ──
  // A row adds up when its printed Value is within ₹1 of Rate × Qty, before or after the
  // discount. Suppliers print Value differently (some with tax), so a row is only flagged
  // when most of the DC's other rows do add up: then this one is the odd one out.
  const arithmetic = new Map<number, { en: string; kn: string }>();
  {
    const checkable = products.map((p, i) => {
      const value = Number(p.value) || 0;
      const rate = Number(resolvedField(i, 'rate')) || 0;
      const qty = Number(resolvedField(i, 'quantity')) || 0;
      const disc = Number(resolvedField(i, 'disc_percent')) || 0;
      if (value <= 0 || rate <= 0 || qty <= 0) return null;
      const plain = rate * qty;
      return { i, value, plain, disc, ok: Math.abs(value - plain) <= 1 || Math.abs(value - plain * (1 - disc / 100)) <= 1 };
    }).filter((r): r is { i: number; value: number; plain: number; disc: number; ok: boolean } => r !== null);
    for (const r of checkable) {
      if (r.ok) continue;
      const others = checkable.filter(o => o.i !== r.i);
      if (others.length && others.filter(o => o.ok).length > others.length / 2) {
        // Both figures the Value was compared with, so a correct discounted Value isn't read as a mistake
        const afterDisc = money(r.plain * (1 - r.disc / 100));
        const expected = r.disc > 0
          ? `Rate × Qty is ${money(r.plain)}, or ${afterDisc} after the ${r.disc}% discount`
          : `Rate × Qty is ${money(r.plain)}`;
        const expectedKn = r.disc > 0
          ? `Rate × Qty ${money(r.plain)}, ${r.disc}% ರಿಯಾಯಿತಿಯ ನಂತರ ${afterDisc}`
          : `Rate × Qty ${money(r.plain)}`;
        arithmetic.set(r.i, {
          en: `Value on the DC is ${money(r.value)} but ${expected}. Check Qty and Rate.`,
          kn: `DC ಯಲ್ಲಿ Value ${money(r.value)} ಇದೆ, ಆದರೆ ${expectedKn}. Qty ಮತ್ತು Rate ಪರಿಶೀಲಿಸಿ.`,
        });
      }
    }
  }
  // Keyed by which total, not by the text: the text follows staff edits, and an Ignore must stay ignored.
  const totalNotes: { key: string; text: string; kn: string }[] = [];
  if ((printedTotals.items ?? 0) > 0 && printedTotals.items !== products.length) {
    totalNotes.push({
      key: 'total|items',
      text: `The DC says ${printedTotals.items} items, the table has ${products.length}: a row may be missing or extra.`,
      kn: `DC ಯಲ್ಲಿ ${printedTotals.items} ಐಟಂಗಳಿವೆ, ಪಟ್ಟಿಯಲ್ಲಿ ${products.length} ಇವೆ: ಒಂದು ಸಾಲು ಬಿಟ್ಟುಹೋಗಿರಬಹುದು ಅಥವಾ ಹೆಚ್ಚಾಗಿರಬಹುದು.`,
    });
  }
  if ((printedTotals.qty ?? 0) > 0) {
    const paid = products.reduce((s, _, i) => s + (Number(resolvedField(i, 'quantity')) || 0), 0);
    const withFree = paid + products.reduce((s, _, i) => s + (Number(resolvedField(i, 'free')) || 0), 0);
    if (Math.abs(printedTotals.qty! - paid) > 0.01 && Math.abs(printedTotals.qty! - withFree) > 0.01) {
      totalNotes.push({
        key: 'total|qty',
        text: `The DC's total quantity is ${printedTotals.qty}, but the table adds up to ${withFree}${withFree !== paid ? ` (${paid} paid + ${withFree - paid} free)` : ''}.`,
        kn: `DC ಯ ಒಟ್ಟು Qty ${printedTotals.qty}, ಆದರೆ ಪಟ್ಟಿಯ ಒಟ್ಟು ${withFree}${withFree !== paid ? ` (${paid} ಪಾವತಿ + ${withFree - paid} ಉಚಿತ)` : ''}.`,
      });
    }
  }

  const flagKey = (f: ReviewIssue) => `${f.row ?? 'dc'}|${f.field}|${f.seen}`;
  /** What "Use" would put in the cell, or null when there's nothing safe to put. */
  const suggestion = (f: ReviewIssue): string | number | null => {
    if (f.field === 'matched_product') return null; // a different product is picked with Change
    if (NUMERIC_FIELDS.has(f.field)) return plainNumber(f.seen);
    if (f.field === 'dc_date') return /^\d{4}-\d{2}-\d{2}$/.test(f.seen) ? f.seen : null;
    if (f.field === 'dc_number' || f.field === 'batch_number') return lettersAndDigits(f.seen) || null;
    if (f.field === 'expiry') return expiryFromDc(f.seen);
    return f.seen;
  };
  /** Text compared the way the table stores it, so formatting alone never keeps a flag open. */
  const sameText = (field: string, a: string, b: string) => {
    if (field === 'dc_number' || field === 'batch_number') return lettersAndDigits(a).toUpperCase() === lettersAndDigits(b).toUpperCase();
    if (field === 'expiry') return expiryKey(a) === expiryKey(b);
    return a.trim().toUpperCase() === b.trim().toUpperCase();
  };
  const currentValue = (f: ReviewIssue): unknown => {
    if (f.row === null) return f.field === 'dc_number' ? dcDetails.dc_number : dcDetails.dc_date;
    return resolvedField(f.row, f.field as keyof Product);
  };
  /** Already done: the cell now holds what the DC shows, by Use or by typing. */
  const settledFlag = (f: ReviewIssue) => {
    if (f.field === 'matched_product' && f.row !== null) {
      // staff picked a product with Change, as the flag tells them to
      const picked = overrides[f.row];
      return picked !== undefined && (picked?.product ?? null) !== products[f.row].matched_product;
    }
    const s = suggestion(f);
    if (s === null) return false;
    const cur = currentValue(f);
    return typeof s === 'number' ? Number(cur) === s : sameText(f.field, String(cur ?? ''), s);
  };
  const openFlags = review.status === 'done'
    ? review.issues.filter(f => (f.row === null || f.row < products.length) && !ignoredFlags.has(flagKey(f)) && !settledFlag(f))
    : [];
  const useFlag = (f: ReviewIssue) => {
    const s = suggestion(f);
    if (s === null) return;
    if (f.row === null) onDCUpdate(f.field, String(s));
    else setFieldOverrides(prev => ({ ...prev, [f.row as number]: { ...(prev[f.row as number] ?? {}), [f.field]: s } }));
  };
  const ignoreFlag = (f: ReviewIssue) => setIgnoredFlags(prev => new Set(prev).add(flagKey(f)));
  // The free checks can be dismissed too: a misread Value or an odd "total items" can't be fixed in the table.
  const arithmeticKey = (i: number) => `arith|${i}|${products[i]?.value}`;
  const openArithmetic = [...arithmetic].filter(([i]) => !ignoredFlags.has(arithmeticKey(i)));
  const openTotalNotes = totalNotes.filter(n => !ignoredFlags.has(n.key));
  const missingKey = (m: { product_name: string }) => `missing|${m.product_name}`;
  const openMissing = review.status === 'done' ? review.missing_rows.filter(m => !ignoredFlags.has(missingKey(m))) : [];
  const openReviewCount = openFlags.length + openMissing.length;
  const ignoreKey = (key: string) => setIgnoredFlags(prev => new Set(prev).add(key));
  function cellFlag(idx: number, field: string): string | null {
    const claude = openFlags.find(f => f.row === idx && f.field === field);
    if (claude) return `The DC shows "${claude.seen}". ${claude.reason}${claude.reason_kn ? `\nDC ಯಲ್ಲಿ "${claude.seen}" ಇದೆ. ${claude.reason_kn}` : ''}`;
    const sum = arithmetic.get(idx);
    if ((field === 'quantity' || field === 'rate') && sum && !ignoredFlags.has(arithmeticKey(idx))) return `${sum.en}\n${sum.kn}`;
    return null;
  }
  const FLAG_LABELS: Record<string, string> = { ...FIELD_LABELS, ...DC_FIELD_LABELS, matched_product: 'Matched product', product_name: 'Invoice name' };
  const showSecondCheck = review.status !== 'idle' || openArithmetic.length > 0 || openTotalNotes.length > 0;

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
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
          {(['auto', 'table', 'cards'] as const).map(m => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              title={m === 'auto' ? 'Table on desktop, cards on mobile' : m === 'table' ? 'Always show the table' : 'Always show cards'}
              style={{
                padding: '6px 12px', fontSize: '12px', fontWeight: 600, border: 'none', cursor: 'pointer',
                background: viewMode === m ? 'var(--accent)' : 'var(--surface)',
                color: viewMode === m ? '#fff' : 'var(--text-secondary)',
              }}
            >
              {m === 'auto' ? 'Auto' : m === 'table' ? 'Table' : 'Cards'}
            </button>
          ))}
        </div>
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
        {dcSubmit.button}
      </div>

      {showSecondCheck && (
        <div style={{
          background: 'var(--surface)', borderRadius: 'var(--radius)', border: '1px solid var(--border)',
          padding: '12px 16px', boxShadow: 'var(--shadow-sm)', fontSize: '13px', display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--accent)' }}>Second check · ಎರಡನೇ ಪರಿಶೀಲನೆ</span>
          {review.status === 'running' && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <MiniSpinnerDark />
              <span>Double-checking the table against the photo…<Kn>ಫೋಟೋ ನೋಡಿ ಪಟ್ಟಿಯನ್ನು ಮತ್ತೊಮ್ಮೆ ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ…</Kn></span>
            </span>
          )}
          {review.status === 'failed' && (
            <span style={{ color: 'var(--text-muted)' }}>Second check couldn't run this time.<Kn>ಈ ಬಾರಿ ಎರಡನೇ ಪರಿಶೀಲನೆ ನಡೆಯಲಿಲ್ಲ.</Kn></span>
          )}
          {review.status === 'not_run' && (
            <span style={{ color: 'var(--text-muted)' }}>
              The second check doesn't run again after the page is refreshed.
              <Kn>ಪುಟವನ್ನು ರಿಫ್ರೆಶ್ ಮಾಡಿದ ಮೇಲೆ ಎರಡನೇ ಪರಿಶೀಲನೆ ಮತ್ತೆ ನಡೆಯುವುದಿಲ್ಲ.</Kn>
            </span>
          )}
          {review.status === 'done' && (openReviewCount > 0
            ? <strong>{openReviewCount} thing{openReviewCount === 1 ? '' : 's'} to look at<Kn>ನೋಡಬೇಕಾದವು: {openReviewCount}</Kn></strong>
            : review.issues.length + review.missing_rows.length === 0
              ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>The second check found nothing to look at.<Kn>ಎರಡನೇ ಪರಿಶೀಲನೆಯಲ್ಲಿ ನೋಡಬೇಕಾದದ್ದು ಏನೂ ಸಿಗಲಿಲ್ಲ.</Kn></span>
              : <span style={{ color: 'var(--success)', fontWeight: 600 }}>Everything the second check raised has been dealt with.<Kn>ಎರಡನೇ ಪರಿಶೀಲನೆ ತೋರಿಸಿದ ಎಲ್ಲವನ್ನೂ ನೋಡಲಾಗಿದೆ.</Kn></span>)}
          {openFlags.map(f => {
            const s = suggestion(f);
            return (
              <div key={flagKey(f)} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '6px 8px', background: '#fff7ed', borderRadius: 6 }}>
                <span style={{ flex: 1, minWidth: 220 }}>
                  <strong>{f.row === null ? 'DC' : `Row ${f.row + 1}`}, {FLAG_LABELS[f.field] ?? f.field}:</strong> the DC shows "{f.seen}". {f.reason}
                  {f.field === 'matched_product' && ' Pick the right product with Change.'}
                  <Kn>
                    <strong>{f.row === null ? 'DC' : `ಸಾಲು ${f.row + 1}`}, {FLAG_LABELS_KN[f.field] ?? FLAG_LABELS[f.field] ?? f.field}:</strong> DC ಯಲ್ಲಿ "{f.seen}" ಇದೆ. {f.reason_kn ?? ''}
                    {f.field === 'matched_product' && ' ಸರಿಯಾದ ಉತ್ಪನ್ನವನ್ನು Change ಒತ್ತಿ ಆಯ್ಕೆ ಮಾಡಿ.'}
                  </Kn>
                </span>
                {s !== null && <button onClick={() => useFlag(f)} style={secondaryBtn(false)}>Use {String(s)} · ಬಳಸಿ</button>}
                <button onClick={() => ignoreFlag(f)} style={secondaryBtn(false)}>Ignore · ಬಿಡಿ</button>
              </div>
            );
          })}
          {openMissing.map((m, i) => (
            <div key={`${missingKey(m)}|${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '6px 8px', background: '#fff7ed', borderRadius: 6 }}>
              <span style={{ flex: 1, minWidth: 220 }}>
                <strong>A row may be missing:</strong> "{m.product_name}" is on the DC but not in the table. {m.reason}
                <Kn><strong>ಒಂದು ಸಾಲು ಬಿಟ್ಟುಹೋಗಿರಬಹುದು:</strong> "{m.product_name}" DC ಯಲ್ಲಿ ಇದೆ, ಆದರೆ ಪಟ್ಟಿಯಲ್ಲಿ ಇಲ್ಲ. {m.reason_kn ?? ''}</Kn>
              </span>
              <button onClick={() => ignoreKey(missingKey(m))} style={secondaryBtn(false)}>Ignore · ಬಿಡಿ</button>
            </div>
          ))}
          {openArithmetic.map(([i, msg]) => (
            <div key={`a${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '6px 8px', background: '#fff7ed', borderRadius: 6 }}>
              <span style={{ flex: 1, minWidth: 220 }}>
                <strong>Row {i + 1}:</strong> {msg.en}
                <Kn><strong>ಸಾಲು {i + 1}:</strong> {msg.kn}</Kn>
              </span>
              <button onClick={() => ignoreKey(arithmeticKey(i))} style={secondaryBtn(false)}>Ignore · ಬಿಡಿ</button>
            </div>
          ))}
          {openTotalNotes.map(n => (
            <div key={n.key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '6px 8px', background: '#fff7ed', borderRadius: 6 }}>
              <span style={{ flex: 1, minWidth: 220 }}>{n.text}<Kn>{n.kn}</Kn></span>
              <button onClick={() => ignoreKey(n.key)} style={secondaryBtn(false)}>Ignore · ಬಿಡಿ</button>
            </div>
          ))}
        </div>
      )}

      {dcSubmit.panel}

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

      {/* Table (desktop) */}
      <div
        className={`desktop-table-wrap${viewMode === 'table' ? ' force-visible' : viewMode === 'cards' ? ' force-hidden' : ''}`}
        style={{
        background: 'var(--surface)', borderRadius: 'var(--radius)',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden',
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)' }}>
                <th style={th}>#</th>
                <th style={{ ...th, minWidth: 60 }}>Leave out</th>
                {hasMatching && (
                  <>
                    <th style={{ ...th, textAlign: 'left', minWidth: 240 }}>Matched CRM Product</th>
                    <th style={{ ...th, minWidth: 70 }}></th>
                  </>
                )}
                <th style={{ ...th, textAlign: 'left', minWidth: 200 }}>Product Name (Invoice)</th>
                {hasMatching && (
                  <th style={{ ...th, minWidth: 80 }}>Pack</th>
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
                        background: highlightedRows.has(idx) ? '#dcfce7' : isOpen ? 'var(--accent-light)' : idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                        transition: 'background 0.15s',
                        opacity: dcSubmit.isLeftOut(idx) ? 0.5 : 1,
                      }}
                    >
                      <td style={{ ...td, textAlign: 'center', color: 'var(--text-muted)', fontWeight: 500 }}>{idx + 1}</td>
                      <td style={{ ...td, textAlign: 'center' }}>{dcSubmit.leaveOutBox(idx)}</td>

                      {hasMatching && (
                        <>
                          {/* Matched CRM Product — click to highlight the row */}
                          <td style={{ ...td, cursor: 'pointer', ...(cellFlag(idx, 'matched_product') ? { background: '#ffedd5' } : {}) }} onClick={() => toggleHighlight(idx)} title={cellFlag(idx, 'matched_product') ?? 'Click to highlight this row'}>
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
                          </td>

                          {/* Change button — between Matched CRM Product and Product Name */}
                          <td style={{ ...td, textAlign: 'center' }}>
                            <button
                              onClick={() => isOpen ? setExpandedRow(null) : openPicker(idx)}
                              style={{
                                flexShrink: 0,
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
                          </td>
                        </>
                      )}

                      {/* Product Name (Invoice) */}
                      <td style={{ ...td, fontWeight: 500, color: 'var(--text-primary)' }}>
                        {renderEdit(idx, 'product_name', false, 180,
                          <span style={{ fontWeight: 500, color: fieldOverrides[idx]?.product_name ? 'var(--accent)' : 'var(--text-primary)' }}>
                            {resolvedField(idx, 'product_name')}
                          </span>,
                          'left',
                        )}
                      </td>

                      {hasMatching && (
                        <td style={{ ...td, textAlign: 'center' }}>
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {resolved?.pack ?? '—'}
                          </span>
                        </td>
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
                        {renderEdit(idx, 'batch_number', false, 130,
                          <span style={BATCH_STYLE}>{resolvedField(idx, 'batch_number')}</span>,
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
                        <td colSpan={hasMatching ? 15 : 11} style={{ padding: 0, borderBottom: '2px solid var(--accent)' }}>
                          <CandidatePicker
                            product={p}
                            current={pending[idx] ?? null}
                            branch={dcDetails.branch}
                            supplier={dcDetails.supplier}
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
                  <td colSpan={14} style={{ ...td, textAlign: 'right', fontWeight: 600, fontSize: '12px', color: 'var(--text-secondary)', borderBottom: 'none' }}>
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

      {/* Cards (mobile) — CRM match leads, metrics stacked so nothing needs horizontal scroll */}
      <div
        className={`mobile-product-list${viewMode === 'cards' ? ' force-visible' : viewMode === 'table' ? ' force-hidden' : ''}`}
        style={{ flexDirection: 'column', gap: 12 }}
      >
        {products.map((p, idx) => {
          const resolved = resolvedProduct(idx);
          const isOpen   = expandedRow === idx;
          const modified = overrides[idx] !== undefined;

          return (
            <Fragment key={idx}>
              <div
                style={{
                  background: highlightedRows.has(idx) ? '#dcfce7' : isOpen ? 'var(--accent-light)' : 'var(--surface)',
                  border: `1px solid ${isOpen ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)',
                  padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
                  opacity: dcSubmit.isLeftOut(idx) ? 0.5 : 1,
                }}
              >
                {/* Header: # + CRM match + Change */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', flexShrink: 0, marginTop: 2 }}>
                    #{idx + 1}
                  </span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0, marginTop: 2, cursor: 'pointer' }}>
                    {dcSubmit.leaveOutBox(idx)}
                    Leave out
                  </label>
                  <div
                    style={{ flex: 1, minWidth: 0, cursor: hasMatching ? 'pointer' : 'default' }}
                    onClick={() => hasMatching && toggleHighlight(idx)}
                    title={hasMatching ? 'Click to highlight this card' : undefined}
                  >
                    {hasMatching ? (
                      <>
                        {resolved?.product ? (
                          <span style={{ fontWeight: 600, fontSize: '14px', color: modified ? 'var(--accent)' : 'var(--text-primary)', ...(cellFlag(idx, 'matched_product') ? FLAG_STYLE : {}) }}>
                            {resolved.product}
                            {modified && <span style={{ fontSize: '10px', marginLeft: 4, color: 'var(--accent)' }}>edited</span>}
                          </span>
                        ) : p.not_stocked ? (
                          <span style={pill('var(--warning)', 'var(--warning-light)')}>Not stocked</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>No match</span>
                        )}
                        <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{resolved?.pack ?? '—'}</span>
                          {p.match_confidence != null && p.match_confidence >= 0 && <ConfBadge value={p.match_confidence} />}
                        </div>
                      </>
                    ) : (
                      <span style={{ fontWeight: 600, fontSize: '14px' }}>{resolvedField(idx, 'product_name')}</span>
                    )}
                  </div>
                  {hasMatching && (
                    <button
                      onClick={() => isOpen ? setExpandedRow(null) : openPicker(idx)}
                      style={{
                        flexShrink: 0, background: isOpen ? 'var(--accent)' : 'var(--surface)',
                        border: `1px solid ${isOpen ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: 6, padding: '6px 12px', fontSize: '12px', fontWeight: 600,
                        cursor: 'pointer', color: isOpen ? '#fff' : 'var(--text-secondary)',
                      }}
                    >
                      {isOpen ? 'Close' : 'Change'}
                    </button>
                  )}
                </div>

                {/* Invoice product name */}
                {hasMatching && (
                  <div style={{ paddingTop: 8, borderTop: '1px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Invoice name
                    </span>
                    {renderEdit(idx, 'product_name', false, 220,
                      <span style={{ fontSize: '12px', fontWeight: 400, color: fieldOverrides[idx]?.product_name ? 'var(--accent)' : 'var(--text-secondary)' }}>
                        {resolvedField(idx, 'product_name')}
                      </span>,
                      'left',
                    )}
                  </div>
                )}

                {/* Batch — full width, its own row */}
                <div style={{ paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
                  <MetricTile label="Batch">
                    {renderEdit(idx, 'batch_number', false, 220,
                      <span style={BATCH_STYLE}>{resolvedField(idx, 'batch_number')}</span>,
                      'left',
                    )}
                  </MetricTile>
                </div>

                {/* Remaining metrics — mrp, qty, expiry, rate, disc%, free, old mrp, value.
                    One scrollable row, same as the old table's horizontal scroll. */}
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
                  <MetricTile label="MRP" style={{ flexShrink: 0, minWidth: 70 }}>
                    {renderEdit(idx, 'mrp', true, 60,
                      <span>{resolvedField(idx, 'mrp') > 0 ? resolvedField(idx, 'mrp').toFixed(2) : '—'}</span>,
                      'right',
                    )}
                  </MetricTile>
                  <MetricTile label="Qty" style={{ flexShrink: 0, minWidth: 70 }}>
                    {renderEdit(idx, 'quantity', true, 60,
                      <span>{resolvedField(idx, 'quantity')}</span>,
                    )}
                  </MetricTile>
                  <MetricTile label="Expiry" style={{ flexShrink: 0, minWidth: 70 }}>
                    {renderEdit(idx, 'expiry', false, 60,
                      <span>{resolvedField(idx, 'expiry') || '—'}</span>,
                    )}
                  </MetricTile>
                  <MetricTile label="Rate" style={{ flexShrink: 0, minWidth: 70 }}>
                    {renderEdit(idx, 'rate', true, 60,
                      <span>{resolvedField(idx, 'rate') > 0 ? resolvedField(idx, 'rate').toFixed(2) : '—'}</span>,
                      'right',
                    )}
                  </MetricTile>
                  <MetricTile label="Disc%" style={{ flexShrink: 0, minWidth: 65 }}>
                    {renderEdit(idx, 'disc_percent', true, 60,
                      <span>{resolvedField(idx, 'disc_percent') > 0 ? `${resolvedField(idx, 'disc_percent')}%` : '—'}</span>,
                    )}
                  </MetricTile>
                  <MetricTile label="Free" style={{ flexShrink: 0, minWidth: 65 }}>
                    {renderEdit(idx, 'free', true, 60,
                      <span>{resolvedField(idx, 'free') > 0 ? resolvedField(idx, 'free') : '—'}</span>,
                    )}
                  </MetricTile>
                  <MetricTile label="Old MRP" style={{ flexShrink: 0, minWidth: 75 }}>
                    {renderEdit(idx, 'old_mrp', true, 60,
                      <span>{resolvedField(idx, 'old_mrp') > 0 ? resolvedField(idx, 'old_mrp').toFixed(2) : '—'}</span>,
                      'right',
                    )}
                  </MetricTile>
                  <MetricTile label="Value" style={{ flexShrink: 0, minWidth: 75 }}>
                    <span>{(resolvedField(idx, 'rate') * resolvedField(idx, 'quantity')).toFixed(2)}</span>
                  </MetricTile>
                </div>
              </div>

              {isOpen && (
                <CandidatePicker
                  product={p}
                  current={pending[idx] ?? null}
                  branch={dcDetails.branch}
                  supplier={dcDetails.supplier}
                  onChange={val => setPending(prev => ({ ...prev, [idx]: val }))}
                  onApply={() => applyPicker(idx)}
                  onCancel={() => setExpandedRow(null)}
                />
              )}
            </Fragment>
          );
        })}

        {hasMatching && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 16px', background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', fontWeight: 700,
          }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Total Value</span>
            <span style={{ color: 'var(--text-primary)' }}>{totalValue.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Candidate Picker ────────────────────────────────────── */

/** One product from the CRM's own search, named and packed exactly as Check and Save look it up. */
interface SearchResult { product: string; pack: string; bought_before: boolean; }

const SEARCH_FAILED = "Couldn't search the CRM's products. Try again.";

function CandidatePicker({
  product,
  current,
  branch,
  supplier,
  onChange,
  onApply,
  onCancel,
}: {
  product: Product;
  current: Override | null;
  branch: string;
  supplier: string;   // the DC's supplier: that supplier's products are listed first
  onChange: (v: Override | null) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError]   = useState('');
  const [cutShort, setCutShort]         = useState(false);

  // Searches the CRM itself, not the Excel catalogue: a product picked here is one
  // the CRM has. A newer keystroke cancels the older search, so a slow answer can't
  // replace a newer one.
  useEffect(() => {
    const text = searchQuery.trim();
    setSearchError('');
    if (text.length < 2) {
      setSearchResults([]);
      setCutShort(false);
      setSearchLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setSearchLoading(true); // from the first keystroke, so "no match" never flashes up before the search
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: text, branch, supplier });
        const res = await fetch(`/crm/dc/products/search?${params}`, { signal: ctrl.signal });
        const data = await res.json().catch(() => null);
        if (ctrl.signal.aborted) return;
        if (!res.ok || !data) {
          setSearchResults([]);
          setCutShort(false);
          setSearchError(typeof data?.detail === 'string' ? data.detail : SEARCH_FAILED);
          return;
        }
        setSearchResults(data.results ?? []);
        setCutShort(data.cut_short === true);
      } catch {
        if (ctrl.signal.aborted) return;
        setSearchResults([]);
        setCutShort(false);
        setSearchError("Couldn't reach the server. Try again.");
      } finally {
        if (!ctrl.signal.aborted) setSearchLoading(false);
      }
    }, 300);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [searchQuery, branch, supplier]);

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
    const selected = current?.product === productName && (current?.pack ?? '') === pack;  // packs of one name are separate products
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
        {/* Not flex: 1 — the picker can be as wide as the whole table, and the pack must stay in view */}
        <span style={{ fontWeight: 500, color: '#1e3a5f', flex: '0 1 auto', minWidth: 0, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
          placeholder="Search the CRM's products…"
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
        searchError ? (
          <p style={{ fontSize: '12px', color: '#dc2626', padding: '4px 10px', marginBottom: 6 }}>{searchError}</p>
        ) : searchResults.length > 0 ? (
          <>
            {searchResults.map((r, i) =>
              renderOption(
                `sr-${i}`, r.product, r.pack,
                r.bought_before && supplier ? (
                  <span style={{ background: '#dcfce7', color: '#166534', padding: '1px 7px', borderRadius: 6, fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>
                    Bought from this supplier
                  </span>
                ) : null,
              )
            )}
            {cutShort && (
              <p style={{ fontSize: '11px', color: '#64748b', padding: '2px 10px', marginBottom: 6 }}>
                The CRM shows at most 20 matches. Type more of the name to narrow it down.
              </p>
            )}
          </>
        ) : !searchLoading && (
          <p style={{ fontSize: '12px', color: '#64748b', padding: '4px 10px', marginBottom: 6 }}>
            No product in the CRM matches "{searchQuery.trim()}".
          </p>
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

function MetricTile({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 2,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '6px 8px', minWidth: 0,
      ...style,
    }}>
      <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <span style={{ fontSize: '13px', fontWeight: 500 }}>{children}</span>
    </div>
  );
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
  padding: '11px 10px', textAlign: 'center',
  fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '11px 10px', borderBottom: '1px solid var(--border)',
  color: 'var(--text-primary)', verticalAlign: 'middle',
};
