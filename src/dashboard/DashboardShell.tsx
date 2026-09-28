/**
 * Results dashboard - shell, KPI tiles and SCORS rating scale.
 *
 * Deliberately styled as its OWN surface rather than inheriting the wizard's
 * palette: the wizard is where you put things in, the dashboard is where the
 * answer comes out, and the legacy HTML dashboard already established navy /
 * green for that. Reusing its tokens keeps the two recognisably related while
 * making the change of mode obvious.
 *
 * Every figure here is read from the server. Nothing is recomputed in the
 * browser - a chart that disagrees with the KPI above it is the failure mode
 * this whole port has been guarding against.
 */

import { useEffect, useState } from 'react'
import {
  ApiError,
  getDashboard,
  type DashboardResponse,
} from '../api'
import ScorsScale from './ScorsScale'
import KpiRow from './KpiRow'
import AnalysisTab from './AnalysisTab'
import DetailTable from './DetailTable'
import AssumptionsPanel from './AssumptionsPanel'
import DecarbTab from './DecarbTab'
import EmissionsPanel from './EmissionsPanel'
import SidebarActions from './SidebarActions'
import ReportDownloads from './ReportDownloads'

interface Props {
  runId: string
  onBack: () => void
}

type Tab = 'analysis' | 'decarbonisation'

export default function DashboardShell({ runId, onBack }: Props) {
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(
    () => (typeof window !== 'undefined'
      && window.location.hash === '#decarbonisation')
      ? 'decarbonisation' : 'analysis')
  // #assumptions and #emissions open a panel directly, so the basis of a
  // number is shareable as a link rather than something to describe in an email.
  // One panel at a time: they are full-height overlays, and two open at once
  // would stack invisibly.
  const [panel, setPanel] = useState<'assumptions' | 'emissions' | null>(
    () => {
      if (typeof window === 'undefined') return null
      if (window.location.hash === '#assumptions') return 'assumptions'
      if (window.location.hash === '#emissions') return 'emissions'
      return null
    })

  function openPanel(which: 'assumptions' | 'emissions') {
    setPanel(which)
    window.location.hash = which
  }

  function closePanel() {
    setPanel(null)
    if (window.location.hash === '#assumptions'
        || window.location.hash === '#emissions') {
      history.replaceState(null, '',
        window.location.pathname + window.location.search)
    }
  }

  useEffect(() => {
    let cancelled = false
    getDashboard(runId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled &&
        setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [runId])

  if (loading) {
    return (
      <div className="dash">
        <div className="dash-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading results…
        </div>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="dash">
        <div className="dash-alert bad" role="alert">{error ?? 'No results.'}</div>
        <button className="dash-btn" onClick={onBack}>← Back</button>
      </div>
    )
  }

  const project = (data.project ?? {}) as Record<string, string | number>

  return (
    <div className="dash">
      {/* ── Project bar ─────────────────────────────────────────────── */}
      <header className="dash-bar">
        <div className="dash-bar-main">
          <h1>{String(project.name ?? 'Untitled')}</h1>
          <div className="dash-meta">
            {[
              project.location && String(project.location),
              project.client && String(project.client),
              project.area && `${Number(project.area).toLocaleString()} m² GIA`,
              data.filename,
            ].filter(Boolean).map((m, i) => <span key={i}>{m}</span>)}
          </div>
        </div>
        <div className="dash-bar-side">
          {data.stage_badge && (
            <span className={`stage-badge stage-${data.rating.replace(/\+/g, 'p')}`}>
              {data.stage_badge} · ±{data.uncertainty_pct}%
            </span>
          )}
          {/* Assumptions moved to the floating sidebar, where the legacy
              report kept it — reachable from anywhere in a long page rather
              than only from the top. */}
          <button className="dash-btn ghost" onClick={onBack}>← Wizard</button>
        </div>
      </header>

      {/* Materials with no emission factor contribute zero. Saying so is the
          point: silently under-counting is worse than a visible gap. */}
      {data.no_factor.count > 0 && (
        <div className="dash-alert warn" role="alert">
          <strong>
            {data.no_factor.count} element{data.no_factor.count === 1 ? '' : 's'}{' '}
            ({data.no_factor.volume_m3} m³) have no emission factor and
            contribute zero.
          </strong>
          <p>
            {data.no_factor.categories.join(', ')} — assign a factor in the
            Materials step to include them.
          </p>
        </div>
      )}

      {data.sequestration_ton < 0 && (
        <div className="dash-alert info" role="status">
          <strong>
            {Math.abs(data.sequestration_ton).toFixed(2)} tCO₂e of biogenic
            carbon is stored in timber.
          </strong>
          <p>
            Reported separately per EN 16485 — it is <em>not</em> subtracted from
            the A1–A5 total above.
          </p>
        </div>
      )}

      <KpiRow data={data} />
      <ScorsScale bands={data.scors_bands} perSqm={data.per_sqm}
                  rating={data.rating} benchmark={data.benchmark} />

      <ReportDownloads runId={runId} calculatedAt={data.calculated_at} />

      {/* ── Tabs ────────────────────────────────────────────────────── */}
      <nav className="dash-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'analysis'}
                className={tab === 'analysis' ? 'active' : ''}
                onClick={() => setTab('analysis')}>
          Carbon Analysis
        </button>
        <button role="tab" aria-selected={tab === 'decarbonisation'}
                className={tab === 'decarbonisation' ? 'active' : ''}
                onClick={() => setTab('decarbonisation')}>
          Decarbonisation &amp; Value Engineering
        </button>
      </nav>

      <section className="dash-panels" role="tabpanel">
        {tab === 'analysis' && (
          <>
            <AnalysisTab data={data} />
            <section className="chart-card wide" style={{ marginTop: 14 }}>
              <h3>Detailed element data</h3>
              <p className="chart-note">
                Every priced line in the bill of quantities. Filters apply
                instantly — the rows are already loaded.
              </p>
              <DetailTable runId={runId} totalTon={data.total_ton} />
            </section>
          </>
        )}
        {tab === 'decarbonisation' && <DecarbTab data={data} />}
      </section>

      <SidebarActions
        onEmissions={() => openPanel('emissions')}
        onAssumptions={() => openPanel('assumptions')}
        onValueEngineering={() => {
          setTab('decarbonisation')
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }}
      />

      <AssumptionsPanel data={data} open={panel === 'assumptions'}
                        onClose={closePanel} />
      <EmissionsPanel runId={runId} open={panel === 'emissions'}
                      onClose={closePanel} />

      <footer className="dash-foot">
        Factor database {data.catalogue_version} · calculated{' '}
        {new Date(data.calculated_at).toLocaleString()}
      </footer>
    </div>
  )
}

