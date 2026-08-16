/**
 * One voice session: capability probe, engine choice, recording, and
 * transcript delivery. The seat component stays thin — start, preview
 * callbacks, stop — while the engine differences (streaming flash vs
 * one-shot sentence) live here.
 *
 * flash: the host's /stt/stream WebSocket relays PCM to Tencent 实时识别 V2;
 * interim frames stream into onPreview, the final frame settles onResult.
 * sentence: the 3s interim loop previews and the whole recording recognizes
 * on stop. A flash session that fails mid-flight falls back to the sentence
 * path for its committed transcript — the recording keeps accumulating either
 * way, so the user never loses what they said.
 */

import { recognizePcm } from './stt-client.ts'
import { startRecording } from './recorder.ts'

/** What the seat needs to hear from a session. */
export interface VoiceSessionCallbacks {
  /** Live transcript preview while recording (may update continuously). */
  onPreview: (text: string) => void
  /** The committed transcript (delivered once, on stop). */
  onResult: (text: string) => void
  /** A user-visible failure (permission, upstream, transport). */
  onError: (message: string) => void
}

/** A live voice session the seat stops or discards. */
export interface VoiceSession {
  /** Stop recording and deliver the committed transcript (onResult). */
  stop(): Promise<void>
  /** Stop recording and discard the audio (unmount path). */
  cancel(): void
}

/** The engine the host advertises. */
export type EngineMode = 'flash' | 'sentence'

interface Capabilities {
  engine: EngineMode
  streamPath: string
  sentencePath: string
}

const CAPABILITIES_URL = '/stt/capabilities'
/** Interim preview cadence for the sentence engine. */
const PREVIEW_INTERVAL_MS = 3_000
/** How long stop() waits for the stream's final frame before falling back. */
const FINAL_WAIT_MS = 10_000

let cachedCapabilities: Capabilities | null = null

async function fetchCapabilities(): Promise<Capabilities | null> {
  if (cachedCapabilities !== null) return cachedCapabilities
  try {
    const response = await fetch(CAPABILITIES_URL)
    if (!response.ok) return null
    const body = await response.json() as Partial<Capabilities>
    if (body.engine !== 'flash' && body.engine !== 'sentence') return null
    const capabilities: Capabilities = {
      engine: body.engine,
      streamPath: typeof body.streamPath === 'string' ? body.streamPath : '/stt/stream',
      sentencePath: typeof body.sentencePath === 'string' ? body.sentencePath : '/stt/recognize',
    }
    cachedCapabilities = capabilities
    return capabilities
  } catch {
    return null
  }
}

/**
 * Begin one voice session: probe the host, pick the engine, and start the mic.
 * @param callbacks - the seat's preview/result/error sinks.
 * @returns the live session.
 * @throws the recorder's start errors (unsupported / NotAllowedError).
 */
export async function startVoiceSession(callbacks: VoiceSessionCallbacks): Promise<VoiceSession> {
  const capabilities = await fetchCapabilities()
  const mode: EngineMode = capabilities?.engine === 'flash' ? 'flash' : 'sentence'

  // Streaming session state (flash only). The WebSocket opens while recording
  // starts; a failure marks the session as fallback — the recording continues
  // and stop() uses the sentence path.
  let socket: WebSocket | null = null
  let streamFailed = false
  const sentences: string[] = []
  let interim = ''
  let finalText: string | null = null
  let settled = false
  let finalWaiters: (() => void)[] = []

  const handleStreamFrame = (raw: string): void => {
    let frame: { type?: unknown; text?: unknown; final?: unknown; sliceType?: unknown; message?: unknown }
    try {
      frame = JSON.parse(raw) as typeof frame
    } catch {
      return
    }
    if (frame.type === 'error') {
      streamFailed = true
      return
    }
    if (frame.type !== 'result') return
    const text = typeof frame.text === 'string' ? frame.text : ''
    const sliceType = typeof frame.sliceType === 'number' ? frame.sliceType : -1
    if (frame.final === true) {
      finalText = sentences.join('') + text
      settled = true
      for (const waiter of finalWaiters) waiter()
      finalWaiters = []
      return
    }
    if (sliceType === 2) {
      sentences.push(text)
      interim = ''
    } else if (text !== '') {
      interim = text
    }
    callbacks.onPreview(sentences.join('') + interim)
  }

  const openStream = (streamPath: string): void => {
    try {
      socket = new WebSocket(streamPath)
    } catch {
      streamFailed = true
      return
    }
    socket.onmessage = (event) => { handleStreamFrame(String(event.data)) }
    socket.onerror = () => { streamFailed = true }
    socket.onclose = () => {
      // A close without a final frame while still recording is a failure;
      // after stop() the fallback path owns the outcome.
      if (!settled && !stopping) streamFailed = true
      else if (!settled) {
        for (const waiter of finalWaiters) waiter()
        finalWaiters = []
      }
    }
  }
  let stopping = false

  const handle = await startRecording(
    mode === 'flash'
      ? {
        onFrame: (frame) => {
          if (socket !== null && socket.readyState === WebSocket.OPEN && !streamFailed) {
            // A plain copy so the send owns an ArrayBuffer (the capture
            // buffer may be shared with the resampler).
            const payload = new Uint8Array(frame.byteLength)
            payload.set(frame)
            socket.send(payload.buffer)
          }
        },
      }
      : {},
  )

  if (mode === 'flash' && capabilities !== null) openStream(capabilities.streamPath)

  // Sentence-mode interim preview: recognize the captured audio every few
  // seconds (a fresh whole-recording read, so the preview is always the
  // transcript of everything said so far).
  let previewTimer: number | null = null
  let previewInFlight = false
  let previewSeq = 0
  const runPreview = async (): Promise<void> => {
    if (previewInFlight) return
    previewInFlight = true
    const seq = ++previewSeq
    const outcome = await recognizePcm(handle.snapshot().pcm)
    previewInFlight = false
    if (seq !== previewSeq) return // a newer preview superseded this one
    if (outcome.ok && outcome.text.trim() !== '') callbacks.onPreview(outcome.text)
  }
  if (mode === 'sentence') {
    previewTimer = window.setInterval(() => { void runPreview() }, PREVIEW_INTERVAL_MS)
  }

  let ended = false
  const stop = async (): Promise<void> => {
    if (ended) return
    ended = true
    stopping = true
    if (previewTimer !== null) window.clearInterval(previewTimer)
    previewSeq += 1 // invalidate any in-flight interim preview

    const pcm = (await handle.stop()).pcm

    // Flash path: ask the uplink to settle, wait briefly for the final frame.
    if (mode === 'flash' && socket !== null && !streamFailed && socket.readyState === WebSocket.OPEN) {
      const finalPromise = new Promise<void>((resolve) => {
        if (settled) {
          resolve()
          return
        }
        finalWaiters.push(resolve)
        window.setTimeout(() => {
          const index = finalWaiters.indexOf(resolve)
          if (index >= 0) finalWaiters.splice(index, 1)
          resolve()
        }, FINAL_WAIT_MS)
      })
      socket.send(JSON.stringify({ type: 'end' }))
      await finalPromise
      try { socket.close() } catch { /* already closed */ }
      if (finalText !== null && finalText.trim() !== '') {
        callbacks.onResult(finalText)
        return
      }
    }

    // Sentence path (mode or fallback): recognize the whole recording.
    const outcome = await recognizePcm(pcm)
    if (outcome.ok) {
      if (outcome.text.trim() !== '') callbacks.onResult(outcome.text)
      else callbacks.onError(EMPTY_SPEECH)
    } else {
      callbacks.onError(outcome.error.message)
    }
  }

  const cancel = (): void => {
    if (ended) return
    ended = true
    stopping = true
    if (previewTimer !== null) window.clearInterval(previewTimer)
    try { socket?.close() } catch { /* already closed */ }
    handle.cancel()
  }

  return { stop, cancel }
}

/** The empty-transcript failure the seat localizes. */
export const EMPTY_SPEECH = 'no-speech'
