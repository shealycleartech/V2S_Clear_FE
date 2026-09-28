/**
 * Report downloads - the files that leave the building.
 *
 * Lists every format the server can build, with a Download button for the ones
 * already generated and a Generate button for the rest, so a format not ticked
 * in Step 6 can still be had afterwards. Generation runs on the server; this
 * polls until it settles.
 *
 * A report is a snapshot of the calculation it was built from. One generated
 * BEFORE the latest calculation is flagged as out of date, because issuing it
 * would quote numbers the dashboard above no longer shows.
 *
 * Only one generation at a time: the server records reports in a single
 * manifest, and two jobs finishing together could each overwrite the other's
 * entry.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, downloadReport, getReports, requestReports } from '../api'

type ReportsInfo = Awaited<ReturnType<typeof getReports>>

interface Props {
  runId: string
  /** When the results on screen were calculated - reports older than this are stale. */
  calculatedAt: string
}

/** Display order and wording. Kinds the server adds later still appear, using
 *  the server's own label. */
const KINDS: { kind: string; label: string; ext: string; hint: string }[] = [
  { kind: 'word', label: 'Word report', ext: '.docx',
    hint: 'A3 landscape summary, ready to issue.' },
  { kind: 'excel', label: 'Excel workbook', ext: '.xlsx',
    hint: 'Full bill of quantities with the emission factors applied.' },
  { kind: 'boq', label: 'Quantities export', ext: '.xlsx',
    hint: 'Extracted quantities, including anything you excluded.' },
  { kind: 'html', label: 'Offline HTML report', ext: '.html',
    hint: 'The interactive report as a single file. Opens without the app and can be emailed.' },
]

const POLL_MS = 1000

function fmtSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Milliseconds for a server timestamp. The server writes UTC, but SQLite drops
 *  the zone on the way back out - and a zone-less ISO string is read by the
 *  browser as LOCAL time, which would skew the out-of-date check by the UTC
 *  offset. So a string with no zone is taken as UTC. */
function toMs(iso?: string | null) {
  if (!iso) return NaN
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`
  return new Date(zoned).getTime()
}

function fmtWhen(iso?: string) {
  if (!iso) return ''
  const d = new Date(toMs(iso))
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined,
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function ReportDownloads({ runId, calculatedAt }: Props) {
  const [info, setInfo] = useState<ReportsInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [requesting, setRequesting] = useState(false)
  const alive = useRef(true)
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await getReports(runId)
      if (!alive.current) return
      setInfo(r)
      setLoadError(null)
      // Keep polling while the server is still building.
      if (r.status === 'generating') {
        timer.current = window.setTimeout(load, POLL_MS)
      }
    } catch (e) {
      if (!alive.current) return
      setLoadError(e instanceof ApiError ? e.message : String(e))
    }
  }, [runId])

  useEffect(() => {
    alive.current = true
    load()
    return () => {
      alive.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [load])

  async function generate(kind: string) {
    setActionError(null)
    setRequesting(true)
    try {
      await requestReports(runId, [kind])
      if (timer.current !== null) window.clearTimeout(timer.current)
      await load()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e))
    } finally {
      if (alive.current) setRequesting(false)
    }
  }

  async function download(kind: string, filename: string) {
    setActionError(null)
    setDownloading(kind)
    try {
      await downloadReport(runId, kind, filename)
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e))
      // A 410 means the listing is out of step with storage - refresh it so
      // the row offers Generate again.
      load()
    } finally {
      if (alive.current) setDownloading(null)
    }
  }

  const generating = info?.status === 'generating'
  const busy = generating || requesting
  const known = new Set(KINDS.map((k) => k.kind))
  const rows = info
    ? [...KINDS.filter((k) => info.available.some((a) => a.kind === k.kind)),
       ...info.available.filter((a) => !known.has(a.kind))
         .map((a) => ({ kind: a.kind, label: a.label, ext: '', hint: '' }))]
    : []
  const calcTime = toMs(calculatedAt)

  return (
    <section className="chart-card report-card" aria-labelledby="reports-h">
      <h3 id="reports-h">Reports</h3>
      <p className="chart-note">
        Download the deliverables for this calculation, or generate any you
        did not tick before running it.
      </p>

      {loadError && (
        <div className="dash-alert bad" role="alert">
          Could not load the reports: {loadError}{' '}
          <button type="button" className="dash-btn" onClick={load}>Try again</button>
        </div>
      )}
      {actionError && <div className="dash-alert bad" role="alert">{actionError}</div>}
      {info?.status === 'failed' && (
        <div className="dash-alert bad" role="alert">
          <strong>The last report generation failed.</strong>
          {info.error && <p>{info.error}</p>}
        </div>
      )}

      {!info && !loadError && (
        <p className="chart-note" role="status">Loading reports…</p>
      )}

      {info && (
        <ul className="report-list">
          {rows.map((k) => {
            const file = info.files[k.kind]
            const isGenerating = generating && info.requested?.includes(k.kind)
            const stale = !!file?.generated_at
              && toMs(file.generated_at) < calcTime
            return (
              <li key={k.kind} className="report-row" data-kind={k.kind}>
                <div className="report-text">
                  <strong>{k.label}</strong>
                  {k.ext && <span className="report-ext">{k.ext}</span>}
                  {k.hint && <small>{k.hint}</small>}
                </div>
                <div className="report-state">
                  {isGenerating ? (
                    <span className="report-status" role="status">
                      <span className="spinner" aria-hidden="true" /> Generating…
                    </span>
                  ) : file ? (
                    <>
                      <span className={`report-status${stale ? ' stale' : ''}`}
                            title={stale ? `Generated ${fmtWhen(file.generated_at)}, `
                              + 'before the latest calculation' : undefined}>
                        {stale ? 'Out of date' : `${fmtSize(file.size)} · ${fmtWhen(file.generated_at)}`}
                      </span>
                      {stale && (
                        <button type="button" className="dash-btn" disabled={busy}
                                onClick={() => generate(k.kind)}>Regenerate</button>
                      )}
                      <button type="button" className="dash-btn primary"
                              disabled={downloading !== null}
                              onClick={() => download(k.kind, file.filename)}>
                        {downloading === k.kind ? 'Downloading…' : 'Download'}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="report-status muted">Not generated</span>
                      <button type="button" className="dash-btn" disabled={busy}
                              onClick={() => generate(k.kind)}>Generate</button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
