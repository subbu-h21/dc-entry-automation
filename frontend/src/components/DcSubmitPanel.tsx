import { useRef, useState, CSSProperties, ReactNode } from 'react';
import { MiniSpinner } from './icons';

// The whole "send this DC to the CRM" interaction lives here on purpose, so it
// can be reworked without touching the review table: Check, fix or confirm,
// Save. The rules below come from the CRM's API guide and the fact that a save
// raises stock immediately and can't be undone from this app:
//   - what gets saved is always exactly what was last checked (see `stale`)
//   - questions are only ever confirmed by a person ticking them
//   - after an unclear save result, the only way forward is retrying that exact
//     request with the same key (see `pendingSave`), so a second DC can't happen

export interface DcRowInput {
  row: number;
  product_name: string;
  matched_product: string | null;
  matched_pack: string | null;
  batch_number: string;
  expiry: string;
  mrp: number;
  rate: number;
  quantity: number;
  free: number;
  disc_percent: number;
}

export interface DcDetails {
  dc_number: string;
  dc_date: string;
  supplier: string;
  checked_by: string;
  branch: string;
  scan_id: string;
}

interface Issue {
  code: string;
  row: number | null;
  product: string;
  message: string;
}

interface Report {
  errors: Issue[];
  questions: Issue[];
  net_amount: number | null;
  sent_rows: number;
  save_key: string;
}

type Status = 'idle' | 'checking' | 'saving' | 'saved';
type Warning = { kind: 'save' } | { kind: 'row'; row: number };

// The AI sometimes misreads the year, and the CRM accepts old dates without
// asking, so a wrong date would otherwise be saved without anyone noticing.
const MAX_DC_AGE_DAYS = 7;

function dcDateTooOld(date: string): boolean {
  if (!date) return false;
  const [year, month, day] = date.split('-').map(Number);
  const limit = new Date();
  limit.setHours(0, 0, 0, 0);
  limit.setDate(limit.getDate() - MAX_DC_AGE_DAYS);
  return new Date(year, month - 1, day) < limit;
}

const LEFT_OUT_BY_HAND = 'Left out by hand.';
const UNSURE_MESSAGE = "Not sure if this saved. Click Save again, it can't create a duplicate.";

function detailOf(data: unknown, fallback: string): string {
  const detail = (data as { detail?: unknown } | null)?.detail;
  return typeof detail === 'string' ? detail : fallback;
}

export function useDcSubmit(rows: DcRowInput[], dc: DcDetails): {
  button: ReactNode;
  panel: ReactNode;
  leaveOutBox: (row: number) => ReactNode;
  isLeftOut: (row: number) => boolean;
} {
  const [status, setStatus] = useState<Status>('idle');
  const [report, setReport] = useState<Report | null>(null);
  const [checkedPrint, setCheckedPrint] = useState('');
  const [ticks, setTicks] = useState<Set<string>>(() => new Set());
  const [leftOut, setLeftOut] = useState<Map<number, string>>(() => new Map());
  const [message, setMessage] = useState('');
  const [refNo, setRefNo] = useState('');
  const [stage3Reported, setStage3Reported] = useState(true);
  const [unsure, setUnsure] = useState(false);
  const [warning, setWarning] = useState<Warning | null>(null);
  const busy = useRef(false); // state updates too late to stop a fast double-click
  const pendingSave = useRef<object | null>(null); // the save in flight or awaiting a clear answer

  // A tick answers one question about one exact row, so changing the row (a
  // different product, say) un-ticks it even if the question reads the same.
  const tickKey = (q: Issue) =>
    `${q.code}|${q.message}|${JSON.stringify(q.row === null ? dc : rows.find(r => r.row === q.row))}`;

  const sendable = rows.filter(r => r.matched_product && !leftOut.has(r.row));
  const fingerprint = JSON.stringify([dc, sendable]);

  const body = (withConfirm: boolean) => {
    const confirmed = (row: number | null) =>
      withConfirm ? (report?.questions ?? []).filter(q => q.row === row && ticks.has(tickKey(q))).map(q => q.code) : [];
    return {
      ...dc,
      confirm: confirmed(null),
      rows: sendable.map(r => ({ ...r, confirm: confirmed(r.row) })),
    };
  };

  const post = (path: string, payload: object) =>
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

  const runCheck = async () => {
    if (busy.current) return;
    busy.current = true;
    setStatus('checking');
    setMessage('');
    try {
      const res = await post('/crm/dc/check', body(false));
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setReport(null);
        setMessage(detailOf(data, `Error ${res.status}`));
        return;
      }
      setReport(data);
      setCheckedPrint(fingerprint);
    } catch {
      setReport(null);
      setMessage("Couldn't reach the server. Try again.");
    } finally {
      busy.current = false;
      setStatus('idle');
    }
  };

  const stale = report !== null && checkedPrint !== fingerprint;
  const allTicked = (report?.questions ?? []).every(q => ticks.has(tickKey(q)));
  const tooOld = dcDateTooOld(dc.dc_date);
  const canSave = status === 'idle' && (unsure || (report !== null && !tooOld && !stale && report.errors.length === 0 && report.sent_rows > 0 && allTicked));

  const save = async () => {
    if (!canSave || busy.current) return;
    const payload = pendingSave.current ?? { ...body(true), save_key: report?.save_key };
    pendingSave.current = payload;
    busy.current = true;
    setStatus('saving');
    setMessage('');
    let next: Status = 'idle';
    const settled = () => {
      pendingSave.current = null;
      setUnsure(false);
    };
    try {
      const res = await post('/crm/dc/save', payload);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.saved) {
        settled();
        setRefNo(data.ref_no);
        setStage3Reported(data.stage3_reported);
        next = 'saved';
      } else if (res.ok && data?.report) {
        settled();
        setReport(data.report);
      } else if (res.status === 400 || res.status === 409 || res.status === 422) {
        settled(); // definitely not saved: a new check is required
        setReport(null);
        setMessage(detailOf(data, `Error ${res.status}`));
      } else {
        setUnsure(true);
        setMessage(detailOf(data, UNSURE_MESSAGE));
      }
    } catch {
      setUnsure(true);
      setMessage(UNSURE_MESSAGE);
    } finally {
      busy.current = false;
      setStatus(next);
    }
  };

  // Ticking Leave out only marks the row, so several can be ticked before one
  // re-check. A change here makes the report stale, which keeps Save off until
  // that re-check happens.
  const toggleLeaveOut = (row: number, reason: string) => {
    setLeftOut(prev => {
      const next = new Map(prev);
      if (!next.delete(row)) next.set(row, reason);
      return next;
    });
  };

  // Leaving out a row with no error is unusual, so it needs a second click. Rows
  // the CRM refused are what Leave out is for, so those tick straight away.
  const tickRow = (row: number) => {
    const reason = (report?.errors ?? []).find(e => e.row === row)?.message;
    if (leftOut.has(row) || reason) toggleLeaveOut(row, reason ?? LEFT_OUT_BY_HAND);
    else setWarning({ kind: 'row', row });
  };

  // Saving with rows missing is for emergencies only, so it always asks first.
  // The exception is retrying an unclear save: that was already confirmed, and
  // the retry has to stay the exact same request.
  const saveClicked = () => {
    if (missing > 0 && !pendingSave.current) setWarning({ kind: 'save' });
    else save();
  };

  const toggleTick = (q: Issue) => {
    setTicks(prev => {
      const next = new Set(prev);
      const key = tickKey(q);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const rowName = (row: number | null) => {
    if (row === null) return 'DC';
    const r = rows.find(x => x.row === row);
    return `Row ${row + 1}  ${r?.matched_product ?? r?.product_name ?? ''}`;
  };

  const saved = status === 'saved';
  const working = status === 'checking' || status === 'saving';
  const locked = working || unsure; // while a save's outcome is unknown, only retrying it is allowed
  const notSent = rows.filter(r => !r.matched_product);
  const missing = rows.length - sendable.length; // a row can be both left out and without a product
  const stillOpen = (issue: Issue) => issue.row === null || !leftOut.has(issue.row);
  const openErrors = (report?.errors ?? []).filter(stillOpen);
  const openQuestions = (report?.questions ?? []).filter(stillOpen);
  // A ticked row stays in the red list, so rows don't jump around while ticking.
  // It moves to Not sent once a re-check no longer reports it.
  const leftOutShown = [...leftOut]
    .filter(([row]) => !notSent.some(r => r.row === row))
    .filter(([row]) => saved || !(report?.errors ?? []).some(e => e.row === row))
    .sort((a, b) => a[0] - b[0]);

  const badRows = openErrors.filter(e => e.row !== null);
  const dcProblems = openErrors.filter(e => e.row === null);
  const toTick = openQuestions.filter(q => !ticks.has(tickKey(q)));
  const rowNumbers = (issues: Issue[]) =>
    [...new Set(issues.flatMap(i => (i.row === null ? [] : [i.row + 1])))].sort((a, b) => a - b).join(', ');

  const leaveOutAll = () => {
    setLeftOut(prev => {
      const next = new Map(prev);
      for (const { row, message: reason } of badRows) {
        if (row !== null && !next.has(row)) next.set(row, reason);
      }
      return next;
    });
  };

  const button = (
    <button
      onClick={() => runCheck()}
      disabled={locked || saved}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '7px 14px', borderRadius: 'var(--radius-sm)', border: 'none',
        background: saved ? 'var(--success)' : 'linear-gradient(135deg,#2563eb,#1d4ed8)',
        color: '#fff', fontSize: '13px', fontWeight: 600,
        cursor: locked || saved ? 'not-allowed' : 'pointer',
        opacity: working ? 0.7 : 1,
        boxShadow: '0 2px 8px rgba(37,99,235,0.3)', transition: 'all 0.2s',
      }}
    >
      {status === 'checking' && <MiniSpinner />}
      {status === 'checking' ? 'Checking…' : saved ? 'Saved to CRM' : report ? 'Check again' : 'Check DC'}
    </button>
  );

  const leaveOutBox = (row: number) => {
    const noProduct = !rows.find(r => r.row === row)?.matched_product; // never sent anyway
    return (
      <input
        type="checkbox"
        aria-label={`Leave out row ${row + 1}`}
        checked={noProduct || leftOut.has(row)}
        disabled={noProduct || locked || saved}
        onChange={() => tickRow(row)}
      />
    );
  };
  const isLeftOut = (row: number) => leftOut.has(row);

  const dialog = warning && (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="alertdialog" style={{ background: 'var(--surface)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-md)', padding: '20px 22px', width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 10, fontSize: '14px', color: 'var(--text-primary)' }}>
        {warning.kind === 'row' ? (
          <>
            <strong style={{ color: 'var(--warning)', fontSize: '15px' }}>Row {warning.row + 1} has no error</strong>
            <span>The CRM hasn't reported an error on {rowName(warning.row).replace(/^Row \d+\s+/, '')}. Are you sure you want to leave it out?</span>
          </>
        ) : (
          <>
            <strong style={{ color: 'var(--warning)', fontSize: '15px' }}>{missing} row{missing === 1 ? '' : 's'} won't be on this DC</strong>
            <span>Saving a DC with rows left out is not normal practice. Only do this in an emergency, when you need the stock and batch entry so you can bill a product now.</span>
            <span>Add the missing rows on the CRM screen afterwards.</span>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button onClick={() => setWarning(null)} style={{ ...smallBtn, padding: '8px 16px', fontSize: '13px' }}>Cancel</button>
          <button
            onClick={() => {
              setWarning(null);
              if (warning.kind === 'row') toggleLeaveOut(warning.row, LEFT_OUT_BY_HAND);
              else save();
            }}
            style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 600, border: 'none', borderRadius: 6, background: 'var(--warning)', color: '#fff', cursor: 'pointer' }}
          >
            {warning.kind === 'row' ? 'Leave it out' : 'Save anyway'}
          </button>
        </div>
      </div>
    </div>
  );

  if (!report && !message && !saved && leftOut.size === 0) return { button, panel: dialog, leaveOutBox, isLeftOut };

  const panel = (
    <>
    {dialog}
    <div style={{
      background: 'var(--surface)', borderRadius: 'var(--radius)', border: '1px solid var(--border)',
      padding: '12px 16px', boxShadow: 'var(--shadow-sm)', fontSize: '13px',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {saved && (
        <div style={{ ...banner, background: 'var(--success-light)', color: 'var(--success)', fontWeight: 600 }}>
          Saved to CRM. Reference {refNo}
          {!stage3Reported && (
            <div style={{ fontWeight: 400, marginTop: 4, color: 'var(--text-secondary)' }}>
              The save is fine, but it wasn't credited on the Stage 3 leaderboard.
            </div>
          )}
        </div>
      )}

      {message && <div style={{ ...banner, background: 'var(--error-light)', color: 'var(--error)' }}>{message}</div>}

      {report && !saved && (
        <p style={{ margin: 0, fontWeight: 600, color: 'var(--text-primary)' }}>
          Check result: {report.sent_rows} row{report.sent_rows === 1 ? '' : 's'}
          {report.net_amount != null && `, Rs ${report.net_amount.toLocaleString('en-IN')}`}
        </p>
      )}

      {stale && !saved && !unsure && (
        <div style={{ ...banner, background: 'var(--warning-light)', color: 'var(--warning)' }}>
          Something changed since this check. Check again before saving.
        </div>
      )}

      {report && !saved && report.errors.length > 0 && (
        <Group title="Not allowed: fix the value in the table, or leave the row out" color="var(--error)">
          {report.errors.map((issue, i) => (
            <IssueRow key={i} name={rowName(issue.row)} text={issue.message}>
              {issue.row !== null && (
                <LeaveOutBox checked={leftOut.has(issue.row)} disabled={locked} onChange={() => toggleLeaveOut(issue.row as number, issue.message)} />
              )}
            </IssueRow>
          ))}
        </Group>
      )}

      {report && !saved && openQuestions.length > 0 && (
        <Group title="Please confirm" color="var(--warning)">
          {openQuestions.map((q, i) => (
            <IssueRow key={i} name={rowName(q.row)} text={q.message}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                <input type="checkbox" checked={ticks.has(tickKey(q))} onChange={() => toggleTick(q)} disabled={locked} />
                Yes
              </label>
            </IssueRow>
          ))}
        </Group>
      )}

      {(notSent.length > 0 || leftOutShown.length > 0) && (
        <Group title={saved ? 'Not on this DC: add these on the CRM screen' : 'Not sent'} color="var(--text-secondary)">
          {notSent.map(r => (
            <IssueRow key={`n${r.row}`} name={`Row ${r.row + 1}  ${r.product_name}`} text="No CRM product selected" />
          ))}
          {leftOutShown.map(([row, reason]) => (
            <IssueRow key={`l${row}`} name={rowName(row)} text={reason}>
              {!saved && <LeaveOutBox checked disabled={locked} onChange={() => toggleLeaveOut(row, reason)} />}
            </IssueRow>
          ))}
        </Group>
      )}

      {report && !saved && (
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, color: 'var(--text-primary)' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--accent)' }}>Notes</span>
          {tooOld && !unsure && (
            <strong style={{ color: 'var(--error)' }}>
              DC Date {dc.dc_date.split('-').reverse().join('/')} is more than {MAX_DC_AGE_DAYS} days old, so it can't be saved. Correct the DC Date at the top.
            </strong>
          )}
          {unsure ? (
            <span>Click Save to CRM again.</span>
          ) : stale ? (
            <span>Click Check again.</span>
          ) : openErrors.length === 0 && toTick.length === 0 ? (
            tooOld ? null : report.sent_rows > 0
              ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>Ready. Click Save to CRM.</span>
              : <span>No rows left to send.</span>
          ) : (
            <>
              {badRows.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <strong>Leave out rows: {rowNumbers(badRows)}</strong>
                  <button onClick={leaveOutAll} disabled={locked} style={smallBtn}>Leave out these rows</button>
                </div>
              )}
              {toTick.length > 0 && (
                <strong>{rowNumbers(toTick) ? `Tick Yes on rows: ${rowNumbers(toTick)}` : 'Tick Yes on the DC question'}</strong>
              )}
              {dcProblems.map(e => (
                <strong key={e.code}>{e.code === 'DC_NUMBER_EXISTS' ? `${e.message} Change the DC Number at the top.` : e.message}</strong>
              ))}
            </>
          )}
        </div>
      )}

      {report && !saved && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {stale && !unsure && (
            <button onClick={() => runCheck()} disabled={locked} style={{ ...smallBtn, padding: '8px 18px', fontSize: '13px', color: 'var(--accent)' }}>
              Check again
            </button>
          )}
          <button
            onClick={saveClicked}
            disabled={!canSave}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '8px 18px', borderRadius: 'var(--radius-sm)', border: 'none',
              background: canSave ? 'var(--success)' : 'var(--border)',
              color: canSave ? '#fff' : 'var(--text-muted)',
              fontSize: '13px', fontWeight: 600,
              cursor: canSave ? 'pointer' : 'not-allowed',
            }}
          >
            {status === 'saving' && <MiniSpinner />}
            {status === 'saving' ? 'Saving…' : 'Save to CRM'}
          </button>
        </div>
      )}
    </div>
    </>
  );

  return { button, panel, leaveOutBox, isLeftOut };
}

function LeaveOutBox({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: () => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      Leave out
    </label>
  );
}

function Group({ title, color, children }: { title: string; color: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color }}>
        {title}
      </span>
      {children}
    </div>
  );
}

function IssueRow({ name, text, children }: { name: string; text: string; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 8px', background: 'var(--surface-2)', borderRadius: 6, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>{name}</span>
      <span style={{ flex: 1, minWidth: 180, color: 'var(--text-secondary)' }}>{text}</span>
      {children}
    </div>
  );
}

const banner: CSSProperties = { padding: '8px 12px', borderRadius: 'var(--radius-sm)' };

const smallBtn: CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6,
  padding: '3px 10px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
  color: 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap',
};
