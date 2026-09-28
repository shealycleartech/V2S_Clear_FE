/**
 * Step 4 - Transport & Waste.
 *
 * Three sets of numbers, all with SEAI defaults:
 *   A4   delivery distance per material family (sea + road km)
 *   A5w  site waste allowance per material (percent)
 *   A5a  site activity, kgCO2e per m2 of floor area
 *
 * Two behaviours carried over deliberately:
 *
 *   Waste is entered as a PERCENT and sent as a percent. The multiplier (1.05)
 *   and fraction (0.05) forms the engine needs are derived server-side, so the
 *   conversion exists once instead of in every caller.
 *
 *   A blank A5a means "use the SEAI default". A value that is present but out of
 *   range is REJECTED, never quietly replaced - the A5a term is factor x floor
 *   area, so substituting a number the user never chose would move the result
 *   with nothing on screen to explain it.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  getCatalogue,
  getTransport,
  saveTransport,
  type CatalogueResponse,
  type TransportState,
} from './api'
import { SaveFailed, SavePill, useAutoSave } from './useAutoSave'

interface Props {
  runId: string
  /** Floor area from Step 1, for the live A5a preview. */
  area?: number | null
  onBack: () => void
  onContinue: () => void
}

const WASTE_NOTES: Record<string, string> = {
  Concrete: 'Off-cuts, over-ordering, washout',
  Rebar: 'Cutting and bending losses',
  'Steel Section': 'Fabricated off site — very little waste',
  'Post Tensioning': 'Strand cut to length',
}

export default function TransportStep({ runId, area, onBack, onContinue }: Props) {
  const [cat, setCat] = useState<CatalogueResponse | null>(null)
  const [state, setState] = useState<TransportState>({
    distances: {}, waste_pct: {}, a5a_factor: null,
  })
  const [a5aText, setA5aText] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const dirty = useRef(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([getCatalogue(), getTransport(runId)])
      .then(([c, t]) => {
        if (cancelled) return
        setCat(c)
        // Seed anything unset from the SEAI defaults, so the form always shows
        // the numbers the calculation will actually use.
        const distances = { ...t.transport.distances }
        c.transport_defaults.forEach((d) => {
          if (!distances[d.key]) distances[d.key] = { sea: d.sea, road: d.road }
        })
        const waste = { ...c.waste_defaults, ...t.transport.waste_pct }
        setState({ distances, waste_pct: waste, a5a_factor: t.transport.a5a_factor })
        setA5aText(t.transport.a5a_factor === null ? '' : String(t.transport.a5a_factor))
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [runId])

  const a5aValid = useMemo(() => {
    if (!cat) return true
    if (a5aText.trim() === '') return true          // blank -> SEAI default
    const v = Number(a5aText)
    return Number.isFinite(v) && v >= cat.a5a.min && v <= cat.a5a.max
  }, [a5aText, cat])

  // Saves only after a real edit, and never an out-of-range A5a.
  const { saveState, leaving, leaveWith, retry } = useAutoSave(
    state, (v, o) => saveTransport(runId, v, o), dirty.current && a5aValid)

  function setLeg(key: string, leg: 'sea' | 'road', value: string) {
    dirty.current = true
    const n = Math.max(0, Number(value) || 0)
    setState((s) => ({
      ...s,
      distances: { ...s.distances, [key]: { ...s.distances[key], [leg]: n } },
    }))
  }

  function setWaste(material: string, value: string) {
    dirty.current = true
    const n = Math.min(50, Math.max(0, Number(value) || 0))
    setState((s) => ({ ...s, waste_pct: { ...s.waste_pct, [material]: n } }))
  }

  function setA5a(text: string) {
    dirty.current = true
    setA5aText(text)
    setState((s) => ({
      ...s,
      a5a_factor: text.trim() === '' ? null : Number(text),
    }))
  }

  function resetDistances() {
    if (!cat) return
    dirty.current = true
    const distances: TransportState['distances'] = {}
    cat.transport_defaults.forEach((d) => { distances[d.key] = { sea: d.sea, road: d.road } })
    setState((s) => ({ ...s, distances }))
  }

  function resetWaste() {
    if (!cat) return
    dirty.current = true
    setState((s) => ({ ...s, waste_pct: { ...cat.waste_defaults } }))
  }

  function resetA5a() {
    dirty.current = true
    setA5aText('')
    setState((s) => ({ ...s, a5a_factor: null }))
  }

  if (loading) {
    return (
      <div className="step">
        <div className="alert alert-busy" role="status">
          <span className="spinner" aria-hidden="true" />Loading defaults…
        </div>
      </div>
    )
  }
  if (error || !cat) {
    return (
      <div className="step">
        <div className="alert alert-bad" role="alert">{error ?? 'No catalogue.'}</div>
        <button className="ghost" onClick={onBack}>← Back</button>
      </div>
    )
  }

  const a5aUsed = state.a5a_factor === null ? cat.a5a.default : state.a5a_factor
  const isOverride = state.a5a_factor !== null && state.a5a_factor !== cat.a5a.default
  const a5aTonnes = area && area > 0 ? (a5aUsed * area) / 1000 : null

  const changedDistances = cat.transport_defaults.filter((d) => {
    const cur = state.distances[d.key]
    return cur && (cur.sea !== d.sea || cur.road !== d.road)
  }).length

  return (
    <div className="step">
      <header className="step-head">
        <h1>Transport &amp; Waste</h1>
        <p>
          How far materials travel (A4) and how much is wasted on site (A5w).
          Every figure follows SEAI guidance — leave them, or adjust where you
          know better.
        </p>
      </header>

      {/* ── A4 distances ────────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <h2>Delivery distances (A4)</h2>
          <SavePill state={saveState} onRetry={retry} />
        </div>
        <p className="hint">
          One-way kilometres. The return leg for road is added automatically —
          an empty lorry still burns fuel.
        </p>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Material</th><th>Typical sourcing</th>
                <th className="num">Sea km</th><th className="num">Road km</th>
              </tr>
            </thead>
            <tbody>
              {cat.transport_defaults.map((d) => {
                const cur = state.distances[d.key] ?? { sea: d.sea, road: d.road }
                const moved = cur.sea !== d.sea || cur.road !== d.road
                return (
                  <tr key={d.key}>
                    <td>{d.label}</td>
                    <td className="scenario">{d.scenario}</td>
                    <td className="num">
                      <input type="number" min="0" value={cur.sea}
                             aria-label={`${d.label} sea km`}
                             onChange={(e) => setLeg(d.key, 'sea', e.target.value)} />
                    </td>
                    <td className="num">
                      <input type="number" min="0" value={cur.road}
                             aria-label={`${d.label} road km`}
                             onChange={(e) => setLeg(d.key, 'road', e.target.value)} />
                      {moved && <span className="moved" title={`SEAI default: ${d.sea} sea / ${d.road} road`}>edited</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button type="button" className="mini" onClick={resetDistances}>
            Reset to SEAI defaults
          </button>
          {changedDistances > 0 && (
            <span className="hint hint-warn" style={{ alignSelf: 'center' }}>
              {changedDistances} material{changedDistances > 1 ? 's' : ''} changed
              from the default
            </span>
          )}
        </div>
      </section>

      {/* ── A5w waste ───────────────────────────────────────────────── */}
      <section className="panel">
        <h2>Waste allowances (A5w)</h2>
        <p className="hint">
          Extra material bought to cover site wastage. It carries the carbon of
          both making it and delivering it.
        </p>

        <div className="waste-grid">
          {Object.keys(cat.waste_defaults).map((m) => {
            const pct = state.waste_pct[m] ?? cat.waste_defaults[m]
            return (
              <div className="waste-row" key={m}>
                <span className="waste-name">{m}</span>
                <input type="number" min="0" max="50" step="0.5" value={pct}
                       aria-label={`${m} waste percent`}
                       onChange={(e) => setWaste(m, e.target.value)} />
                <span className="waste-unit">
                  % <em>× {(1 + pct / 100).toFixed(3)}</em>
                </span>
                <span className="waste-note">{WASTE_NOTES[m] ?? ''}</span>
              </div>
            )
          })}
        </div>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button type="button" className="mini" onClick={resetWaste}>
            Reset to SEAI defaults
          </button>
        </div>
      </section>

      {/* ── A5a site activity ───────────────────────────────────────── */}
      <section className="panel">
        <h2>Site activity (A5a)</h2>
        <p className="hint">
          Emissions from plant, temporary works and site power. SEAI gives
          40 kgCO₂e/m² for a whole building; this assessment covers the
          structure only, so <strong>70% ({cat.a5a.default} kgCO₂e/m²)</strong> is
          the default. Replace it if you have site data or a contractor&rsquo;s
          method statement.
        </p>

        <div className="a5a-row">
          <label className="field" style={{ maxWidth: 220 }}>
            <span>kgCO₂e per m² of floor area</span>
            <input type="number" step="0.1" min={cat.a5a.min} max={cat.a5a.max}
                   value={a5aText} placeholder={String(cat.a5a.default)}
                   aria-invalid={!a5aValid}
                   onChange={(e) => setA5a(e.target.value)} />
          </label>

          <div className="a5a-calc">
            {a5aTonnes !== null ? (
              <>
                <strong>{area!.toLocaleString()} m² × {a5aUsed} kgCO₂e/m²</strong>
                <span> = {a5aTonnes.toFixed(1)} tCO₂e</span>
              </>
            ) : (
              <span className="hint">Enter the floor area in Step 1 to see the total.</span>
            )}
          </div>
        </div>

        {!a5aValid && (
          <p className="hint hint-bad">
            Enter a number between {cat.a5a.min} and {cat.a5a.max}, or clear the
            field to use the SEAI default of {cat.a5a.default}.
          </p>
        )}
        {a5aValid && isOverride && (
          <p className="hint hint-warn">
            Override active — {a5aUsed} kgCO₂e/m² replaces the SEAI default for
            every element and every report in this run.
          </p>
        )}

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button type="button" className="mini" onClick={resetA5a}>
            Reset to SEAI default ({cat.a5a.default})
          </button>
        </div>
      </section>

      <SaveFailed state={saveState} onRetry={retry} />

      <footer className="step-foot">
        <button type="button" className="ghost" disabled={leaving}
                onClick={leaveWith(onBack)}>← Back</button>
        <button type="button" className="primary" disabled={!a5aValid || leaving}
                onClick={leaveWith(onContinue)}>
          {leaving ? 'Saving…' : 'Continue to Data Check →'}
        </button>
      </footer>
    </div>
  )
}
