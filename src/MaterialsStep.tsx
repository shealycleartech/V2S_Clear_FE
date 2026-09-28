/**
 * Step 3 - Materials.
 *
 * Assigns an emission factor to every element: concrete grade + GGBS, rebar and
 * PT rates, and the steel factor for modelled steel. Global defaults at the top,
 * bulk-apply by category, per-row override in the table.
 *
 * The cell rules are carried over from the legacy wizard verbatim, because they
 * are not cosmetic - each one prevents a wrong number:
 *
 *   steel row            -> factor dropdown; grade/GGBS/rebar/PT are meaningless
 *   inc_reinf factor     -> rebar/PT CLOSED (precast already prices its steel;
 *                           adding a rate would count reinforcement twice)
 *   non-in-situ factor   -> GGBS/rebar/PT n/a (a fixed e_id already sets the mix)
 *   pt_applicable false  -> PT n/a (a column or pile cannot be post-tensioned)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  getCatalogue,
  getMaterials,
  saveMaterials,
  type CatalogueResponse,
  type EpdOverride,
  type FullFactor,
  type MaterialOverride,
  type MaterialRow,
  type MaterialsState,
} from './api'
import { SaveFailed, SavePill, useAutoSave } from './useAutoSave'

interface Props {
  runId: string
  onBack: () => void
  onContinue: () => void
}

/** Order the catalogue groups appear in. Mirrors the legacy dropdown order. */
const GROUP_ORDER = [
  'Concrete — In-situ', 'Concrete — Precast', 'Concrete — Blocks & Walls',
  'Steel — Structural', 'Steel — Other Products', 'Post Tensioning',
  'Timber / Mass Timber', 'Concrete', 'Steel', 'Other',
]

/** Units and sanity ranges per material, carried over from the legacy EPD card.
 *  Concrete EPDs are published per m³; everything else per kg. */
const EPD_RANGES: Record<string, { unit: string; min: number; max: number; hint: string }> = {
  Concrete: { unit: 'kgCO₂e/m³', min: 50, max: 600, hint: 'typical 150–400' },
  Rebar: { unit: 'kgCO₂e/kg', min: 0.3, max: 4, hint: 'typical 0.5–2.5' },
  'Steel Section': { unit: 'kgCO₂e/kg', min: 0.3, max: 4, hint: 'typical 0.5–2.5' },
  'Post Tensioning': { unit: 'kgCO₂e/kg', min: 0.3, max: 4, hint: 'typical 0.5–2.5' },
}
const epdRange = (t: string) => EPD_RANGES[t] ?? EPD_RANGES.Rebar

/** Strip " MPa" / "(GEN n)" so we get a bare grade like "32/40". */
const cleanGrade = (g: string) =>
  String(g).replace(/\s*\(GEN\s*\d+\)/i, '').replace(/\s*MPa\s*/i, '').trim()

export default function MaterialsStep({ runId, onBack, onContinue }: Props) {
  const [cat, setCat] = useState<CatalogueResponse | null>(null)
  const [rows, setRows] = useState<MaterialRow[]>([])
  const [state, setState] = useState<MaterialsState>({
    defaults: {}, rows: {}, epd_overrides: {},
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pickedCats, setPickedCats] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState({ grade: '', ggbs: '', rebar: '', pt: '', steel: '' })
  const [bulkMsg, setBulkMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [epdSel, setEpdSel] = useState('')
  const [epdVal, setEpdVal] = useState('')
  const [epdSrc, setEpdSrc] = useState('')
  const [epdMsg, setEpdMsg] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null)

  const dirty = useRef(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([getCatalogue(), getMaterials(runId)])
      .then(([c, m]) => {
        if (cancelled) return
        setCat(c)
        setRows(m.rows)
        setState({
          defaults: Object.keys(m.materials.defaults).length
            ? m.materials.defaults
            : { ...c.defaults },
          rows: m.materials.rows ?? {},
          epd_overrides: m.materials.epd_overrides ?? {},
        })
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [runId])

  // Saves only after a real edit - loading the step is not a change.
  const { saveState, leaving, leaveWith, retry } = useAutoSave(
    state, (v, o) => saveMaterials(runId, v, o), dirty.current)

  const factorById = useMemo(() => {
    const m = new Map<string, { name: string; group: string; inc_reinf: boolean }>()
    cat?.full_factors.forEach((f: FullFactor) => m.set(f.e_id, f))
    return m
  }, [cat])

  const groupedFactors = useMemo<[string, FullFactor[]][]>(() => {
    if (!cat) return []
    const by = new Map<string, FullFactor[]>()
    cat.full_factors.forEach((f) => {
      if (!by.has(f.group)) by.set(f.group, [])
      by.get(f.group)!.push(f)
    })
    const ordered = GROUP_ORDER.filter((g) => by.has(g))
      .concat([...by.keys()].filter((g) => !GROUP_ORDER.includes(g)))
    return ordered.map((g) => [g, by.get(g)!])
  }, [cat])

  const incReinf = useCallback(
    (eid?: string) => !!(eid && factorById.get(eid)?.inc_reinf), [factorById])
  const isInsitu = useCallback(
    (eid?: string) => factorById.get(eid ?? '')?.group === 'Concrete — In-situ',
    [factorById])

  /** Effective settings for a row: its override, falling back to the defaults. */
  const settingsFor = useCallback((r: MaterialRow): Required<
    Pick<MaterialOverride, 'grade' | 'ggbs' | 'rebarRate' | 'ptRate'>
  > & MaterialOverride => {
    const o = state.rows[r.key] ?? {}
    return {
      ...o,
      grade: o.grade ?? r.grade ?? String(state.defaults.concrete_grade ?? ''),
      ggbs: o.ggbs ?? r.ggbs ?? Number(state.defaults.ggbs_pct ?? 0),
      rebarRate: o.rebarRate ?? r.default_rebar ?? 150,
      ptRate: o.ptRate ?? 0,
    }
  }, [state])

  function patchRow(key: string, patch: MaterialOverride) {
    dirty.current = true
    setState((s) => ({ ...s, rows: { ...s.rows, [key]: { ...s.rows[key], ...patch } } }))
  }

  function patchDefaults(patch: Record<string, string | number>) {
    dirty.current = true
    setState((s) => ({ ...s, defaults: { ...s.defaults, ...patch } }))
  }

  /** Push the global grade + GGBS onto every concrete row, clearing any
   *  per-row catalogue factor (picking a grade means "in-situ", by definition). */
  function applyDefaultsToAll() {
    dirty.current = true
    setState((s) => {
      const next = { ...s.rows }
      rows.filter((r) => !r.is_steel).forEach((r) => {
        next[r.key] = {
          ...next[r.key],
          grade: String(s.defaults.concrete_grade ?? ''),
          ggbs: Number(s.defaults.ggbs_pct ?? 0),
          concFactorEid: undefined,
        }
      })
      return { ...s, rows: next }
    })
    setBulkMsg({ tone: 'ok', text: `Applied to ${rows.filter((r) => !r.is_steel).length} concrete rows.` })
  }

  function applyBulk() {
    const { grade, ggbs, rebar, pt, steel } = bulk
    if (!grade && ggbs === '' && rebar === '' && pt === '' && !steel) return
    const targets = pickedCats.size > 0 ? pickedCats : null
    let nConc = 0, nSteel = 0

    dirty.current = true
    setState((s) => {
      const next = { ...s.rows }
      rows.forEach((r) => {
        if (targets && !targets.has(r.cat)) return
        if (r.is_steel) {
          // Steel takes ONLY the factor assignment - grade/rebar/PT are n/a.
          if (steel) { next[r.key] = { ...next[r.key], steelEid: steel }; nSteel++ }
          return
        }
        const patch: MaterialOverride = { ...next[r.key] }
        let touched = false
        if (grade) { patch.grade = grade; patch.concFactorEid = undefined; touched = true }
        if (ggbs !== '') { patch.ggbs = Number(ggbs); touched = true }
        if (rebar !== '') { patch.rebarRate = Number(rebar); touched = true }
        if (pt !== '' && r.pt_applicable) { patch.ptRate = Number(pt); touched = true }
        if (touched) { next[r.key] = patch; nConc++ }
      })
      return { ...s, rows: next }
    })

    const parts = []
    if (nConc) parts.push(`${nConc} concrete row${nConc > 1 ? 's' : ''}`)
    if (nSteel) parts.push(`${nSteel} steel row${nSteel > 1 ? 's' : ''}`)

    if (parts.length) {
      setBulkMsg({ tone: 'ok', text: `Applied to ${parts.join(' + ')}.` })
      // Only clear on success. Clearing after a no-op would hide what was tried,
      // leaving the user with an unexplained warning and empty inputs.
      setBulk({ grade: '', ggbs: '', rebar: '', pt: '', steel: '' })
      return
    }

    // Nothing applied. Say WHY, naming the categories involved, rather than
    // restating the rule and leaving the user to work out which case they hit.
    const scope = rows.filter((r) => !targets || targets.has(r.cat))
    const steelOnlyCats = [...new Set(scope.filter((r) => r.is_steel).map((r) => r.cat))]
    const anyConcrete = scope.some((r) => !r.is_steel)
    const setConcreteField = !!grade || ggbs !== '' || rebar !== '' || pt !== ''

    if (setConcreteField && !anyConcrete && steelOnlyCats.length) {
      setBulkMsg({ tone: 'warn', text:
        `${steelOnlyCats.join(', ')} contains only steel elements, and grade / GGBS / `
        + `rebar / PT apply to concrete. To change steel, use the "Steel factor" `
        + `dropdown instead.` })
    } else if (steel && !scope.some((r) => r.is_steel)) {
      setBulkMsg({ tone: 'warn', text:
        `The selected categories contain no steel, so the steel factor had nothing `
        + `to apply to.` })
    } else if (pt !== '' && !scope.some((r) => r.pt_applicable)) {
      setBulkMsg({ tone: 'warn', text:
        `None of the selected elements can be post-tensioned — PT applies to slabs, `
        + `beams, walls and rafts.` })
    } else {
      setBulkMsg({ tone: 'warn', text: 'Nothing matched the selected categories.' })
    }
  }

  /** Materials currently in use, each offering one EPD slot. Rebuilt from the
   *  live assignments so a factor you just picked shows up immediately. */
  const epdItems = useMemo(() => {
    const items: { key: string; label: string; mat_type: string;
                   grade?: string; ggbs?: number; e_id?: string }[] = []
    const seen = new Set<string>()
    rows.forEach((r) => {
      const st = settingsFor(r)
      if (r.is_steel) {
        const eid = st.steelEid || r.e_id || 'R_005'
        const k = `${r.factor_type}|||${eid}`
        if (seen.has(k)) return
        seen.add(k)
        items.push({ key: k, mat_type: r.factor_type, e_id: eid,
          label: cat?.steel_factor_names[eid] ?? factorById.get(eid)?.name ?? eid })
        return
      }
      const fx = st.concFactorEid || st.fullEid
      if (fx) {
        const k = `Concrete|||${fx}`
        if (seen.has(k)) return
        seen.add(k)
        items.push({ key: k, mat_type: 'Concrete', e_id: fx,
          label: factorById.get(fx)?.name ?? fx })
        return
      }
      const g = cleanGrade(st.grade)
      const k = `Concrete|||${g}|||${st.ggbs}`
      if (seen.has(k)) return
      seen.add(k)
      items.push({ key: k, mat_type: 'Concrete', grade: g, ggbs: st.ggbs,
        label: `Concrete C${g} (${st.ggbs}% GGBS)` })
    })
    // A concrete-only model still estimates rebar by rate, so its factor must be
    // overridable even though no steel row exists.
    if (!rows.some((r) => r.is_steel) && rows.length) {
      const k = 'Rebar|||R_005'
      if (!seen.has(k)) items.push({ key: k, mat_type: 'Rebar', e_id: 'R_005',
        label: cat?.steel_factor_names['R_005'] ?? 'Reinforcement' })
    }
    return items
  }, [rows, settingsFor, cat, factorById])

  useEffect(() => {
    if (epdItems.length && !epdItems.some((i) => i.key === epdSel)) {
      setEpdSel(epdItems[0].key)
    }
  }, [epdItems, epdSel])

  function applyEpd() {
    const item = epdItems.find((i) => i.key === epdSel)
    if (!item) return
    const v = Number(epdVal)
    if (!v || v <= 0) {
      setEpdMsg({ tone: 'bad', text: 'Enter a value greater than zero.' })
      return
    }
    const r = epdRange(item.mat_type)
    setEpdMsg(v < r.min || v > r.max
      ? { tone: 'warn', text: `${v} is outside the expected range (${r.hint} ${r.unit}). Check the units.` }
      : { tone: 'ok', text: `${item.label}: ${v} ${r.unit} applied.` })
    dirty.current = true
    setState((s) => ({ ...s, epd_overrides: { ...s.epd_overrides, [item.key]: {
      a1_a3: v, source: epdSrc.trim(), mat_type: item.mat_type,
      grade: item.grade ?? null, ggbs: item.ggbs ?? null, e_id: item.e_id ?? null,
    } } }))
    setEpdVal(''); setEpdSrc('')
  }

  function revertEpd() {
    const item = epdItems.find((i) => i.key === epdSel)
    if (!item) return
    if (!state.epd_overrides[item.key]) {
      setEpdMsg({ tone: 'warn', text: `${item.label} already uses the standard value.` })
      return
    }
    dirty.current = true
    setState((s) => {
      const next = { ...s.epd_overrides }
      delete next[item.key]
      return { ...s, epd_overrides: next }
    })
    setEpdMsg({ tone: 'ok', text: `${item.label} reverted to the standard value.` })
  }

  if (loading) {
    return (
      <div className="step">
        <div className="alert alert-busy" role="status">
          <span className="spinner" aria-hidden="true" />Loading materials…
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

  const cats = [...new Set(rows.map((r) => r.cat))].sort()
  const epdUnit = epdRange(epdItems.find((i) => i.key === epdSel)?.mat_type ?? 'Rebar')

  return (
    <div className="step">
      <header className="step-head">
        <h1>Materials</h1>
        <p>
          Set the defaults, then fine-tune any element in the table. Each choice
          decides which carbon factor that element is priced with.
        </p>
      </header>

      {/* ── Global defaults ─────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <h2>Defaults for every element</h2>
          <SavePill state={saveState} onRetry={retry} />
        </div>
        <div className="grid">
          <label className="field">
            <span>Concrete grade</span>
            <select value={String(state.defaults.concrete_grade ?? '')}
                    onChange={(e) => patchDefaults({ concrete_grade: e.target.value })}>
              {cat.concrete_grades.map((g) => <option key={g}>{g}</option>)}
            </select>
          </label>
          <label className="field">
            <span>GGBS <em>— cement replacement</em></span>
            <select value={String(state.defaults.ggbs_pct ?? 0)}
                    onChange={(e) => patchDefaults({ ggbs_pct: Number(e.target.value) })}>
              {cat.ggbs_options.map((p) => (
                <option key={p} value={p}>{p}%{p === 0 ? ' — none (CEM I)' : ''}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Reinforcement type</span>
            <select value={String(state.defaults.rebar_type ?? '')}
                    onChange={(e) => patchDefaults({ rebar_type: e.target.value })}>
              {cat.rebar_types.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Steel section type</span>
            <select value={String(state.defaults.section_type ?? '')}
                    onChange={(e) => patchDefaults({ section_type: e.target.value })}>
              {cat.section_types.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Post-tensioning type</span>
            <select value={String(state.defaults.pt_type ?? '')}
                    onChange={(e) => patchDefaults({ pt_type: e.target.value })}>
              {cat.pt_types.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
        </div>
        <button type="button" className="mini" style={{ marginTop: 12 }}
                onClick={applyDefaultsToAll}>
          Apply grade &amp; GGBS to every element
        </button>
      </section>

      {/* ── Bulk apply ──────────────────────────────────────────────── */}
      <section className="panel">
        <h2>Apply to selected categories</h2>
        <p className="hint">
          Pick categories (none selected = all), set values, then Apply.
        </p>
        <div className="chips">
          {cats.map((c) => {
            // Label steel-only categories: they accept the steel factor and
            // nothing else, so saying so up front avoids an Apply that silently
            // does nothing.
            const inCat = rows.filter((r) => r.cat === c)
            const kind = inCat.every((r) => r.is_steel) ? 'steel'
              : inCat.some((r) => r.is_steel) ? 'mixed' : 'concrete'
            return (
              <button key={c} type="button"
                      className={`chip pick-chip${pickedCats.has(c) ? ' picked' : ''}`}
                      aria-pressed={pickedCats.has(c)}
                      title={kind === 'steel'
                        ? `${c} is all steel — takes the steel factor only`
                        : kind === 'mixed' ? `${c} has both steel and concrete` : ''}
                      onClick={() => setPickedCats((s) => {
                        const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n
                      })}>
                {c}
                {kind !== 'concrete' && (
                  <span className={`kind kind-${kind}`}>
                    {kind === 'steel' ? 'steel' : 'mixed'}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div className="bulk-row">
          <label className="mini-field"><span>Grade</span>
            <select value={bulk.grade} onChange={(e) => setBulk({ ...bulk, grade: e.target.value })}>
              <option value="">(keep)</option>
              {cat.concrete_grades.map((g) => <option key={g}>{g}</option>)}
            </select>
          </label>
          <label className="mini-field"><span>GGBS %</span>
            <select value={bulk.ggbs} onChange={(e) => setBulk({ ...bulk, ggbs: e.target.value })}>
              <option value="">(keep)</option>
              {cat.ggbs_options.map((p) => <option key={p} value={p}>{p}%</option>)}
            </select>
          </label>
          <label className="mini-field"><span>Rebar kg/m³</span>
            <input type="number" min="0" max="600" placeholder="keep" value={bulk.rebar}
                   onChange={(e) => setBulk({ ...bulk, rebar: e.target.value })} />
          </label>
          <label className="mini-field"><span>PT kg/m³</span>
            <input type="number" min="0" placeholder="keep" value={bulk.pt}
                   onChange={(e) => setBulk({ ...bulk, pt: e.target.value })} />
          </label>
          <label className="mini-field wide"><span>Steel factor</span>
            <select value={bulk.steel} onChange={(e) => setBulk({ ...bulk, steel: e.target.value })}>
              <option value="">(keep)</option>
              {Object.entries(cat.steel_factors).map(([bucket, items]) =>
                items.length ? (
                  <optgroup key={bucket} label={bucket}>
                    {items.map((it) => <option key={it.e_id} value={it.e_id}>{it.name}</option>)}
                  </optgroup>
                ) : null)}
            </select>
          </label>
          <button type="button" className="mini primary-mini" onClick={applyBulk}>Apply</button>
        </div>
        {bulkMsg && (
          <p className={`hint ${bulkMsg.tone === 'ok' ? 'hint-good' : 'hint-warn'}`}>
            {bulkMsg.text}
          </p>
        )}
      </section>

      {/* ── The table ───────────────────────────────────────────────── */}
      <section className="panel">
        <h2>Materials &amp; reinforcement, per element</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th><th>Element</th>
                <th className="num">Quantity</th><th className="num">Count</th>
                <th>Grade / factor</th><th>GGBS %</th>
                <th>Rebar kg/m³</th><th>PT kg/m³</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = settingsFor(r)
                const full = r.allow_full_factor && !r.is_steel
                const chosen = full ? st.fullEid : st.concFactorEid
                const closedByReinf = incReinf(chosen)
                // A named factor that is not in-situ concrete already fixes the
                // mix, so GGBS and rate-based reinforcement stop applying.
                const fixedFactor = !!chosen && !isInsitu(chosen)

                return (
                  <tr key={r.key}>
                    <td><span className="cat-tag">{r.cat}</span></td>
                    <td className="elem-name" title={r.name}>
                      {r.name}
                      {r.is_steel && <span className="tag tag-steel">{r.material}</span>}
                    </td>
                    <td className="num">
                      {r.is_steel ? (
                        <>
                          {r.mass.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg
                          <span className="sub">
                            {r.mass_source === 'file'
                              ? 'from your file'
                              : 'volume × 7,850 kg/m³'}
                          </span>
                        </>
                      ) : r.vol.toFixed(2)}
                    </td>
                    <td className="num">{r.count}</td>

                    {/* Grade / factor */}
                    <td>
                      {r.is_steel ? (
                        <select value={st.steelEid ?? r.e_id ?? ''}
                                onChange={(e) => patchRow(r.key, { steelEid: e.target.value })}>
                          {Object.entries(cat.steel_factors).map(([b, items]) =>
                            items.length ? (
                              <optgroup key={b} label={b}>
                                {items.map((it) => (
                                  <option key={it.e_id} value={it.e_id}>{it.name}</option>
                                ))}
                              </optgroup>
                            ) : null)}
                        </select>
                      ) : (
                        <select
                          value={chosen ? `eid:${chosen}` : st.grade}
                          onChange={(e) => {
                            const v = e.target.value
                            if (v.startsWith('eid:')) {
                              patchRow(r.key, full
                                ? { fullEid: v.slice(4) }
                                : { concFactorEid: v.slice(4) })
                            } else {
                              patchRow(r.key, full
                                ? { fullEid: undefined, grade: v }
                                : { concFactorEid: undefined, grade: v })
                            }
                          }}>
                          <optgroup label="In-situ concrete grade">
                            {cat.concrete_grades.map((g) => <option key={g} value={g}>{g}</option>)}
                          </optgroup>
                          {groupedFactors.map(([g, items]) => (
                            <optgroup key={g} label={g}>
                              {items.map((f) => (
                                <option key={f.e_id} value={`eid:${f.e_id}`}>{f.name}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      )}
                    </td>

                    {/* GGBS */}
                    <td>
                      {r.is_steel || fixedFactor ? <em className="na">n/a</em> : (
                        <select value={st.ggbs}
                                onChange={(e) => patchRow(r.key, { ggbs: Number(e.target.value) })}>
                          {cat.ggbs_options.map((p) => (
                            <option key={p} value={p}
                                    disabled={p > (cat.ggbs_max_by_grade[cleanGrade(st.grade)] ?? 70)}>
                              {p}%
                            </option>
                          ))}
                        </select>
                      )}
                    </td>

                    {/* Rebar */}
                    <td>
                      {closedByReinf ? <em className="na inc">included in factor</em>
                        : r.is_steel ? <em className="na">modelled (mass)</em>
                        : fixedFactor ? <em className="na">n/a</em>
                        : (
                          <span className="rate-cell">
                            <input type="number" min="0" max="600" value={st.rebarRate}
                                   onChange={(e) => patchRow(r.key, { rebarRate: Number(e.target.value) })} />
                            <em className="sub">{r.rebar_hint}</em>
                          </span>
                        )}
                    </td>

                    {/* PT */}
                    <td>
                      {closedByReinf ? <em className="na inc">included</em>
                        : r.is_steel || fixedFactor || !r.pt_applicable
                          ? <em className="na">n/a</em>
                          : (
                            <input type="number" min="0" value={st.ptRate}
                                   onChange={(e) => patchRow(r.key, { ptRate: Number(e.target.value) })} />
                          )}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr><td colSpan={8} className="empty">
                  No elements — check the Choose Elements step.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── EPD override ────────────────────────────────────────────── */}
      <section className="panel">
        <h2>Have a supplier EPD?</h2>
        <p className="hint">
          Replace a built-in factor with the verified value from your supplier&rsquo;s
          certificate. It applies to every element using that material.
        </p>
        <div className="grid">
          <label className="field">
            <span>Material</span>
            <select value={epdSel} onChange={(e) => { setEpdSel(e.target.value); setEpdMsg(null) }}>
              {epdItems.length === 0 && <option value="">(set materials first)</option>}
              {epdItems.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>A1–A3 <em>{epdUnit.unit}</em></span>
            <input type="number" step="0.001" value={epdVal} placeholder={epdUnit.hint}
                   onChange={(e) => setEpdVal(e.target.value)} />
          </label>
          <label className="field">
            <span>Source <em>— optional</em></span>
            <input value={epdSrc} placeholder="e.g. Ecocem EPD 2024"
                   onChange={(e) => setEpdSrc(e.target.value)} />
          </label>
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button type="button" className="mini primary-mini" onClick={applyEpd}>Apply</button>
          <button type="button" className="mini" onClick={revertEpd}>Revert to standard</button>
        </div>
        {epdMsg && (
          <p className={`hint ${epdMsg.tone === 'ok' ? 'hint-good'
            : epdMsg.tone === 'warn' ? 'hint-warn' : 'hint-bad'}`}>{epdMsg.text}</p>
        )}
        {Object.keys(state.epd_overrides).length > 0 && (
          <ul className="epd-list">
            {Object.entries(state.epd_overrides).map(([k, v]: [string, EpdOverride]) => (
              <li key={k}>
                <strong>{epdItems.find((i) => i.key === k)?.label ?? k}</strong>
                {' → '}{v.a1_a3} {epdRange(v.mat_type ?? '').unit}
                {v.source && <em> · {v.source}</em>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <SaveFailed state={saveState} onRetry={retry} />

      <footer className="step-foot">
        <button type="button" className="ghost" disabled={leaving}
                onClick={leaveWith(onBack)}>← Back</button>
        <button type="button" className="primary" disabled={rows.length === 0 || leaving}
                onClick={leaveWith(onContinue)}>
          {leaving ? 'Saving…' : <>Continue to Transport &amp; Waste →</>}
        </button>
      </footer>
    </div>
  )
}
