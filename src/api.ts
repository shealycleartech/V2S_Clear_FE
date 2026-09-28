/**
 * API client for the C.L.E.A.R. backend.
 *
 * These types mirror the backend's element contract, which is IDENTICAL for
 * every ingest path (IFC, ready BOQ, Revit takeoff, scratch spreadsheet) -
 * verified by webapp/backend/tests/test_extraction_parity.py. That is why the
 * UI needs no per-file-type branching.
 *
 * Once the API stabilises these should be generated from /openapi.json rather
 * than hand-written, so the two can never drift.
 */

/** A run's lifecycle. Parsing and calculating are distinct phases: a run stays
 *  usable at 'parsed' (the wizard steps are editable) and only reaches
 *  'complete' once results exist. */
export type RunStatus =
  | 'created' | 'parsing' | 'parsed'
  | 'calculating' | 'complete' | 'failed'

/** One extracted structural element. 20 fields, same shape for every source. */
export interface ElementRow {
  idx: number
  cat: string
  name: string
  level: string
  vol: number
  count: number
  size: string
  is_steel: boolean
  material: string
  e_id: string
  factor_type: string
  grade: string
  ggbs: number | null
  mass: number
  default_rebar: number
  rebar_hint: string
  pt_applicable: boolean
  kg_per_m_hint: number
  mass_source: string
  allow_full_factor: boolean
}

export interface UploadResponse {
  run_id: string
  filename: string
  ext: string
  status: RunStatus
}

export interface StatusResponse {
  run_id: string
  status: RunStatus
  error: string | null
  n_elements: number | null
}

export interface ExtractionResponse {
  run_id: string
  filename: string
  /** Step-1 details, echoed back from the run. This is what makes a resumed
   *  session able to restore the project form without the user retyping it. */
  project?: {
    name?: string; area?: number | string | null; stage?: string | null
    structural_system?: string | null; location?: string | null
    client?: string | null
  }
  source_type: 'ifc' | 'csv'
  n_elements: number
  categories: string[]
  default_rates: Record<string, number>
  has_real_eids: boolean
  csv_fmt: string | null
  elements: ElementRow[]
}

/** Error carrying the backend's `detail` message rather than a generic string. */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

/**
 * Where the API lives.
 *
 * Empty in development, which leaves every path relative — the Vite dev server
 * proxies `/api` to the backend, so the browser sees one origin and CORS never
 * enters into it.
 *
 * Set VITE_API_URL when the two are deployed to different domains (Vercel and
 * Railway, say) and the paths become absolute. Vite inlines this AT BUILD TIME,
 * so changing it needs a rebuild, not a restart.
 *
 * Only one place in this file calls fetch(), so this is the only place a base
 * URL has to be applied — which is why that choke point exists.
 */
const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')

/**
 * This browser's identity.
 *
 * Not a credential — an identifier. It answers "which runs are mine" for a
 * visitor who has not signed in, and it is the thing a real account CLAIMS on
 * first login, so anonymous work is carried over rather than orphaned.
 *
 * Generated once and kept in localStorage. If storage is unavailable (private
 * window, blocked site data) a per-session id is used instead: the app still
 * works, the runs just do not outlive the tab.
 */
const CLIENT_KEY = 'clear:client-id'
let _sessionClientId: string | null = null

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

export function clientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_KEY)
    if (!id) {
      id = newId()
      localStorage.setItem(CLIENT_KEY, id)
    }
    return id
  } catch {
    if (!_sessionClientId) _sessionClientId = newId()
    return _sessionClientId
  }
}

/** The last run this browser opened, so a bare visit can offer to resume it. */
const LAST_RUN_KEY = 'clear:last-run'

export function rememberRun(runId: string | null): void {
  try {
    if (runId) localStorage.setItem(LAST_RUN_KEY, runId)
    else localStorage.removeItem(LAST_RUN_KEY)
  } catch { /* storage unavailable - resuming from a URL still works */ }
}

export function lastRun(): string | null {
  try {
    return localStorage.getItem(LAST_RUN_KEY)
  } catch {
    return null
  }
}

/** How a step save is sent. `keepalive` lets the request finish after the page
 *  has gone - used for the last save on refresh or tab close. */
export interface SaveOptions {
  keepalive?: boolean
}

/** Settles once every step save registered so far has finished. */
let pendingSaves: Promise<unknown> = Promise.resolve()

/** Make reads wait for this save. Called by useAutoSave the moment a save is
 *  queued, so a read issued straight afterwards cannot overtake it. */
export function trackSave(save: Promise<unknown>): void {
  pendingSaves = Promise.allSettled([pendingSaves, save])
}

/**
 * Every call goes through here.
 *
 * Written as one choke point specifically so the identity header cannot be
 * left off a new endpoint by accident — a request without it lands in the
 * anonymous bucket and silently sees none of the caller's runs, which looks
 * like data loss rather than a missing header.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // A read waits for any step save still in flight. Leaving a step sends its
  // last edit as the next step mounts and loads, and without this the load can
  // overtake the save and show the value from before the edit.
  if (!init.method || init.method === 'GET') await pendingSaves

  const headers = new Headers(init.headers)
  headers.set('X-Client-Id', clientId())
  // FormData sets its own multipart boundary; setting Content-Type breaks it.
  if (init.body !== undefined && !(init.body instanceof FormData)
      && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  // Browsers refuse a keepalive request whose body is over 64 KB. Past that,
  // send it normally - it may not survive the page closing, but it is sent.
  const keepalive = !!init.keepalive && typeof init.body === 'string'
    && init.body.length < 60_000
  const res = await fetch(API_BASE + path, { ...init, headers, keepalive })
  if (!res.ok) return parseError(res)
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

async function parseError(res: Response): Promise<never> {
  let detail = `Request failed (${res.status})`
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') detail = body.detail
  } catch {
    /* non-JSON body - keep the generic message */
  }
  // FastAPI answers an unknown PATH with exactly "Not Found", while every
  // handler here returns a sentence. So this specific pairing means the route
  // does not exist on the server that answered - almost always a backend
  // running older code than the page. Saying "Not Found" and stopping there
  // sends people hunting for missing data that is sitting safely in the
  // database.
  if (res.status === 404 && detail === 'Not Found') {
    detail = 'This version of the app asked for something the server does not '
           + 'recognise. The backend is probably running older code — restart '
           + 'it, then reload this page. Nothing has been lost.'
  }
  throw new ApiError(res.status, detail)
}

/** Project details captured in Step 1. Stored with the run so it is
 *  self-contained and resumable from its id alone. */
export interface ProjectFields {
  project_name?: string
  area?: number | string
  stage?: string
  structural_system?: string
  location?: string
  client?: string
}

export async function uploadFile(
  file: File,
  opts: { geminiApiKey?: string; project?: ProjectFields } = {},
): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file)
  if (opts.geminiApiKey) form.append('gemini_api_key', opts.geminiApiKey)

  // Blank fields are omitted rather than sent empty: the server treats a
  // missing value as "not supplied", and an empty string for `area` would fail
  // its float coercion.
  for (const [k, v] of Object.entries(opts.project ?? {})) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      form.append(k, String(v))
    }
  }

  return request('/api/uploads', { method: 'POST', body: form })
}

export async function getStatus(runId: string): Promise<StatusResponse> {
  return request(`/api/runs/${runId}/status`)
}

export async function getElements(runId: string): Promise<ExtractionResponse> {
  return request(`/api/runs/${runId}/elements`)
}

/**
 * Poll until parsing finishes, then fetch the elements.
 *
 * Polling (rather than one long request) exists because IFC parsing takes
 * minutes on a real model - far past any sane HTTP timeout. `onStatus` lets the
 * caller show progress; `signal` allows cancellation when the user navigates
 * away or replaces the file.
 */
export async function waitForExtraction(
  runId: string,
  opts: {
    onStatus?: (s: StatusResponse) => void
    intervalMs?: number
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
): Promise<ExtractionResponse> {
  const { onStatus, intervalMs = 600, timeoutMs = 15 * 60_000, signal } = opts
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const status = await getStatus(runId)
    onStatus?.(status)

    if (status.status === 'failed') {
      throw new ApiError(422, status.error ?? 'Parsing failed.')
    }
    if (status.status === 'parsed') {
      return getElements(runId)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new ApiError(504, 'Timed out waiting for the file to be processed.')
}

/* ── Step 2: Choose Elements ────────────────────────────────────────────── */

/** One row of the Step-2 table: elements sharing category, name and level. */
export interface ElementGroup {
  key: string
  cat: string
  name: string
  material: string
  is_steel: boolean
  level: string
  vol: number
  count: number
  n_elements: number
  mass: number
}

export interface CategoryTotal {
  cat: string
  count: number
  volume_m3: number
  mass_kg: number
}

export interface LevelTotal {
  level: string
  count: number
  volume_m3: number
}

/** What the user has switched OFF. Exclusions, not inclusions, so anything new
 *  appearing after a re-parse defaults to counted rather than silently dropped. */
export interface Selection {
  excluded_categories: string[]
  excluded_levels: string[]
  excluded_groups: string[]
}

export interface GroupsResponse {
  run_id: string
  groups: ElementGroup[]
  categories: CategoryTotal[]
  levels: LevelTotal[]
  selection: Selection
}

export interface PreviewResponse {
  kind: 'ifc' | 'table'
  message?: string
  columns?: string[]
  rows?: string[][]
  truncated?: boolean
}

/** Fetched ONCE. Level is part of each group key, so every subsequent filter
 *  the user applies is computed in the browser with no further requests. */
export async function getGroups(runId: string): Promise<GroupsResponse> {
  return request(`/api/runs/${runId}/groups`)
}

export async function saveSelection(
  runId: string,
  selection: Selection,
  opts: SaveOptions = {},
): Promise<void> {
  await request(`/api/runs/${runId}/selection`,
    { method: 'PUT', body: JSON.stringify(selection), keepalive: opts.keepalive })
}

export async function getPreview(runId: string): Promise<PreviewResponse> {
  return request(`/api/runs/${runId}/preview`)
}

/* ── Step 3: Materials ──────────────────────────────────────────────────── */

/** One catalogue entry offered in a factor dropdown. */
export interface FullFactor {
  e_id: string
  name: string
  group: string
  /** True when the factor ALREADY prices its reinforcement (precast /
   *  prestressed). The rebar and PT inputs must close, or steel is counted
   *  twice. */
  inc_reinf: boolean
  a1a3: number
}

export interface CatalogueResponse {
  catalogue_version: string
  concrete_grades: string[]
  ggbs_options: number[]
  ggbs_max_by_grade: Record<string, number>
  rebar_types: string[]
  section_types: string[]
  pt_types: string[]
  defaults: {
    concrete_grade: string
    ggbs_pct: number
    rebar_type: string
    section_type: string
    pt_type: string
  }
  steel_factors: Record<string, { e_id: string; name: string }[]>
  steel_factor_names: Record<string, string>
  full_factors: FullFactor[]
  transport_defaults: TransportDefault[]
  waste_defaults: Record<string, number>
  a5a: { default: number; min: number; max: number }
}

/** One row of the Materials table: an element type, merged across levels. */
export interface MaterialRow {
  key: string
  cat: string
  name: string
  material: string
  is_steel: boolean
  vol: number
  count: number
  mass: number
  e_id: string
  factor_type: string
  grade: string
  ggbs: number | null
  default_rebar: number
  rebar_hint: string
  pt_applicable: boolean
  allow_full_factor: boolean
  kg_per_m_hint: number
  mass_source: string
}

/** Per-row overrides. Anything omitted inherits the global default. */
export interface MaterialOverride {
  grade?: string
  ggbs?: number
  rebarRate?: number
  ptRate?: number
  steelEid?: string
  fullEid?: string
  concFactorEid?: string
}

export interface EpdOverride {
  a1_a3: number
  source?: string
  mat_type?: string
  grade?: string | null
  ggbs?: number | null
  e_id?: string | null
}

export interface MaterialsState {
  defaults: Record<string, string | number>
  rows: Record<string, MaterialOverride>
  epd_overrides: Record<string, EpdOverride>
}

export interface MaterialsResponse {
  run_id: string
  rows: MaterialRow[]
  materials: MaterialsState
}

/** Reference data for the dropdowns. Depends only on the catalogue CSV, so it
 *  is fetched once and reused for the whole session. */
let _catalogue: Promise<CatalogueResponse> | null = null
export function getCatalogue(): Promise<CatalogueResponse> {
  if (!_catalogue) {
    _catalogue = request<CatalogueResponse>('/api/catalogue')
  }
  return _catalogue
}

export async function getMaterials(runId: string): Promise<MaterialsResponse> {
  return request(`/api/runs/${runId}/materials`)
}

export async function saveMaterials(
  runId: string,
  materials: MaterialsState,
  opts: SaveOptions = {},
): Promise<void> {
  await request(`/api/runs/${runId}/materials`,
    { method: 'PUT', body: JSON.stringify(materials), keepalive: opts.keepalive })
}

/* ── Step 4: Transport & Waste ──────────────────────────────────────────── */

export interface TransportDefault {
  key: string
  label: string
  /** SEAI Table 2 sourcing scenario, e.g. "Imported" - explains the number. */
  scenario: string
  road: number
  sea: number
}

export interface TransportLegs { sea: number; road: number }

export interface TransportState {
  distances: Record<string, TransportLegs>
  /** PERCENT, as typed (5 = 5%). The engine's multiplier and fraction forms are
   *  derived server-side so the conversion lives in one place. */
  waste_pct: Record<string, number>
  /** null = not overridden (SEAI default applies). 0 is a real choice meaning
   *  site activity is deliberately excluded, and must not collapse to null. */
  a5a_factor: number | null
}

export interface TransportResponse {
  run_id: string
  transport: TransportState
}

export async function getTransport(runId: string): Promise<TransportResponse> {
  return request(`/api/runs/${runId}/transport`)
}

export async function saveTransport(
  runId: string,
  transport: TransportState,
  opts: SaveOptions = {},
): Promise<void> {
  await request(`/api/runs/${runId}/transport`,
    { method: 'PUT', body: JSON.stringify(transport), keepalive: opts.keepalive })
}

/* ── Step 5: Data Check (read-only) ─────────────────────────────────────── */

export interface ConcreteFactor {
  label: string
  ggbs: number | null
  e_id: string
  /** null when a supplier EPD replaced it — concrete EPDs are quoted per m³. */
  a1_a3_kg: number | null
  a1_a3_m3: number
  saving_pct: number | null
  source: string
  is_epd: boolean
}

export interface SteelFactor {
  label: string
  bucket: string
  e_id: string
  a1_a3_kg: number
  density: number
  source: string
  is_epd: boolean
}

export interface DataCheckResponse {
  run_id: string
  catalogue_version: string
  stage: {
    label: string; badge: string; code: string; description: string
    expectations: string[]; uncertainty_pct: number; epd_expected: boolean
  }
  concrete: ConcreteFactor[]
  steel: SteelFactor[]
  epd_overrides: { key: string; a1_a3: number; source: string; mat_type: string }[]
  a5a: {
    factor: number; default: number; is_override: boolean
    area: number; total_tonnes: number | null
  }
  transport: {
    key: string; label: string; scenario: string
    road: number; sea: number; is_override: boolean
  }[]
  waste: { material: string; pct: number; multiplier: number; is_override: boolean }[]
  coverage: { total: number; with_epd: number; pct: number }
}

export async function getDataCheck(runId: string): Promise<DataCheckResponse> {
  return request(`/api/runs/${runId}/data-check`)
}

/* ── Step 6: Results dashboard ──────────────────────────────────────────── */

export interface BreakdownRow {
  key: string
  rows: number
  mass_kg: number
  a1_a3: number
  a4: number
  a5: number
  total_kg: number
  total_ton: number
  sequestration: number
}

export interface ResultRow {
  idx: number
  e_id: string
  material: string
  category: string
  description: string
  family: string
  ifc_type: string
  level: string
  count: number
  mass: number
  volume: number
  a1_a3: number
  a4: number
  a5: number
  total_kg: number
  sequestration: number
}

export interface ScorsBand {
  rating: string
  low: number
  high: number | null
  color: string
  color_end: string
}

export interface SensitivityScenario {
  delta: number
  n_rows: number
  note?: string
  member?: string
  reduction_pct?: number
}

/** One row of a per-floor or per-zone intensity table. */
export interface IntensityRow {
  label: string
  ton: number
  kg_per_m2_gia: number
  share_pct: number
}

/**
 * Derived analysis the raw breakdowns cannot give you.
 *
 * Computed server-side at calculation time by the same function the legacy
 * HTML dashboard uses, so the two surfaces cannot drift. Every field is
 * optional-by-absence: a run calculated before this existed simply omits it,
 * and each panel hides itself rather than rendering zeros.
 */
export interface Insights {
  /** Office / Core / Basement, tagged from element names and categories. */
  zone_intensity?: IntensityRow[]
  /** Per-storey, when the model carries levels. */
  floor_intensity?: IntensityRow[]
  /** Steel kg per m³ of CONCRETE — a reinforcement-density proxy. */
  member_efficiency?: { label: string; steel_kg_per_m3: number
                        steel_mass_t: number; conc_vol: number }[]
  /** kgCO₂e per m³ of CONCRETE — how hard each member type is working. */
  member_intensity?: { label: string; kgco2e_per_m3: number
                       ton: number; conc_vol: number }[]
  /** The slab system on its own, against both GIA and estimated slab area. */
  slab_metrics?: { ton: number; kg_per_m2_gia: number
                   kg_per_m2_slab: number; area_m2_est: number }
  substructure_split?: { sub_ton: number; super_ton: number; sub_pct: number }
  /** Blended realised factors, and what GGBS would move them to. */
  factors?: {
    concrete_baseline: number; steel_baseline: number
    ggbs_50_opt: number; ggbs_70_opt: number
    ggbs_50_reduction_pct: number; ggbs_70_reduction_pct: number
  }
  material_mass_by_type?: Record<string, number>
  /** Share of MASS covered by a supplier EPD, not share of factor count. */
  epd_coverage_pct?: number
  stage_uncertainty_pct?: number
  sequestration_ton?: number
}

export interface DashboardResponse {
  run_id: string
  filename: string
  source_type: 'ifc' | 'csv' | null
  project: Record<string, unknown>

  total_ton: number
  per_sqm: number
  per_sqm_range: number[]
  rating: string
  rating_row_index: number
  stage_emissions: Record<string, number>
  sequestration_ton: number
  a5a_factor: number
  a5a_ton: number
  uncertainty_pct: number
  catalogue_version: string
  calculated_at: string
  stage_label: string
  stage_badge: string

  material_types: string[]
  material_emissions: number[]
  breakdown: {
    material: BreakdownRow[]
    category: BreakdownRow[]
    level: BreakdownRow[]
  }
  hotspots: {
    description: string; category: string; material: string
    mass: number; total_kg: number; total_ton: number
  }[]
  substructure: {
    substructure: number; superstructure: number
    total: number; substructure_pct: number
  }
  member_efficiency: {
    key: string; total_ton: number; per_sqm: number
    mass_kg: number; intensity: number
  }[]
  social_cost: { price_per_ton: number; currency: string; cost: number }
  budget: {
    target: number; actual: number; headroom: number; within: boolean
    pct_of_target: number; delta_ton: number | null
    bar_pct: number; color: string
  }
  benchmark: {
    benchmark: number; actual: number; diff_pct: number; better: boolean
  }
  scors_bands: ScorsBand[]
  /** Transport and waste AS APPLIED — same source as the Data Check screen, so
   *  the pre-run review and the report cannot disagree. */
  transport: {
    key: string; label: string; scenario: string
    road: number; sea: number; is_override: boolean
  }[]
  waste: { material: string; pct: number; multiplier: number; is_override: boolean }[]

  sensitivity: Record<string, SensitivityScenario>
  sensitivity_status: 'pending' | 'ready' | 'failed'
  decarbonisation: DecarbData
  no_factor: { count: number; volume_m3: number; categories: string[] }
  /** Empty for runs calculated before insights existed. */
  insights: Insights
  /** What this design stage should foreground, and what it should retire.
   *  Server-side so the list cannot drift from the stage contract. */
  stage_focus?: { stage: string; show: string[]; hide: string[] }
  /** The constants behind every figure, read from calculations.py. Served
   *  rather than restated in the view so the methodology note and the
   *  arithmetic cannot disagree. */
  methodology?: {
    standard: string
    a5a: {
      factor: number; whole_building: number
      structural_share_pct: number; distribution: string
    }
    transport: {
      road_outward: number; road_return: number; sea: number; note: string
    }
    densities: { concrete: number; steel: number }
    social_cost_per_ton: number
  }
  concrete_specs_used: {
    element: string; grade: string; ggbs_pct: number; a1_a3: number
  }[]
  emission_factors_used: {
    material: string; name: string; e_id: string; a1_a3: number
    density: number; data_type: string; is_custom: boolean
  }[]
  rebar_rates_used: { element: string; rate_kg_m3: number }[]
  reports: {
    files: Record<string, { kind: string; label: string; ext: string
                            filename: string; size: number
                            generated_at?: string }>
    status: string
    error: string | null
  }
}

/** One element in the 3D viewer. `v`/`t` are flat vertex and triangle-index
 *  arrays when the model supplied real geometry; otherwise the viewer draws a
 *  box from w/d/h, matching the legacy fallback. */
export interface GeometryElement {
  x: number; y: number; z: number
  w: number; d: number; h: number
  cat: string
  name: string
  level: string
  total: number
  a1_a3_t: number
  a1_a3_kg: number
  per_m3: number
  per_m3_a1a3: number
  v?: number[]
  t?: number[]
}

export interface GeometryResponse {
  run_id: string
  elements: GeometryElement[]
  has_meshes: boolean
  count?: number
  note?: string
}

/** One decarbonisation lever. `open` is whether it is still available at this
 *  design stage; `is_estimate` marks the structural-system row, which has no
 *  engine scenario behind it. */
export interface DecarbScenario {
  key: string; label: string; note: string; family: string
  available: boolean; is_estimate?: boolean
  open: boolean; locked_reason: string | null
  delta_ton: number; delta_per_sqm: number; delta_pct: number
  n_rows: number; engine_note: string
}

export interface DecarbData {
  stage: string
  headline: string
  lead: string
  scenarios: DecarbScenario[]
  actions: DecarbScenario[]
  combined_ton: number
  combined_per_sqm: number
  combined_pct: number
  epd_opportunity: {
    delta_ton: number; delta_per_sqm: number; basis: string
  } | null
  benchmarks: {
    gia: number; note: string
    // `system` is null on the current run when the structural system was not
    // given at upload — the row's own "This run" marker names it instead.
    rows: { system: string | null; per_sqm: number; cost: number | null
            is_current: boolean; vs_best_pct: number }[]
  }
  hotspots: { category: string; total_ton: number; pct: number; target: string }[]
  case_study_gia: number
}

export async function getDashboard(runId: string): Promise<DashboardResponse> {
  return request(`/api/runs/${runId}/dashboard`)
}

/** Fetched separately from the dashboard: on a real model this can be tens of
 *  megabytes, and the charts should not wait for it. */
export async function getGeometry(runId: string): Promise<GeometryResponse> {
  return request(`/api/runs/${runId}/geometry`)
}

export async function getResultRows(
  runId: string, opts: { limit?: number; offset?: number } = {},
): Promise<{ rows: ResultRow[]; total: number }> {
  const q = new URLSearchParams()
  if (opts.limit) q.set('limit', String(opts.limit))
  if (opts.offset) q.set('offset', String(opts.offset))
  return request(`/api/runs/${runId}/results/rows?${q}`)
}

export async function startCalculation(
  runId: string, sensitivity = true,
): Promise<void> {
  await request(`/api/runs/${runId}/calculate?sensitivity=${sensitivity}`, { method: 'POST' })
}

export async function requestReports(
  runId: string, kinds: string[],
): Promise<void> {
  const q = kinds.map((k) => `kinds=${encodeURIComponent(k)}`).join('&')
  await request(`/api/runs/${runId}/reports?${q}`, { method: 'POST' })
}

export async function getReports(runId: string): Promise<
  DashboardResponse['reports'] & {
    available: { kind: string; label: string }[]
    /** The kinds the current (or last) generation was asked for. */
    requested?: string[]
  }
> {
  return request(`/api/runs/${runId}/reports`)
}

/**
 * Fetch a generated report and hand it to the browser as a file download.
 *
 * Not a plain <a href>: a link cannot send X-Client-Id, and runs are owned, so
 * the server would answer 404. The filename comes from the manifest because a
 * cross-origin response does not expose Content-Disposition to the page.
 */
export async function downloadReport(
  runId: string, kind: string, filename: string,
): Promise<void> {
  await pendingSaves
  const res = await fetch(`${API_BASE}/api/runs/${runId}/reports/${kind}/download`,
    { headers: { 'X-Client-Id': clientId() } })
  if (!res.ok) return parseError(res)
  const url = URL.createObjectURL(await res.blob())
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Revoked later, not now: revoking straight away can cancel the download in
    // some browsers before they have started reading the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}


/* ── Resume: progress, listing, deletion ────────────────────────────────── */

/** How far a run got. One number: the high-water mark.
 *
 *  The CURRENT step is not stored — the URL carries it, and both ways back into
 *  a run resume to the furthest step anyway. */
export interface ProgressState {
  run_id: string
  max_step: number
}

export async function getProgress(runId: string): Promise<ProgressState> {
  return request(`/api/runs/${runId}/progress`)
}

/** Raise the high-water mark. Call only when opening a step for the first
 *  time — re-sending one already reached is a request that changes nothing. */
export async function saveProgress(
  runId: string, step: number,
): Promise<ProgressState> {
  return request(`/api/runs/${runId}/progress`,
                 { method: 'PUT', body: JSON.stringify({ step }) })
}

/** One row of "your projects". A summary per run — the element rows behind them
 *  are what make a run heavy, and this endpoint returns every run you own. */
export interface RunListing {
  run_id: string
  name: string
  filename: string
  ext: string
  status: RunStatus
  error: string | null
  n_elements: number
  area: number | null
  stage: string | null
  total_ton: number | null
  per_sqm: number | null
  rating: string | null
  max_step: number
  created_at: string | null
  updated_at: string | null
}

export async function listRuns(limit = 50): Promise<RunListing[]> {
  const d = await request<{ runs: RunListing[] }>(`/api/runs?limit=${limit}`)
  return d.runs
}

export async function deleteRun(runId: string): Promise<void> {
  await request(`/api/runs/${runId}`, { method: 'DELETE' })
}
