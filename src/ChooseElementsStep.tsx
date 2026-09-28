/**
 * Step 2 - Choose Elements.
 *
 * Decides what gets counted. Groups are fetched ONCE (level is part of each
 * group key), so every chip click, level toggle and row removal is computed in
 * the browser with no further requests - the interaction that happens most stays
 * instant. The selection itself is saved in the background as it changes, so a
 * refresh or a closed tab costs nothing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getGroups,
  getPreview,
  saveSelection,
  type ElementGroup,
  type GroupsResponse,
  type PreviewResponse,
  type Selection,
} from './api'
import { SaveFailed, SavePill, useAutoSave } from './useAutoSave'

interface Props {
  runId: string
  onBack: () => void
  onContinue: () => void
}

/** Rows sharing a category and name, merged across levels for display. */
interface DisplayRow {
  id: string
  cat: string
  name: string
  material: string
  is_steel: boolean
  vol: number
  count: number
  levels: string[]
  keys: string[]
  removed: number
  total: number
}

const EMPTY: Selection = {
  excluded_categories: [],
  excluded_levels: [],
  excluded_groups: [],
}

export default function ChooseElementsStep({ runId, onBack, onContinue }: Props) {
  const [data, setData] = useState<GroupsResponse | null>(null)
  const [sel, setSel] = useState<Selection>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getGroups(runId)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setSel(d.selection ?? EMPTY)
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [runId])

  // Debounced save. Rapid clicking should not mean a request per click, but the
  // user should never have to think about saving either - and leaving the step
  // sends a pending save rather than dropping it (see useAutoSave).
  const { saveState, leaving, leaveWith, retry } = useAutoSave(
    sel, (v, o) => saveSelection(runId, v, o), data !== null)

  const excCats = useMemo(() => new Set(sel.excluded_categories), [sel])
  const excLevels = useMemo(() => new Set(sel.excluded_levels), [sel])
  const excGroups = useMemo(() => new Set(sel.excluded_groups), [sel])

  /** A group counts only if its category, its level and itself are all kept. */
  const isKept = useCallback(
    (g: ElementGroup) =>
      !excCats.has(g.cat) && !excLevels.has(g.level) && !excGroups.has(g.key),
    [excCats, excLevels, excGroups],
  )

  // Merge groups back to one row per category+name (steel kept separate, since
  // an explicit rebar/steel row is a different quantity from the concrete of the
  // same name). Levels stay visible in their own column.
  const rows: DisplayRow[] = useMemo(() => {
    if (!data) return []
    const map = new Map<string, DisplayRow>()
    for (const g of data.groups) {
      if (excCats.has(g.cat)) continue
      if (excLevels.has(g.level)) continue
      const id = g.is_steel ? `${g.cat}|${g.name}|${g.material}` : `${g.cat}|${g.name}`
      let r = map.get(id)
      if (!r) {
        r = { id, cat: g.cat, name: g.name, material: g.material,
              is_steel: g.is_steel, vol: 0, count: 0, levels: [],
              keys: [], removed: 0, total: 0 }
        map.set(id, r)
      }
      r.keys.push(g.key)
      r.total += 1
      if (excGroups.has(g.key)) { r.removed += 1 } else {
        r.vol += g.vol
        r.count += g.count
      }
      if (g.level && !r.levels.includes(g.level)) r.levels.push(g.level)
    }
    return [...map.values()].sort(
      (a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name))
  }, [data, excCats, excLevels, excGroups])

  // Volume per category, over what is actually counted.
  const volByCat = useMemo(() => {
    if (!data) return []
    const m = new Map<string, number>()
    for (const g of data.groups) {
      if (!isKept(g)) continue
      m.set(g.cat, (m.get(g.cat) ?? 0) + g.vol)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [data, isKept])

  const stats = useMemo(() => {
    const kept = rows.filter((r) => r.removed < r.total)
    return {
      included: kept.length,
      removed: rows.length - kept.length,
      volume: kept.reduce((s, r) => s + r.vol, 0),
      cats: new Set(kept.map((r) => r.cat)).size,
    }
  }, [rows])

  function patch(next: Partial<Selection>) {
    setSel((s) => ({ ...s, ...next }))
  }

  const toggleCat = (cat: string) =>
    patch({ excluded_categories: excCats.has(cat)
      ? sel.excluded_categories.filter((c) => c !== cat)
      : [...sel.excluded_categories, cat] })

  const toggleLevel = (lv: string) =>
    patch({ excluded_levels: excLevels.has(lv)
      ? sel.excluded_levels.filter((l) => l !== lv)
      : [...sel.excluded_levels, lv] })

  function removeChecked() {
    const add = rows.filter((r) => checked.has(r.id)).flatMap((r) => r.keys)
    patch({ excluded_groups: [...new Set([...sel.excluded_groups, ...add])] })
    setChecked(new Set())
  }

  const restoreAll = () => { patch({ excluded_groups: [] }); setChecked(new Set()) }

  function openPreview() {
    setPreviewOpen(true)
    if (!preview) {
      getPreview(runId)
        .then(setPreview)
        .catch((e) => setPreview({ kind: 'table', message: String(e) }))
    }
  }

  if (loading) {
    return (
      <div className="step">
        <div className="alert alert-busy" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading elements…
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="step">
        <div className="alert alert-bad" role="alert">{error ?? 'No data.'}</div>
        <button className="ghost" onClick={onBack}>← Back to upload</button>
      </div>
    )
  }

  const maxVol = Math.max(...volByCat.map(([, v]) => v), 0.001)
  const nothingLeft = stats.included === 0

  return (
    <div className="step">
      <header className="step-head">
        <h1>Choose Elements</h1>
        <p>
          Everything below is counted. Switch off a category or a level, or tick
          rows and remove them. Your choices save automatically.
        </p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>What&rsquo;s included</h2>
          <SavePill state={saveState} onRetry={retry} />
        </div>
        <div className="stats">
          <Stat label="Included rows" value={stats.included.toLocaleString()} />
          <Stat label="Removed" value={stats.removed.toLocaleString()}
                tone={stats.removed > 0 ? 'warn' : undefined} />
          <Stat label="Volume" value={`${stats.volume.toFixed(1)} m³`} />
          <Stat label="Categories" value={String(stats.cats)} />
        </div>
      </section>

      <section className="panel">
        <h2>Categories</h2>
        <p className="hint">Click to include or exclude a whole category.</p>
        <div className="chips">
          {data.categories.map((c) => (
            <button
              key={c.cat}
              type="button"
              className={`chip chip-btn${excCats.has(c.cat) ? ' chip-off' : ''}`}
              aria-pressed={!excCats.has(c.cat)}
              onClick={() => toggleCat(c.cat)}
            >
              {c.cat} <span className="chip-n">{c.count}</span>
            </button>
          ))}
        </div>

        {data.levels.length > 1 && (
          <>
            <h2 className="sub-h">Levels</h2>
            <p className="hint">
              Exclude a storey — basement car parks and plant levels are often
              assessed separately.
            </p>
            <div className="chips">
              {data.levels.map((l) => (
                <button
                  key={l.level || '(none)'}
                  type="button"
                  className={`chip chip-btn${excLevels.has(l.level) ? ' chip-off' : ''}`}
                  aria-pressed={!excLevels.has(l.level)}
                  onClick={() => toggleLevel(l.level)}
                >
                  {l.level || '(unassigned)'} <span className="chip-n">{l.count}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <h2 className="sub-h">Volume by category</h2>
        <div className="bars">
          {volByCat.map(([cat, vol]) => (
            <div className="bar-row" key={cat}>
              <span className="bar-lbl" title={cat}>{cat}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${(vol / maxVol) * 100}%` }} />
              </span>
              <span className="bar-val">{vol.toFixed(1)} m³</span>
            </div>
          ))}
          {volByCat.length === 0 && (
            <p className="hint">Nothing included — switch a category back on.</p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Elements</h2>
          <div className="btn-row">
            <button type="button" className="mini danger"
                    disabled={checked.size === 0} onClick={removeChecked}>
              Remove selected{checked.size > 0 ? ` (${checked.size})` : ''}
            </button>
            <button type="button" className="mini"
                    disabled={sel.excluded_groups.length === 0} onClick={restoreAll}>
              Restore all
            </button>
            {data.groups.length > 0 && (
              <button type="button" className="mini" onClick={openPreview}>
                Review input file
              </button>
            )}
          </div>
        </div>

        {nothingLeft && (
          <div className="alert alert-warn" role="alert">
            <strong>Nothing is included.</strong>
            <p>The calculation needs at least one element — switch a category
               or level back on, or restore removed rows.</p>
          </div>
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="tick">
                  <input
                    type="checkbox"
                    aria-label="Select all rows"
                    checked={checked.size > 0 && checked.size === rows.filter(r => r.removed < r.total).length}
                    onChange={(e) => setChecked(e.target.checked
                      ? new Set(rows.filter(r => r.removed < r.total).map(r => r.id))
                      : new Set())}
                  />
                </th>
                <th>Category</th>
                <th>Element</th>
                <th className="num">Volume (m³)</th>
                <th className="num">Count</th>
                <th>Status</th>
                <th>Level</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const state = r.removed === 0 ? 'in'
                  : r.removed === r.total ? 'out' : 'part'
                return (
                  <tr key={r.id} className={state === 'out' ? 'row-out' : ''}>
                    <td className="tick">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.name}`}
                        disabled={state === 'out'}
                        checked={checked.has(r.id)}
                        onChange={(e) => setChecked((c) => {
                          const n = new Set(c)
                          e.target.checked ? n.add(r.id) : n.delete(r.id)
                          return n
                        })}
                      />
                    </td>
                    <td>{r.cat}</td>
                    <td title={r.name}>
                      {r.name || <em>unnamed</em>}
                      {r.is_steel && <span className="tag tag-steel">{r.material}</span>}
                    </td>
                    <td className="num">{r.vol > 0 ? r.vol.toFixed(3) : '—'}</td>
                    <td className="num">{r.count}</td>
                    <td>
                      <span className={`pill pill-${state}`}>
                        {state === 'in' ? 'Included'
                          : state === 'out' ? 'Removed' : 'Partial'}
                      </span>
                    </td>
                    <td className="lvl">{r.levels.join(', ') || '—'}</td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="empty">
                  No rows match the current filters.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {previewOpen && (
        <div className="modal-bg" role="dialog" aria-modal="true"
             aria-label="Input file preview"
             onClick={(e) => e.target === e.currentTarget && setPreviewOpen(false)}>
          <div className="modal">
            <div className="modal-head">
              <strong>Your input file, as we read it</strong>
              <button type="button" className="mini" onClick={() => setPreviewOpen(false)}>
                Close
              </button>
            </div>
            <div className="modal-body">
              {!preview && <p className="hint">Loading…</p>}
              {preview?.kind === 'ifc' && <p>{preview.message}</p>}
              {preview?.kind === 'table' && preview.columns && (
                <div className="table-wrap">
                  <table>
                    <thead><tr>{preview.columns.map((c, i) =>
                      <th key={i}>{c}</th>)}</tr></thead>
                    <tbody>
                      {(preview.rows ?? []).map((row, i) => (
                        <tr key={i}>{row.map((v, j) =>
                          <td key={j}>{v.slice(0, 60)}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.truncated && (
                    <p className="hint">Showing the first 50 rows.</p>
                  )}
                </div>
              )}
              {preview?.kind === 'table' && !preview.columns && (
                <p className="hint">{preview.message}</p>
              )}
            </div>
          </div>
        </div>
      )}

      <SaveFailed state={saveState} onRetry={retry} />

      <footer className="step-foot">
        <button type="button" className="ghost" disabled={leaving}
                onClick={leaveWith(onBack)}>← Back</button>
        <button type="button" className="primary" disabled={nothingLeft || leaving}
                onClick={leaveWith(onContinue)}>
          {leaving ? 'Saving…' : 'Continue to Materials →'}
        </button>
      </footer>
    </div>
  )
}

function Stat({ label, value, tone }: {
  label: string; value: string; tone?: 'warn'
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className={`stat-value${tone === 'warn' ? ' stat-warn' : ''}`}>
        {value}
      </strong>
    </div>
  )
}
