/**
 * Same-origin caller for the host STT proxy (`POST /stt/recognize`, served by
 * @deepseek-ai/dsh-host-stt-tencent). The proxy holds the cloud credentials;
 * this module only ever ships recorded audio and receives text.
 */

/** One recognition failure, as the proxy reported it (or a local transport failure). */
export interface RecognizeFailure {
  code: string
  message: string
  requestId?: string
}

/** Result of one recognition attempt. */
export type RecognizeOutcome = { ok: true; text: string } | { ok: false; error: RecognizeFailure }

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Recognize one ≤60s PCM recording through the host proxy.
 * @param pcm - 16k mono 16-bit little-endian PCM bytes.
 * @returns the recognized text, or a structured failure.
 */
export async function recognizePcm(pcm: Uint8Array): Promise<RecognizeOutcome> {
  let response: Response
  try {
    response = await fetch('/stt/recognize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voiceFormat: 'pcm', data: base64Encode(pcm) }),
    })
  } catch (error) {
    return {
      ok: false,
      error: { code: 'transport', message: error instanceof Error ? error.message : String(error) },
    }
  }
  let body: { text?: unknown; error?: { code?: unknown; message?: unknown; requestId?: unknown } }
  try {
    body = await response.json() as typeof body
  } catch {
    return { ok: false, error: { code: 'invalid-response', message: `non-JSON response (HTTP ${response.status})` } }
  }
  if (!response.ok || body.error !== undefined) {
    const failure: RecognizeFailure = {
      code: typeof body.error?.code === 'string' ? body.error.code : `http-${response.status}`,
      message: typeof body.error?.message === 'string' ? body.error.message : response.statusText,
    }
    // exactOptionalPropertyTypes: only set when present.
    if (typeof body.error?.requestId === 'string') failure.requestId = body.error.requestId
    return { ok: false, error: failure }
  }
  if (typeof body.text !== 'string') {
    return { ok: false, error: { code: 'invalid-response', message: 'missing text in response' } }
  }
  return { ok: true, text: body.text }
}

/** The engine/AppId configuration the host serves and persists. */
export interface SttConfig {
  engine: 'flash' | 'sentence'
  appId: string
}

type ConfigOutcome =
  | { ok: true; engine: 'flash' | 'sentence'; appId: string }
  | { ok: false; error: RecognizeFailure }

async function readConfigResponse(response: Response): Promise<ConfigOutcome> {
  let body: { engine?: unknown; appId?: unknown; error?: { code?: unknown; message?: unknown } }
  try {
    body = await response.json() as typeof body
  } catch {
    return { ok: false, error: { code: 'invalid-response', message: `non-JSON response (HTTP ${response.status})` } }
  }
  if (!response.ok || body.error !== undefined) {
    return {
      ok: false,
      error: {
        code: typeof body.error?.code === 'string' ? body.error.code : `http-${response.status}`,
        message: typeof body.error?.message === 'string' ? body.error.message : response.statusText,
      },
    }
  }
  const engine = body.engine === 'sentence' ? 'sentence' : 'flash'
  return { ok: true, engine, appId: typeof body.appId === 'string' ? body.appId : '' }
}

/**
 * Read the current engine/appId from the host plugin's own config surface.
 * This route lives in the STT host plugin itself, so the settings card works
 * without any settings-namespace whitelist in the core apiproxy.
 */
export async function fetchConfig(): Promise<ConfigOutcome> {
  try {
    return await readConfigResponse(await fetch('/stt/config'))
  } catch (error) {
    return { ok: false, error: { code: 'transport', message: error instanceof Error ? error.message : String(error) } }
  }
}

/** Persist engine/appId through the host plugin's own config surface. */
export async function saveConfig(engine: 'flash' | 'sentence', appId: string): Promise<ConfigOutcome> {
  try {
    return await readConfigResponse(await fetch('/stt/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine, appId }),
    }))
  } catch (error) {
    return { ok: false, error: { code: 'transport', message: error instanceof Error ? error.message : String(error) } }
  }
}
