import { useEffect, useMemo, useRef, useState } from 'react';
import { highlightParts, searchSuggestions } from '../lib/search';

/**
 * Description box with keyword search. Typing "ri" lists every ring; ↓/↑ to choose, Enter or click to pick.
 * With the list closed (or nothing chosen), Enter moves on to the next field as usual.
 */
export function DescriptionInput({
  value,
  onChange,
  onPick,
  suggestions,
  rowKey,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (v: string) => void;
  suggestions: string[];
  rowKey: number;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [hi, setHi] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const matches = useMemo(
    () => (value.trim() ? searchSuggestions(value, suggestions) : browse ? suggestions.slice(0, 40) : []),
    [value, suggestions, browse],
  );
  const show = open && matches.length > 0;

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const close = () => {
    setOpen(false);
    setBrowse(false);
    setHi(-1);
  };
  const pick = (s: string) => {
    onPick(s);
    close();
  };

  return (
    <div className="combo">
      <input
        data-nav
        data-desc={rowKey}
        className={invalid ? 'invalid' : ''}
        value={value}
        role="combobox"
        aria-expanded={show}
        aria-autocomplete="list"
        autoComplete="off"
        // stop the OS's own spelling/predictive popups from grabbing ↓/↑/Enter
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        {...{ writingsuggestions: 'false' }}
        placeholder="Type to search, e.g. ring, payal, chain"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHi(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            if (!value.trim()) setBrowse(true);
            setHi((h) => Math.min(h + 1, Math.max(matches.length, value.trim() ? 0 : 40) - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, -1));
          } else if (e.key === 'Escape' && show) {
            e.stopPropagation();
            close();
          } else if (e.key === 'Enter' && show && hi >= 0 && matches[hi]) {
            e.preventDefault();
            e.stopPropagation();
            pick(matches[hi]);
          } else if (e.key === 'Enter') {
            close();
          }
        }}
      />
      {show && (
        <ul className="combo-list" role="listbox" ref={listRef}>
          {matches.map((m, i) => (
            <li
              key={m}
              data-i={i}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'hi' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              onMouseEnter={() => setHi(i)}
            >
              {highlightParts(m, value).map(([t, mark], j) => (mark ? <b key={j}>{t}</b> : <span key={j}>{t}</span>))}
            </li>
          ))}
          <li className="combo-hint" aria-hidden>
            ↓ ↑ to choose · Enter to pick
          </li>
        </ul>
      )}
    </div>
  );
}
