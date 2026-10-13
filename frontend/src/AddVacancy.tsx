import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ImportResult } from '../../src/dashboard/types';
import { request } from './api';

export default function AddVacancy({ onClose, onAdded }: { onClose: () => void; onAdded: (result: ImportResult) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [details, setDetails] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const imported = await request<ImportResult>('/api/import', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url,
          ...(details ? { title, description, detailsToken: result?.detailsToken } : {}) }) });
      setResult(imported);
      if (imported.result === 'Needs details') setDetails(true);
      else onAdded(imported);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to add vacancy'); }
    finally { setSaving(false); }
  }
  return <dialog ref={dialog} className="import-dialog" aria-labelledby="import-title"
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="panel-toolbar"><h2 id="import-title">Add vacancy</h2><button onClick={onClose} disabled={saving} aria-label="Close import">✕</button></div>
    <form onSubmit={save}>
      <fieldset disabled={saving}><legend className="sr-only">Vacancy import</legend>
        <label>Vacancy URL<input autoFocus type="url" required maxLength={1000} value={url}
          placeholder="https://…" onChange={(event) => { setUrl(event.target.value); setResult(null); }} /></label>
        <p className="muted small">Public sources provide details when available. You can enter them if the lookup is blocked or unsupported.</p>
        {result && <p role="status"><strong>Availability: {result.availability}</strong><br /><span className="small">{result.message}</span></p>}
        {!details && <button type="button" className="text-button" onClick={() => setDetails(true)}>Enter details myself</button>}
        {details && <><label>Vacancy title<input required maxLength={500} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Description<textarea required rows={8} maxLength={60_000} value={description} onChange={(event) => setDescription(event.target.value)} /></label></>}
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="save-row"><button className="primary" disabled={saving}>{saving ? 'Checking vacancy…' : details ? 'Add vacancy' : 'Check and add'}</button>
        <button type="button" onClick={onClose} disabled={saving}>Cancel</button></div>
    </form>
  </dialog>;
}
