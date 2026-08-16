/**
 * Tencent Cloud ASR (语音识别) wire clients: the 一句话识别 (SentenceRecognition)
 * action (TC3-HMAC-SHA256 v3 signing plus the synchronous short-audio call)
 * and the 实时语音识别 V2 (WebSocket) streaming uplink (HMAC-SHA1 query
 * signing plus the frame protocol). No cloud SDK dependency — the signing is
 * ~60 lines per action and the calls are single-purpose.
 *
 * SentenceRecognition: https://cloud.tencent.com/document/product/1093/35646
 * Signature v3: https://cloud.tencent.com/document/api/1093/35640
 * Real-time V2 (WebSocket): https://cloud.tencent.com/document/product/1093/48982
 * @module @deepseek-ai/dsh-host-stt-tencent
 */

import { createHash, createHmac } from 'node:crypto'

/** Tencent Cloud v3 signature request inputs (service-agnostic, for tests). */
export interface Tc3SigningInput {
  /** HTTP method (this client only ever signs POST). */
  method: string
  /** Canonical URI path (root for the ASR action). */
  uri: string
  /** Canonical query string (empty for JSON-body POSTs). */
  query: string
  /** Signed headers in signing order (name → value; names lowercase). */
  signedHeaders: Record<string, string>
  /** Request body string the payload hash is computed over. */
  body: string
  /** Product service name (asr). */
  service: string
  /** SecretId. */
  secretId: string
  /** SecretKey. */
  secretKey: string
  /** Unix seconds; defaults to now when omitted. */
  timestamp?: number
}

/** The v3 signature product: the Authorization value plus the full header set. */
export interface Tc3Authorization {
  authorization: string
  timestamp: number
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

/**
 * Tencent Cloud Signature v3 (TC3-HMAC-SHA256) for a JSON-body POST to the
 * product root. Canonical request, string-to-sign, and the four-stage HMAC
 * chain exactly as the 云 API 签名方法 v3 spec defines them.
 */
export function tc3Sign(input: Tc3SigningInput): Tc3Authorization {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const names = Object.keys(input.signedHeaders).sort()
  const canonicalHeaders = names
    .map(name => `${name}:${(input.signedHeaders[name] ?? '').trim()}`)
    .join('\n') + '\n'
  const signedHeaderNames = names.join(';')
  const canonicalRequest = [
    input.method, input.uri, input.query,
    canonicalHeaders, signedHeaderNames, sha256Hex(input.body),
  ].join('\n')
  const scope = `${date}/${input.service}/tc3_request`
  const stringToSign = [
    'TC3-HMAC-SHA256', String(timestamp), scope, sha256Hex(canonicalRequest),
  ].join('\n')
  const secretDate = hmac(`TC3${input.secretKey}`, date)
  const secretService = hmac(secretDate, input.service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = hmac(secretSigning, stringToSign).toString('hex')
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, `
      + `SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
    timestamp,
  }
}

/** Tencent's service-side error, carried verbatim for the GUI to surface. */
export class TencentAsrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string | undefined = undefined,
  ) {
    super(message)
    this.name = 'TencentAsrError'
  }
}

/** Audio codecs 一句话识别 accepts; the browser half always sends pcm. */
export type VoiceFormat = 'pcm' | 'wav'

/** One SentenceRecognition call's inputs. */
export interface SentenceRecognitionOptions {
  secretId: string
  secretKey: string
  /** Cloud region serving the request (X-TC-Region). */
  region: string
  /** Recognition engine, e.g. 16k_zh (中文普通话, 16k). */
  engineModelType: string
  /** Codec of {@link audio}. */
  voiceFormat: VoiceFormat
  /** 16k mono 16-bit little-endian PCM (or WAV) bytes, ≤ ~60s. */
  audio: Uint8Array
  /** Abort the upstream call after this many milliseconds. */
  timeoutMs: number
  /** Test seam: override the endpoint (defaults to the product host). */
  endpoint?: string
}

/** The 一句话识别 response projection the GUI needs. */
export interface SentenceRecognitionResult {
  /** Recognized text ('' when the audio carried no speech). */
  text: string
  /** Audio duration as Tencent reported it, in milliseconds. */
  audioDurationMs: number
  requestId: string
}

const SERVICE = 'asr'
const HOST = 'asr.tencentcloudapi.com'
const VERSION = '2019-06-14'
const ACTION = 'SentenceRecognition'

/**
 * Recognize one ≤60s utterance through 一句话识别 (synchronous POST).
 * @param options - credentials, audio, and engine selection.
 * @returns the recognized text and the request trace id.
 * @throws TencentAsrError on service-side errors and transport failures.
 */
export async function recognizeSentence(
  options: SentenceRecognitionOptions,
): Promise<SentenceRecognitionResult> {
  const payload = {
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: options.engineModelType,
    SourceType: 1, // audio carried in Data
    VoiceFormat: options.voiceFormat,
    Data: Buffer.from(options.audio).toString('base64'),
    DataLen: options.audio.byteLength,
  }
  const body = JSON.stringify(payload)
  const signed = tc3Sign({
    method: 'POST',
    uri: '/',
    query: '',
    // Exactly what the official SDK (tencentcloud-sdk-nodejs sign3) signs for
    // a JSON POST: content-type and host only. Signing extra headers (e.g.
    // x-tc-action) is rejected by the auth gateway with
    // AuthFailure.SignatureFailure — verified live against the ASR endpoint.
    signedHeaders: {
      'content-type': 'application/json; charset=utf-8',
      host: HOST,
    },
    body,
    service: SERVICE,
    secretId: options.secretId,
    secretKey: options.secretKey,
  })
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    Host: HOST,
    'X-TC-Action': ACTION,
    'X-TC-Version': VERSION,
    'X-TC-Region': options.region,
    'X-TC-Timestamp': String(signed.timestamp),
    Authorization: signed.authorization,
  }

  let response: Response
  try {
    response = await fetch(options.endpoint ?? `https://${HOST}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TencentAsrError('transport', `upstream request failed: ${reason}`)
  }

  const raw = await response.text()
  let envelope: {
    Response?: {
      Error?: { Code?: unknown; Message?: unknown }
      Result?: unknown
      AudioDuration?: unknown
      RequestId?: unknown
    }
  }
  try {
    envelope = JSON.parse(raw) as typeof envelope
  } catch {
    throw new TencentAsrError('invalid-response', `non-JSON upstream response (HTTP ${response.status})`)
  }
  const error = envelope.Response?.Error
  if (error !== undefined) {
    const code = String(error.Code ?? 'unknown')
    const message = String(error.Message ?? code)
    const requestId = typeof envelope.Response?.RequestId === 'string' ? envelope.Response.RequestId : undefined
    throw new TencentAsrError(code, message, requestId)
  }
  if (envelope.Response === undefined) {
    throw new TencentAsrError('invalid-response', `malformed upstream response (HTTP ${response.status})`)
  }
  return {
    text: typeof envelope.Response.Result === 'string' ? envelope.Response.Result : '',
    audioDurationMs: typeof envelope.Response.AudioDuration === 'number' ? envelope.Response.AudioDuration : 0,
    requestId: typeof envelope.Response.RequestId === 'string' ? envelope.Response.RequestId : '',
  }
}

// ── 实时语音识别 V2 (WebSocket) ─────────────────────────────────────────────

/** 实时识别 V2 query parameters (sorted, urlencoded) for one stream session. */
export interface StreamSessionParams {
  appId: string
  secretId: string
  /** 16k_zh for 普通话 16k; the same engine vocabulary as SentenceRecognition. */
  engineModelType: string
  /** Unix seconds the signed URL stays valid. */
  expired: number
  /** Random positive integer (anti-replay). */
  nonce: number
  /** Unix seconds of signing time. */
  timestamp: number
  /** voice_format=1 → pcm. */
  voiceFormat: number
  /** Session-unique id; the server correlates every frame to it. */
  voiceId: string
  /** 1: server-side VAD (sentence slicing); 0: fixed slicing. */
  needvad: number
}

/** The signed WebSocket URL for one real-time session (HMAC-SHA1, base64). */
export function buildStreamUrl(
  params: StreamSessionParams,
  secretKey: string,
): string {
  const query = Object.entries({
    engine_model_type: params.engineModelType,
    expired: String(params.expired),
    needvad: String(params.needvad),
    nonce: String(params.nonce),
    secretid: params.secretId,
    timestamp: String(params.timestamp),
    voice_format: String(params.voiceFormat),
    voice_id: params.voiceId,
  })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
  // 签名原文 = 主机路径 + 排序拼接的 query(不含 signature、不含协议头)。
  const signingText = `asr.cloud.tencent.com/asr/v2/${params.appId}?${query}`
  const signature = createHmac('sha1', secretKey).update(signingText, 'utf8').digest('base64')
  return `wss://asr.cloud.tencent.com/asr/v2/${params.appId}?${query}&signature=${encodeURIComponent(signature)}`
}

/** One parsed 实时识别 result frame from the upstream (the projection we relay). */
export interface StreamResultFrame {
  /** Whether this frame carries the session's final result. */
  final: boolean
  /** Recognized text of this slice ('' on non-result frames). */
  text: string
  /** Slice type: 0 interim, 2 final sentence, -1 final whole session. */
  sliceType: number
}

/**
 * Parse one upstream 实时识别 JSON frame. Errors throw TencentAsrError so the
 * proxy can surface the service's own code/message to the browser half.
 */
export function parseStreamFrame(raw: string): StreamResultFrame {
  let frame: {
    voice_id?: unknown
    code?: unknown
    message?: unknown
    final?: unknown
    result?: { slice_type?: unknown; voice_text_str?: unknown; text?: unknown }
  }
  try {
    frame = JSON.parse(raw) as typeof frame
  } catch {
    throw new TencentAsrError('invalid-frame', 'non-JSON frame from the streaming uplink')
  }
  if (frame.code !== undefined && Number(frame.code) !== 0) {
    throw new TencentAsrError(String(frame.code), String(frame.message ?? frame.code))
  }
  const result = frame.result
  if (result === undefined) {
    // Handshake/ack frames carry no result; `final` is documented as 1 and
    // observed both as a number and as the string "1".
    return { final: frame.final === 1 || frame.final === '1', text: '', sliceType: -1 }
  }
  const sliceType = typeof result.slice_type === 'number' ? result.slice_type : -1
  const text = typeof result.voice_text_str === 'string'
    ? result.voice_text_str
    : typeof result.text === 'string' ? result.text : ''
  // `final` means the WHOLE session ended (envelope final=1/"1"); a
  // sentence-final slice (slice_type 2) settles one sentence only — the
  // session stays open.
  return { final: frame.final === 1 || frame.final === '1', text, sliceType }
}

/** The end-of-stream control frame (the docs' `{"type": "end"}` text message). */
export function buildStreamEndFrame(): string {
  return JSON.stringify({ type: 'end' })
}
