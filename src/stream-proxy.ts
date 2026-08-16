/**
 * 实时语音识别 V2 (WebSocket) proxy: bridges one browser WebSocket to the
 * Tencent streaming uplink. The browser half speaks a minimal protocol —
 * binary frames are raw PCM, the text frame {"type":"end"} ends the session —
 * and receives simplified JSON result frames; this module owns the Tencent
 * wire protocol (signed URL, voice_id correlation, final-frame handshake).
 * @module @deepseek-ai/dsh-host-stt-tencent
 */

import { randomInt, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import {
  buildStreamEndFrame,
  buildStreamUrl,
  parseStreamFrame,
  TencentAsrError,
} from './tencent-asr.ts'

/** Credentials and engine selection for one proxy instance (per-request resolve). */
export interface StreamProxyCredentials {
  appId: string
  secretId: string
  secretKey: string
  engineModelType: string
}

/** Signed-URL lifetime for one stream session. */
const URL_TTL_SECONDS = 3600
/** How long the browser may wait for the final frame after its end signal. */
const FINAL_FRAME_TIMEOUT_MS = 15_000

/** One relayed result frame (the browser-facing protocol). */
export interface RelayFrame {
  type: 'result' | 'error'
  /** Recognized text of the slice (interim or settled). */
  text: string
  /** Session final (the last frame of this stream). */
  final: boolean
  /** 0 interim slice, 2 settled sentence, -1 session final / no result. */
  sliceType: number
  code?: string
  message?: string
}

/** Owns the noServer WebSocketServer and per-connection bridging. */
export class StreamProxy {
  private readonly server = new WebSocketServer({ noServer: true })

  /**
   * @param resolveCredentials - per-connection async credential resolve;
   * returning null rejects the session (missing appId/secrets) without
   * touching Tencent.
   */
  constructor(
    private readonly resolveCredentials: () => Promise<StreamProxyCredentials | null>,
  ) {}

  /** The webserver upgrade-route handler for `/stt/stream`. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, (browser) => {
      void this.bridge(browser)
    })
  }

  /** Terminate every live session (plugin teardown). */
  close(): void {
    for (const socket of this.server.clients) socket.terminate()
    void this.server.close()
  }

  private async bridge(browser: WebSocket): Promise<void> {
    const credentials = await this.resolveCredentials()
    if (credentials === null) {
      browser.close(1011, 'stt stream unavailable: credentials or appId missing')
      return
    }
    const now = Math.floor(Date.now() / 1000)
    const voiceId = randomUUID()
    const url = buildStreamUrl({
      appId: credentials.appId,
      secretId: credentials.secretId,
      engineModelType: credentials.engineModelType,
      expired: now + URL_TTL_SECONDS,
      nonce: randomInt(1000, 99_999),
      timestamp: now,
      voiceFormat: 1,
      voiceId,
      needvad: 1,
    }, credentials.secretKey)

    let upstream: WebSocket
    try {
      upstream = new WebSocket(url)
    } catch (error) {
      this.send(browser, {
        type: 'error', text: '', final: false, sliceType: -1,
        code: 'upstream-connect', message: String(error),
      })
      browser.close(1011, 'upstream connect failed')
      return
    }

    let finalized = false
    let ended = false
    let tornDown = false
    // The browser can start streaming before the upstream handshake settles;
    // ws' send() throws while CONNECTING (it does not queue like the browser
    // WebSocket), so frames arriving early buffer here and flush on open.
    let upstreamOpen = false
    const pendingFrames: { data: Buffer; isBinary: boolean }[] = []
    const teardown = (): void => {
      if (tornDown) return
      tornDown = true
      try { browser.close() } catch { /* already closed */ }
      try { upstream.close() } catch { /* already closed */ }
    }
    const relay = (frame: RelayFrame): void => {
      this.send(browser, frame)
      if (frame.type === 'result' && frame.final) finalized = true
    }
    const handleControl = (text: string): void => {
      try {
        const control = JSON.parse(text) as { type?: unknown }
        if (control.type === 'end') {
          ended = true
          if (!finalized) upstream.send(buildStreamEndFrame())
          // The final frame (or the upstream close) completes the session; a
          // stuck uplink must not hold the browser's end signal forever.
          setTimeout(() => {
            if (!finalized) {
              relay({
                type: 'error', text: '', final: false, sliceType: -1,
                code: 'final-timeout', message: 'no final frame from the uplink',
              })
              teardown()
            }
          }, FINAL_FRAME_TIMEOUT_MS)
        }
      } catch {
        // Malformed control frames are dropped: PCM is binary, controls are ours.
      }
    }

    upstream.on('open', () => {
      upstreamOpen = true
      for (const pending of pendingFrames) {
        if (pending.isBinary) upstream.send(pending.data)
        else handleControl(pending.data.toString())
      }
      pendingFrames.length = 0
    })
    upstream.on('message', (data) => {
      if (finalized) return
      const raw = data.toString()
      try {
        const frame = parseStreamFrame(raw)
        // Handshake/ack frames (no result, no text) relay nothing.
        if (frame.text === '' && !frame.final && frame.sliceType === -1) return
        relay({ type: 'result', text: frame.text, final: frame.final, sliceType: frame.sliceType })
      } catch (error) {
        relay({
          type: 'error', text: '', final: false, sliceType: -1,
          code: error instanceof TencentAsrError ? error.code : 'internal',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })
    upstream.on('error', (error) => {
      relay({
        type: 'error', text: '', final: false, sliceType: -1,
        code: 'upstream', message: String(error),
      })
      teardown()
    })
    upstream.on('close', () => teardown())

    browser.on('message', (data, isBinary) => {
      if (tornDown || ended) return
      if (!upstreamOpen) {
        pendingFrames.push({ data: data as Buffer, isBinary })
        return
      }
      if (isBinary) {
        upstream.send(data as Buffer)
        return
      }
      handleControl(data.toString())
    })
    browser.on('close', () => teardown())
    browser.on('error', () => teardown())
  }

  private send(socket: WebSocket, frame: RelayFrame): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(frame))
  }
}
