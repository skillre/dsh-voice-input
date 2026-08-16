/** `voice.input` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'voice.input'

/** Key union of the voice dictionaries (declared into the locale slot map). */
export type VoiceKey =
  | 'mic'
  | 'listening'
  | 'recognizing'
  | 'unsupported'
  | 'denied'
  | 'noSpeech'
  | 'tooLong'
  | 'failed'
  | 'empty'
  | 'configTitle' | 'configDescription' | 'configExpand' | 'configCollapse'
  | 'configEngine' | 'configEngineFlash' | 'configEngineSentence'
  | 'configAppId' | 'configSave' | 'configLoading' | 'configSaving' | 'configSaved'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<VoiceKey, string> = {
  'mic': '语音输入',
  'listening': '正在聆听，点击结束',
  'recognizing': '识别中…',
  'unsupported': '当前浏览器不支持录音（需要 getUserMedia）',
  'denied': '麦克风权限被拒绝，请在浏览器设置中允许后重试',
  'noSpeech': '没有识别到语音，请重试',
  'tooLong': '录音已达 60 秒上限',
  'failed': '语音识别失败：{reason}',
  'empty': '（空）',
  'configTitle': '语音识别设置',
  'configDescription': '语音输入的识别引擎与腾讯云 AppId 配置，保存即生效。',
  'configExpand': '展开',
  'configCollapse': '收起',
  'configEngine': '识别引擎',
  'configEngineFlash': '实时流式（flash，按音频时长计费）',
  'configEngineSentence': '一句话（sentence，按次计费）',
  'configAppId': '腾讯云 AppId',
  'configSave': '保存',
  'configLoading': '读取中…',
  'configSaving': '保存中…',
  'configSaved': '已保存',
}

/** English dictionary. */
export const en: Record<VoiceKey, string> = {
  'mic': 'Voice input',
  'listening': 'Listening — click to stop',
  'recognizing': 'Recognizing…',
  'unsupported': 'Recording is not supported in this browser (getUserMedia required)',
  'denied': 'Microphone access was denied. Allow it in your browser settings and try again.',
  'noSpeech': 'No speech recognized. Try again.',
  'tooLong': 'Recording reached the 60-second limit',
  'failed': 'Speech recognition failed: {reason}',
  'empty': '(empty)',
  'configTitle': 'Voice input settings',
  'configDescription': 'Recognition engine and Tencent Cloud AppId for voice input; saved immediately.',
  'configExpand': 'Expand',
  'configCollapse': 'Collapse',
  'configEngine': 'Recognition engine',
  'configEngineFlash': 'Real-time streaming (flash, billed by audio duration)',
  'configEngineSentence': 'One-sentence (sentence, billed per call)',
  'configAppId': 'Tencent Cloud AppId',
  'configSave': 'Save',
  'configLoading': 'Loading…',
  'configSaving': 'Saving…',
  'configSaved': 'Saved',
}
