/**
 * The voice-input controls, mounted purely through dsh's public slots:
 * - `VoiceToolRowButton` — the mic on the `conversation.input.left`
 *   tool-row slot: records the default microphone, recognizes through the
 *   host STT proxy (Tencent Cloud ASR — streaming real-time or one-shot),
 *   and appends the committed transcript via the public input actions.
 *   While recording, a live preview of what the microphone heard appears
 *   above the button; stopping the session commits the full transcript.
 * - `VoiceConfigCard` — the engine/AppId card on the `settings.plugin.item`
 *   slot inside Settings → Plugins → 插件配置, reading and writing the host
 *   plugin's own `/stt/config` route (no settings whitelist involved).
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (input.left) and the
// ui-settings-plugins SlotMap merge (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { VoiceInputInjected } from './index.ts'
import { EMPTY_SPEECH, startVoiceSession, type VoiceSession } from './voice-session.ts'
import { fetchConfig, saveConfig } from './stt-client.ts'
import css from './VoiceInputButton.module.css'

/** The tool-row mic's full props (official `conversation.input.left` slot). */
export type VoiceToolRowProps =
  PropsRuntime<'conversation.input.left'> & InjectFace<VoiceInputInjected> & PropsLocale<'voice.input'>

/** The settings card's full props (official `settings.plugin.item` slot). */
export type VoiceConfigCardProps =
  PropsRuntime<'settings.plugin.item'> & InjectFace<VoiceInputInjected> & PropsLocale<'voice.input'>

type Phase = 'idle' | 'recording' | 'recognizing'

/** Mic glyph (16px, currentColor) — the icon set has no mic, so it lives here. */
function MicGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="currentColor">
      <path d="M8 1.75A2.25 2.25 0 0 0 5.75 4v4a2.25 2.25 0 0 0 4.5 0V4A2.25 2.25 0 0 0 8 1.75Z" />
      <path d="M3.75 7.75a.75.75 0 0 1 1.5 0 2.75 2.75 0 0 0 5.5 0 .75.75 0 0 1 1.5 0 4.25 4.25 0 0 1-3.5 4.18v1.32h1.75a.75.75 0 0 1 0 1.5H5.5a.75.75 0 0 1 0-1.5h1.75v-1.32a4.25 4.25 0 0 1-3.5-4.18Z" />
    </svg>
  )
}

/**
 * The tool-row mic core: mic button, live preview bubble, and error bubble.
 */
export function VoiceToolRowButton({ session, input, useInput, inputActions, t }: VoiceToolRowProps) {
  const inputState = useInput(s => s)
  const machineBusy = inputState?.phase === 'adjudicating' || inputState?.phase === 'submitting'
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const sessionRef = useRef<VoiceSession | null>(null)
  const capTimerRef = useRef<number | null>(null)
  const [supported] = useState(
    () => typeof (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices?.getUserMedia === 'function',
  )
  const draft = input?.draft ?? ''

  // A mount unmount mid-recording must not leave the mic hot.
  useEffect(() => () => {
    if (capTimerRef.current !== null) window.clearTimeout(capTimerRef.current)
    sessionRef.current?.cancel()
  }, [])

  const finishRecording = async (): Promise<void> => {
    const session = sessionRef.current
    if (session === null) return
    sessionRef.current = null
    if (capTimerRef.current !== null) {
      window.clearTimeout(capTimerRef.current)
      capTimerRef.current = null
    }
    setPhase('recognizing')
    await session.stop()
    setPreview(null)
    setPhase('idle')
  }

  const toggle = (): void => {
    if (phase === 'recording') {
      void finishRecording()
      return
    }
    if (phase !== 'idle') return
    setError(null)
    setPreview(null)
    void startVoiceSession({
      onPreview: setPreview,
      onResult: (text) => {
        if (text === '' || inputActions === undefined) return
        inputActions.setDraft(draft + text)
      },
      onError: (message) => {
        setError(message === EMPTY_SPEECH ? t('noSpeech') : t('failed', { reason: message }))
      },
    })
      .then((session) => {
        sessionRef.current = session
        setPhase('recording')
        // Hard cap: the capture stops itself at 60s; end the session with it.
        capTimerRef.current = window.setTimeout(() => { void finishRecording() }, 60_000)
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'NotAllowedError') setError(t('denied'))
        else if (reason instanceof Error && reason.message === 'unsupported') setError(t('unsupported'))
        else setError(reason instanceof Error ? reason.message : String(reason))
      })
  }

  if (!supported) return null
  const locked = session.removed || machineBusy
  const label = phase === 'recording' ? t('listening') : phase === 'recognizing' ? t('recognizing') : t('mic')
  return (
    <div className={css.seat}>
      {preview !== null && phase === 'recording' && (
        <div className={css.preview} role="status" aria-live="polite" data-voice-preview>{preview}</div>
      )}
      {error !== null && (
        <span role="status" className={css.error} data-voice-error>{error}</span>
      )}
      <Tooltip label={label} side="top" delayMs={500}>
        <button
          type="button"
          className={clsx(css.mic, phase === 'recording' && css.micActive, phase === 'recognizing' && css.micBusy)}
          data-voice-input
          aria-label={label}
          aria-pressed={phase === 'recording'}
          disabled={locked}
          // Button presses steal focus from the textarea; suppress at mousedown
          // so typing continues seamlessly (same convention as the composer's
          // own controls).
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={toggle}
        >
          <MicGlyph />
        </button>
      </Tooltip>
    </div>
  )
}

/** The settings card's load/save state. */
interface CardState {
  engine: 'flash' | 'sentence'
  appId: string
  loading: boolean
  saving: boolean
  error: string | null
  saved: boolean
}

/**
 * The engine/AppId card on Settings → Plugins → 插件配置. Reads and writes
 * the host plugin's own `/stt/config` route — a plugin-owned surface, so the
 * card works without any settings-namespace whitelist in the core apiproxy.
 */
export function VoiceConfigCard({ t }: VoiceConfigCardProps) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<CardState>({
    engine: 'flash', appId: '', loading: false, saving: false, error: null, saved: false,
  })

  // Load the current engine/appId once on mount.
  useEffect(() => {
    let cancelled = false
    setState(current => ({ ...current, loading: true }))
    void fetchConfig().then((result) => {
      if (cancelled) return
      setState(current => ({
        ...current,
        loading: false,
        ...(result.ok
          ? { engine: result.engine, appId: result.appId }
          : { error: result.error.message }),
      }))
    })
    return () => { cancelled = true }
  }, [])

  const save = (): void => {
    setState(current => ({ ...current, saving: true, error: null, saved: false }))
    void saveConfig(state.engine, state.appId).then((result) => {
      setState(current => ({
        ...current,
        saving: false,
        ...(result.ok
          ? { engine: result.engine, appId: result.appId, saved: true }
          : { error: result.error.message }),
      }))
    })
  }

  const disabled = state.loading || state.saving
  return (
    <div className={css.card} data-voice-config-card>
      <button
        type="button"
        className={css.cardHeader}
        aria-expanded={open}
        aria-label={`${t(open ? 'configCollapse' : 'configExpand')}: ${t('configTitle')}`}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className={css.cardHeadText}>
          <span className={css.cardName}>{t('configTitle')}</span>
          <span className={css.cardDescription}>{t('configDescription')}</span>
        </span>
        <svg
          className={open ? css.cardChevronOpen : css.cardChevron}
          viewBox="0 0 14 14"
          width="14"
          height="14"
          aria-hidden
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3.5 5.5 7 9l3.5-3.5" />
        </svg>
      </button>
      {open && (
        <div className={css.cardBody}>
          <label className={css.cardField}>
            <span className={css.cardLabel}>{t('configEngine')}</span>
            <select
              className={css.cardSelect}
              value={state.engine}
              disabled={disabled}
              onChange={(event) => {
                const value = event.target.value
                setState(current => ({ ...current, engine: value === 'sentence' ? 'sentence' : 'flash' }))
              }}
            >
              <option value="flash">{t('configEngineFlash')}</option>
              <option value="sentence">{t('configEngineSentence')}</option>
            </select>
          </label>
          <label className={css.cardField}>
            <span className={css.cardLabel}>{t('configAppId')}</span>
            <input
              className={css.cardInput}
              type="text"
              inputMode="numeric"
              placeholder="1257133316"
              value={state.appId}
              disabled={disabled}
              onChange={(event) => {
                setState(current => ({ ...current, appId: event.target.value, saved: false }))
              }}
            />
          </label>
          <div className={css.cardFooter}>
            <span className={css.cardStatus} data-voice-config-status>
              {state.loading ? t('configLoading') : state.saving ? t('configSaving') : state.saved ? t('configSaved') : state.error ?? ''}
            </span>
            <button
              type="button"
              className={css.cardSave}
              disabled={disabled}
              onClick={save}
            >
              {t('configSave')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
