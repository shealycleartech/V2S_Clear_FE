/**
 * Autosave for the wizard steps (2 Choose Elements, 3 Materials, 4 Transport).
 *
 * Edits apply on screen at once; the SAVE waits for a short pause so a burst of
 * clicks is one request rather than one per click. What this adds over a plain
 * debounce is that a pending save is never thrown away:
 *
 *   leaving the step       any way at all - Continue, Back, the step rail,
 *                          browser back/forward, "your projects". They all end
 *                          with this step unmounting, so the pending save is
 *                          sent right there instead of cancelled.
 *   closing / refreshing   the last unconfirmed value goes out as a keepalive
 *                          request, which the browser finishes after the page.
 *   Continue / Back        wait for the save to land, and stay put if it failed.
 *   a failed save          shows as an error with Retry, never as silence.
 *
 * Saves are queued, never parallel: each PUT replaces the whole stored value,
 * so two in flight could land out of order and the older one win.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { trackSave, type SaveOptions } from './api'

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface Versioned<T> { value: T; ver: number }

export function useAutoSave<T>(
  value: T,
  save: (value: T, opts?: SaveOptions) => Promise<void>,
  /** False until there is something worth saving - before the step's data has
   *  loaded, before the first edit, or while the form holds an invalid value. */
  enabled: boolean,
  delay = 500,
) {
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [leaving, setLeaving] = useState(false)

  const saveRef = useRef(save)
  saveRef.current = save

  const timer = useRef<number | null>(null)
  const version = useRef(0)
  /** Waiting for the pause to end; not sent yet. */
  const pending = useRef<Versioned<T> | null>(null)
  /** The newest value the server has not confirmed - sent or not. */
  const unconfirmed = useRef<Versioned<T> | null>(null)
  /** The queue of saves; resolves to whether the latest one succeeded. */
  const chain = useRef<Promise<boolean>>(Promise.resolve(true))
  const mounted = useRef(true)

  const send = useCallback((v: Versioned<T>): Promise<boolean> => {
    const done = chain.current
      .then(() => saveRef.current(v.value))
      .then(() => true, () => false)
    chain.current = done
    trackSave(done)
    done.then((ok) => {
      if (v.ver !== version.current) return          // a newer edit supersedes it
      if (ok && unconfirmed.current?.ver === v.ver) unconfirmed.current = null
      if (mounted.current && timer.current === null) setSaveState(ok ? 'saved' : 'error')
    })
    return done
  }, [])

  const sendPending = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const p = pending.current
    pending.current = null
    if (p) send(p)
  }, [send])

  // Schedule a save after each change. Deliberately no cleanup here: cancelling
  // on cleanup is exactly how a pending edit used to get lost on unmount.
  useEffect(() => {
    if (!enabled) return
    const v = { value, ver: ++version.current }
    pending.current = v
    unconfirmed.current = v
    setSaveState('saving')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(sendPending, delay)
  }, [value, enabled, delay, sendPending])

  // Leaving the step: send what is pending rather than dropping it.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      sendPending()
    }
  }, [sendPending])

  // Closing or refreshing the tab: an ordinary request would be cancelled with
  // the page, so the last unconfirmed value goes out as a keepalive instead.
  useEffect(() => {
    const onHide = () => {
      const u = unconfirmed.current
      if (!u) return
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
      pending.current = null
      saveRef.current(u.value, { keepalive: true }).catch(() => {})
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  /** Send anything pending now; resolves to whether everything is saved. */
  const flush = useCallback(async () => {
    sendPending()
    return chain.current
  }, [sendPending])

  const retry = useCallback(() => {
    const u = unconfirmed.current
    if (!u) return
    setSaveState('saving')
    send(u)
  }, [send])

  /** Wrap a navigation so it waits for the save, and stays put if it failed. */
  const leaveWith = useCallback((go: () => void) => async () => {
    setLeaving(true)
    const ok = await flush()
    if (mounted.current) setLeaving(false)
    if (ok) go()
  }, [flush])

  return { saveState, leaving, leaveWith, retry }
}

/** The small status beside a step's heading. */
export function SavePill({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'error') {
    return (
      <span className="save-pill save-error" role="alert">
        Couldn&rsquo;t save
        <button type="button" className="save-retry" onClick={onRetry}>Retry</button>
      </span>
    )
  }
  return (
    <span className={`save-pill save-${state}`}>
      {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : ''}
    </span>
  )
}

/** Shown beside Back / Continue when a save failed - the pill at the top of the
 *  page is easy to miss from down here, and this is where the user is stuck. */
export function SaveFailed({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state !== 'error') return null
  return (
    <div className="alert alert-bad" role="alert">
      <strong>Your latest changes couldn&rsquo;t be saved.</strong>
      <p>
        Check your connection, then{' '}
        <button type="button" className="mini" onClick={onRetry}>Retry</button>
      </p>
    </div>
  )
}
