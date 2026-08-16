# dsh-tencent-voice-input

给 DeepSeek Harness（DSH）Web GUI 加腾讯云语音识别（ASR）语音输入的**纯插件 bundle**：输入框工具行 🎤 麦克风、边说边出的实时预览、结束自动填入输入框；引擎与 AppId 在「设置 → 插件 → 插件配置 → 语音识别设置」卡片里配置。

**不修改、不重建任何核心包** —— 全部通过 dsh 公开插拔机制挂载：

- 麦克风挂在官方公开槽 `conversation.input.left`（工具行），写回走公开 `inputActions.setDraft`。
- 设置卡片挂在官方公开槽 `settings.plugin.item`，读写走本插件宿主半身自带的 `/stt/config` 路由（不依赖任何设置白名单）。

一个包同时是宿主插件（`lib/index.js`，持腾讯云密钥的 STT 代理）和浏览器插件（`lib/client.js`，麦克风 + 卡片），`dsh.bundle.patch` 一行同时接好两边。

## 安装

```sh
dsh plugin --profile web add dsh-tencent-voice-input
```

然后**重启 dsh web**。

（或直接加 tarball / git 目录：`dsh plugin --profile web add ./dsh-tencent-voice-input-0.1.0.tgz`）

## 一次性配置

把腾讯云密钥写进 `$DSH_HOME/.env`（dsh 启动时自动加载）：

```
TENCENTCLOUD_SECRET_ID=AKIDxxxxxxxx
TENCENTCLOUD_SECRET_KEY=xxxxxxxx
TENCENTCLOUD_APPID=1234567890     # AppId,实时流式引擎需要
```

## 使用

1. 点输入框工具行的 🎤 开始录音，上方气泡**实时显示识别文字**；再点一下结束，完整内容填入输入框。
2. **设置 → 插件 → 插件配置 → 语音识别设置**：切换引擎 / 填 AppId，保存即生效（走 `/stt/config`，无需重启）。

| 引擎 | 免费额度 | 计费 | 体验 |
|---|---|---|---|
| **flash**（默认） | 实时语音识别 5h | 按音频时长 | 字级实时预览 |
| **sentence** | 一句话识别 5000 次 | 按次 | 3 秒级预览，结束整段识别 |

未填 AppId 自动回退 sentence；流式中断自动降级一句话识别兜底，不丢内容。

## 接口（宿主半身）

```
POST /stt/recognize        (sentence) { voiceFormat, data(base64) } → { text }
GET  /stt/capabilities     → { engine, streamPath, sentencePath }
WS   /stt/stream           (flash) 二进制 PCM 帧 + {"type":"end"} → 简化结果帧
GET/POST /stt/config       → 引擎/AppId 读写（设置卡片数据通道）
```

## 卸载

```sh
dsh plugin --profile web remove dsh-tencent-voice-input
```
