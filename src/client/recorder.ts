/**
 * 16k mono 16-bit little-endian PCM capture from the default microphone.
 *
 * Capture pipeline: getUserMedia → AudioContext (16k when the engine honors
 * the hint, native rate otherwise) → ScriptProcessorNode → float samples →
 * linear-interpolation resample to 16k → Int16 PCM bytes.
 *
 * ScriptProcessorNode is deprecated but still shipped by every engine and
 * needs no worklet module URL (an AudioWorklet would have to arrive as a blob
 * inside the CJS plugin bundle, which several browsers reject under strict
 * CSP). If it is ever removed, swap this module's internals for a worklet —
 * the `startRecording` surface stays.
 */

/** Target sample rate 一句话识别 expects (16k_zh engine). */
export const TARGET_RATE = 16_000
/** Hard recording cap: 60s of 16k mono 16-bit. */
export const MAX_CAPTURE_BYTES = TARGET_RATE * 2 * 60

/** One completed recording: the PCM bytes and their duration. */
export interface RecordingResult {
  pcm: Uint8Array
  durationMs: number
}

/** Live recording the owner stops or discards. */
export interface RecordingHandle {
  /** Stop capture and resolve the recorded bytes. */
  stop(): Promise<RecordingResult>
  /** Copy of the PCM captured so far, without stopping (interim previews). */
  snapshot(): RecordingResult
  /** Stop capture and discard the audio. */
  cancel(): void
}

function floatToInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value))
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
}

/** Down/up-sample one float buffer to the target rate (linear interpolation). */
function resampleToPcm(input: Float32Array, inputRate: number, outputRate: number): Uint8Array {
  const ratio = inputRate / outputRate
  if (ratio === 1) {
    const out = new Int16Array(input.length)
    // noUncheckedIndexedAccess: typed reads are possibly-undefined.
    for (let i = 0; i < input.length; i++) out[i] = floatToInt16(input[i] ?? 0)
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  }
  const outLength = Math.floor(input.length / ratio)
  const out = new Int16Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const lower = Math.floor(pos)
    const fraction = pos - lower
    const upper = Math.min(lower + 1, input.length - 1)
    const sample = (input[lower] ?? 0) * (1 - fraction) + (input[upper] ?? 0) * fraction
    out[i] = floatToInt16(sample)
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

/** Capture options. */
export interface RecordingOptions {
  /**
   * Called with every captured PCM chunk (≈256ms each) as it is produced.
   * Streaming engines (flash) feed these straight to the uplink; the one-shot
   * path omits it and reads the accumulated audio on stop.
   */
  onFrame?: (frame: Uint8Array) => void
}

/**
 * Begin capturing the default microphone as 16k mono PCM.
 * @param options - capture options (frame streaming callback).
 * @returns a handle the caller stops (result) or cancels (discard).
 * @throws Error('unsupported') without getUserMedia; otherwise the
 * getUserMedia rejection (DOMException NotAllowedError on denied permission).
 */
export async function startRecording(options: RecordingOptions = {}): Promise<RecordingHandle> {
  const mediaDevices = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices
  if (typeof mediaDevices?.getUserMedia !== 'function') {
    throw new Error('unsupported')
  }
  const stream = await mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
  const context = new AudioContext({ sampleRate: TARGET_RATE })
  await context.resume()
  const inputRate = context.sampleRate
  const source = context.createMediaStreamSource(stream)
  // 1-in 1-out: the recorder owns the channel math; nothing downstream.
  const processor = context.createScriptProcessor(4096, 1, 1)

  const chunks: Uint8Array[] = []
  let capturedBytes = 0
  let capped = false
  let collecting = true

  processor.onaudioprocess = (event: AudioProcessingEvent): void => {
    if (!collecting || capped) return
    const pcm = resampleToPcm(event.inputBuffer.getChannelData(0), inputRate, TARGET_RATE)
    chunks.push(pcm)
    capturedBytes += pcm.byteLength
    options.onFrame?.(pcm)
    if (capturedBytes >= MAX_CAPTURE_BYTES) capped = true
  }

  source.connect(processor)
  processor.connect(context.destination) // silent sink; the node needs an output

  const teardown = (): void => {
    collecting = false
    try {
      processor.disconnect()
      source.disconnect()
    } catch {
      // already disconnected
    }
    void context.close()
    for (const track of stream.getTracks()) track.stop()
  }

  const buildResult = (): RecordingResult => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const pcm = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      pcm.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { pcm, durationMs: Math.round((total / 2 / TARGET_RATE) * 1000) }
  }

  return {
    stop: async (): Promise<RecordingResult> => {
      teardown()
      return buildResult()
    },
    snapshot: (): RecordingResult => buildResult(),
    cancel: teardown,
  }
}
