# dsh-tencent-voice-input

Tencent Cloud ASR (speech recognition) voice input for the DeepSeek Harness
(DSH) web GUI, as a pure pluggable bundle: a mic in the composer tool row with
live "type-as-you-speak" preview, commit-on-stop transcript, and an engine/AppId
card under Settings → Plugins → 插件配置 → 语音识别设置.

**No core package is modified or rebuilt** — everything rides dsh's public
plugin surface:

- The mic mounts on the official `conversation.input.left` tool-row slot and
  commits via the public `inputActions.setDraft`.
- The settings card mounts on the official `settings.plugin.item` slot and
  reads/writes the host half's own `/stt/config` route (no settings whitelist).

One package is both the host plugin (`lib/index.js` — the STT proxy holding the
Tencent secrets) and the browser plugin (`lib/client.js` — mic + card); the
`dsh.bundle.patch` wires both with a single row.

## Install

```sh
dsh plugin --profile web add dsh-tencent-voice-input
```

Then restart `dsh web`.

(Or add a tarball / git directory: `dsh plugin --profile web add ./dsh-tencent-voice-input-0.1.0.tgz`)

## One-time configuration

Put the Tencent keys in `$DSH_HOME/.env` (auto-loaded at boot):

```
TENCENTCLOUD_SECRET_ID=AKIDxxxxxxxx
TENCENTCLOUD_SECRET_KEY=xxxxxxxx
TENCENTCLOUD_APPID=1234567890     # AppId, required by the streaming engine
```

## Use

1. Click the mic in the composer tool row to record; a live preview appears
   above it; click again to stop and commit the transcript to the draft.
2. Settings → Plugins → 插件配置 → 语音识别设置: pick the engine / AppId,
   saved through `/stt/config` (no restart).

| Engine | Free tier | Billing | Experience |
|---|---|---|---|
| **flash** (default) | real-time ASR 5h | per audio duration | character-level live preview |
| **sentence** | one-sentence ASR 5000 calls | per call | ~3s preview, full transcript on stop |

Missing AppId falls back to sentence; a broken stream falls back to one-shot
recognition so nothing is lost.

## Routes (host half)

```
POST /stt/recognize        (sentence) { voiceFormat, data(base64) } → { text }
GET  /stt/capabilities     → { engine, streamPath, sentencePath }
WS   /stt/stream           (flash) binary PCM frames + {"type":"end"} → simplified result frames
GET/POST /stt/config       → engine/AppId read/write (the settings card's data path)
```

## Remove

```sh
dsh plugin --profile web remove dsh-tencent-voice-input
```
