/**
 * Tencent Cloud ASR (一句话识别) proxy for the web GUI voice input.
 *
 * Registers the same-origin `POST /stt/recognize` route on the host
 * webserver. The browser half (ui-voice-input) records 16k mono PCM and posts
 * it here as JSON; this plugin holds the cloud secrets host-side — the keys
 * never cross into the browser — and forwards the audio to Tencent's
 * SentenceRecognition action, returning the recognized text.
 *
 * Credentials resolve per request: literal config values first, then the
 * `credentials` seam (stored/rotated without a restart), then the launch
 * environment (`TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`, the
 * Tencent SDK convention; the bare `TENCENT_*` spellings fall back behind
 * them).
 * @module @deepseek-ai/dsh-host-stt-tencent
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the `webServer` Context merge for the route registration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  recognizeSentence,
  type VoiceFormat,
} from './tencent-asr.ts'
import { StreamProxy } from './stream-proxy.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'stt-tencent'
/** Service required before the route can register. */
export const inject = ['webServer', 'settings']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Tencent Cloud SecretId; prefer {@link secretIdEnv} so no secret enters configuration files. */
  secretId?: string
  /** Literal Tencent Cloud SecretKey; prefer {@link secretKeyEnv}. */
  secretKey?: string
  /** Credential reference resolved for the SecretId; defaults to the Tencent SDK convention `TENCENTCLOUD_SECRET_ID`. */
  secretIdEnv: string
  /** Credential reference resolved for the SecretKey; defaults to `TENCENTCLOUD_SECRET_KEY`. */
  secretKeyEnv: string
  /** Tencent Cloud AppId (实时识别 V2 URL 里的账号标识;一句话识别不需要). */
  appId?: string
  /**
   * Recognition engine the browser half uses:
   * - `flash`: 实时语音识别 V2 (WebSocket 流式, 按音频时长计费 — 边说边出).
   * - `sentence`: 一句话识别 (同步, 按次计费).
   * `flash` without an appId falls back to `sentence`.
   */
  engine: 'flash' | 'sentence'
  /** Cloud region serving the recognition requests (X-TC-Region). */
  region: string
  /** Recognition engine model; `16k_zh` covers 普通话 16k audio. */
  engineModelType: string
  /** Abort the upstream Tencent call after this many milliseconds. */
  timeoutMs: number
  /** Largest accepted PCM payload, in bytes (60s of 16k mono 16-bit ≈ 1.92 MB). */
  maxAudioBytes: number
}

export const Config: z<Config> = z.object({
  secretId: z.string().role('secret'),
  secretKey: z.string().role('secret'),
  secretIdEnv: z.string().role('credential-ref').default('TENCENTCLOUD_SECRET_ID'),
  secretKeyEnv: z.string().role('credential-ref').default('TENCENTCLOUD_SECRET_KEY'),
  appId: z.string().role('credential-ref'),
  engine: z.union([z.const('flash'), z.const('sentence')]).default('flash'),
  region: z.string().default('ap-guangzhou'),
  engineModelType: z.string().default('16k_zh'),
  timeoutMs: z.number().step(1).min(1000).default(15_000),
  maxAudioBytes: z.number().step(1).min(1024).default(2_000_000),
})

/** Settings namespace carrying this plugin's editable section. */
export const STT_TENCENT_SETTINGS_NAMESPACE = settingsNamespace('stt-tencent')

/** Route path the browser half posts recorded audio to. */
export const RECOGNIZE_ROUTE = '/stt/recognize'
/** Route path the browser half connects the streaming uplink to. */
export const STREAM_ROUTE = '/stt/stream'
/** Route path the browser half probes for the active engine. */
export const CAPABILITIES_ROUTE = '/stt/capabilities'
/** Route path the browser half reads/writes engine + appId through. */
export const CONFIG_ROUTE = '/stt/config'

/** JSON body cap: base64 of maxAudioBytes plus envelope slack. */
const MAX_BODY_BYTES = 3_500_000

/** Resolve the effective credentials for one request (config literal → credentials seam → launch environment). */
async function resolveCredentials(
  ctx: Context,
  config: Config,
): Promise<{ secretId: string; secretKey: string } | null> {
  if (config.secretId !== undefined && config.secretId.length > 0 && config.secretKey !== undefined && config.secretKey.length > 0) {
    return { secretId: config.secretId, secretKey: config.secretKey }
  }
  const credentials = ctx.get('credentials')
  const environment = launchEnvironmentOf(ctx)
  const resolveRef = async (env: string): Promise<string | undefined> => {
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(credentialRef(env))
      if (resolved !== undefined && resolved.value.length > 0) return resolved.value
    }
    const ambient = environment.get(env)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }
  // The legacy bare `TENCENT_*` spellings stay honored behind the SDK
  // convention defaults, so a shell that exported either pair works.
  const LEGACY_ID_ENV = 'TENCENT_SECRET_ID'
  const LEGACY_KEY_ENV = 'TENCENT_SECRET_KEY'
  const secretId = config.secretId?.length
    ? config.secretId
    : await resolveRef(config.secretIdEnv) ?? await resolveRef(LEGACY_ID_ENV)
  const secretKey = config.secretKey?.length
    ? config.secretKey
    : await resolveRef(config.secretKeyEnv) ?? await resolveRef(LEGACY_KEY_ENV)
  if (secretId === undefined || secretKey === undefined) return null
  return { secretId, secretKey }
}

/** Whether a browser page may call the route: same machine (loopback) always; LAN only with an all-interfaces bind. */
function originAllowed(origin: string, bindHost: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  const hostname = url.hostname
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  return loopback || bindHost === '0.0.0.0'
}

/** Collect the request body, refusing anything over the cap. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        if (!failed) {
          failed = true
          reject(new Error(`request body exceeds ${maxBytes} bytes`))
        }
        return // keep draining so the socket can be reused
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(json)
}

/** Validate the route payload and return the decoded audio, or a failure message. */
function parsePayload(
  raw: unknown,
  maxAudioBytes: number,
): { ok: true; voiceFormat: VoiceFormat; audio: Buffer } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'expected a JSON object' }
  const { voiceFormat, data } = raw as { voiceFormat?: unknown; data?: unknown }
  if (voiceFormat !== 'pcm' && voiceFormat !== 'wav') {
    return { ok: false, message: 'voiceFormat must be "pcm" or "wav"' }
  }
  if (typeof data !== 'string' || data.length === 0) return { ok: false, message: 'data must be a non-empty base64 string' }
  let audio: Buffer
  try {
    audio = Buffer.from(data, 'base64')
  } catch {
    return { ok: false, message: 'data is not valid base64' }
  }
  if (audio.length === 0) return { ok: false, message: 'audio is empty' }
  if (audio.length > maxAudioBytes) {
    return { ok: false, message: `audio exceeds the ${maxAudioBytes}-byte limit (60s of 16k PCM ≈ 1.92 MB)` }
  }
  return { ok: true, voiceFormat, audio }
}

/** One recognize request: origin gate → payload gate → credentials → upstream call. */
async function handleRecognize(
  ctx: Context,
  configOf: () => Config,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST only' } })
    return
  }
  const origin = req.headers.origin
  if (origin !== undefined && !originAllowed(origin, ctx.webServer.host)) {
    respond(res, 403, { error: { code: 'origin-forbidden', message: 'cross-origin calls are not allowed' } })
    return
  }

  let raw: unknown
  try {
    const body = await readBody(req, MAX_BODY_BYTES)
    raw = JSON.parse(body.toString('utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    respond(res, 400, { error: { code: 'bad-request', message } })
    return
  }
  const config = configOf()
  const parsed = parsePayload(raw, config.maxAudioBytes)
  if (!parsed.ok) {
    respond(res, 400, { error: { code: 'bad-request', message: parsed.message } })
    return
  }

  const secrets = await resolveCredentials(ctx, config)
  if (secrets === null) {
    respond(res, 503, {
      error: {
        code: 'credentials-missing',
        message: `Tencent Cloud credentials are not configured (set ${config.secretIdEnv}/${config.secretKeyEnv} or the stt-tencent section)`,
      },
    })
    return
  }

  try {
    const result = await recognizeSentence({
      secretId: secrets.secretId,
      secretKey: secrets.secretKey,
      region: config.region,
      engineModelType: config.engineModelType,
      voiceFormat: parsed.voiceFormat,
      audio: parsed.audio,
      timeoutMs: config.timeoutMs,
    })
    respond(res, 200, { text: result.text, audioDurationMs: result.audioDurationMs })
  } catch (error) {
    if (error instanceof Error && error.name === 'TencentAsrError') {
      const { code, message, requestId } = error as Error & { code: string; requestId?: string }
      respond(res, 502, { error: { code, message, requestId } })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    respond(res, 500, { error: { code: 'internal', message } })
  }
}

/**
 * The self-served configuration surface: GET returns the effective engine
 * and appId; POST persists engine/appId into the settings section (host-side
 * write — the apiproxy whitelist only gates browser→API, never this route).
 */
async function handleConfig(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  configOf: () => Config,
  persist: (next: Partial<Config>) => void,
): Promise<void> {
  const origin = req.headers.origin
  if (origin !== undefined && !originAllowed(origin, ctx.webServer.host)) {
    respond(res, 403, { error: { code: 'origin-forbidden', message: 'cross-origin calls are not allowed' } })
    return
  }
  if (req.method === 'GET') {
    const current = configOf()
    respond(res, 200, {
      engine: current.engine,
      appId: current.appId ?? '',
    })
    return
  }
  if (req.method !== 'POST') {
    respond(res, 405, { error: { code: 'method-not-allowed', message: 'GET or POST only' } })
    return
  }
  let raw: unknown
  try {
    const body = await readBody(req, 16_384)
    raw = JSON.parse(body.toString('utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    respond(res, 400, { error: { code: 'bad-request', message } })
    return
  }
  const { engine, appId } = raw as { engine?: unknown; appId?: unknown }
  if (engine !== 'flash' && engine !== 'sentence') {
    respond(res, 400, { error: { code: 'bad-request', message: 'engine must be "flash" or "sentence"' } })
    return
  }
  if (appId !== undefined && typeof appId !== 'string') {
    respond(res, 400, { error: { code: 'bad-request', message: 'appId must be a string' } })
    return
  }
  const next: Partial<Config> = { engine }
  if (appId !== undefined) next.appId = appId.trim()
  persist(next)
  respond(res, 200, { engine, appId: next.appId ?? '' })
}

/**
 * Register the voice-input routes (recognize, capabilities, stream upgrade,
 * config) and the settings section.
 * @param ctx - cordis context carrying the injected `webServer`.
 * @param config - the composition entry's config (defaults for the section).
 */
export function apply(ctx: Context, config: Config): void {
  let configOf: () => Config = () => config
  // Unlike installSettingsSection, the registration here keeps the write
  // scope: the browser-facing /stt/config route persists engine/appId into
  // the namespace directly (host-side writes never cross the apiproxy
  // whitelist, which only gates browser→API access).
  const scope = ctx.settings.register(STT_TENCENT_SETTINGS_NAMESPACE, Config, { base: config })
  configOf = () => scope.get()
  void scope.watch(() => {})

  // The effective engine: `flash` needs an appId; without one the browser
  // half gets `sentence` (the 5000-call package still works). The appId also
  // falls back to the launch environment (TENCENTCLOUD_APPID), matching the
  // secret spellings.
  const appIdOf = (current: Config): string | undefined => {
    if (current.appId !== undefined && current.appId.trim() !== '') return current.appId.trim()
    const ambient = launchEnvironmentOf(ctx).get('TENCENTCLOUD_APPID')
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }
  const effectiveEngine = (current: Config): 'flash' | 'sentence' =>
    current.engine === 'flash' && appIdOf(current) !== undefined ? 'flash' : 'sentence'

  // Browser half probes this before recording to pick its transport.
  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: CAPABILITIES_ROUTE,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          respond(res, 405, { error: { code: 'method-not-allowed', message: 'GET only' } })
          return
        }
        const current = configOf()
        respond(res, 200, {
          engine: effectiveEngine(current),
          streamPath: STREAM_ROUTE,
          sentencePath: RECOGNIZE_ROUTE,
        })
      },
    })
    return unregister
  }, 'stt-tencent: /stt/capabilities route')

  // Self-served configuration surface (engine + appId): the browser half
  // reads and writes this instead of the settings API, so the feature needs
  // no apiproxy whitelist change. The stored section lives in the same
  // namespace installSettingsSection would manage, so a future official
  // settings card reads the same values.
  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: (req, res) => void handleConfig(ctx, req, res, () => configOf(), (next) => {
        void scope.replace(next)
      }),
    })
    return unregister
  }, 'stt-tencent: /stt/config route')

  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: RECOGNIZE_ROUTE,
      handler: (req, res) => void handleRecognize(ctx, configOf, req, res),
    })
    return unregister
  }, 'stt-tencent: /stt/recognize route')

  // Streaming uplink proxy: browser WebSocket ↔ Tencent 实时识别 V2. The
  // credentials resolve per connection, so the proxy degrades to rejections
  // (never a crash) when the section lacks them or the engine is sentence.
  ctx.effect(() => {
    const proxy = new StreamProxy(async () => {
      const current = configOf()
      if (effectiveEngine(current) !== 'flash') return null
      const secrets = await resolveCredentials(ctx, current)
      if (secrets === null) return null
      const appId = appIdOf(current)
      if (appId === undefined) return null
      return {
        appId,
        secretId: secrets.secretId,
        secretKey: secrets.secretKey,
        engineModelType: current.engineModelType,
      }
    })
    const unregister = ctx.webServer.registerUpgrade({
      path: STREAM_ROUTE,
      handler: (req, socket, head) => proxy.handleUpgrade(req, socket, head),
    })
    return () => {
      unregister()
      proxy.close()
    }
  }, 'stt-tencent: /stt/stream upgrade route')
}
