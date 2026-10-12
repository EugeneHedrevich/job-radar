import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

const sourceNames: Record<string, string> = {
  linkedin: 'LinkedIn', indeed: 'Indeed', glassdoor: 'Glassdoor', redglobal: 'RED Global',
  eursap: 'Eursap', whitehall: 'Whitehall', michaelpage: 'Michael Page',
  nextventures: 'Next Ventures', remotive: 'Remotive', arbeitnow: 'Arbeitnow',
  remoteok: 'Remote OK', jobicy: 'Jobicy',
};

export function sourceLabel(source: string): string {
  return sourceNames[source] ?? source.replace(/[_-]/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

/** Searchable multi-select, with native focus order and keyboard list navigation. */
export default function SourceFilter({ options, value, onChange }: {
  options: string[]; value: string[]; onChange: (sources: string[]) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const visible = options.filter((source) => `${source} ${sourceLabel(source)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const activeIndex = Math.min(active, Math.max(0, visible.length - 1));
  const caption = value.length === 0 ? 'All sources' : value.length === 1 ? sourceLabel(value[0]!) : `${value.length} sources`;

  useEffect(() => {
    if (!open) return;
    setQuery(''); setActive(0); search.current?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, id, activeIndex, query]);

  function close() { setOpen(false); trigger.current?.focus(); }
  function toggle(source: string) {
    onChange(value.includes(source) ? value.filter((item) => item !== source) : [...value, source].sort());
  }
  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (visible.length) setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (visible[activeIndex]) toggle(visible[activeIndex]);
    }
  }

  return <div className="source-filter" ref={root}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <button ref={trigger} type="button" className={`source-trigger ${value.length ? 'has-selection' : ''}`}
      aria-label={`Sources: ${caption}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-popup`}
      disabled={!options.length} onClick={() => setOpen(!open)}
      onKeyDown={(event) => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); } }}>
      <span>{caption}</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" /></svg>
    </button>
    {open && <div className="source-popover" id={`${id}-popup`} role="dialog" aria-label="Choose sources">
      <div className="source-search"><input ref={search} type="search" placeholder="Find a source…" aria-label="Find a source"
        role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`}
        aria-activedescendant={visible.length ? `${id}-option-${activeIndex}` : undefined}
        value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={navigate} /></div>
      <ul id={`${id}-list`} className="source-options" role="listbox" aria-label="Sources" aria-multiselectable="true">
        {visible.map((source, index) => <li key={source} id={`${id}-option-${index}`} role="option"
          aria-selected={value.includes(source)} className={index === activeIndex ? 'is-active' : ''}
          onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => toggle(source)}>
          <span className={`option-check ${value.includes(source) ? 'checked' : ''}`} aria-hidden="true">{value.includes(source) ? '✓' : ''}</span>
          {sourceLabel(source)}
        </li>)}
      </ul>
      {!visible.length && <p className="source-empty" role="status">No sources found.</p>}
      <div className="source-actions"><button type="button" className="text-button" disabled={!value.length} onClick={() => onChange([])}>All sources</button>
        <span className="muted small" aria-live="polite">{value.length ? `${value.length} selected` : 'All included'}</span>
        <button type="button" className="text-button" onClick={close}>Done</button></div>
      <span className="sr-only">Use arrow keys to navigate, Enter to select, and Escape to close.</span>
    </div>}
  </div>;
}
