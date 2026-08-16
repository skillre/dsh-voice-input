window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-voice-input",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region ../../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		//#endregion
		//#region lib/types/client/stt-client.js
		/**
		* Same-origin caller for the host STT proxy (`POST /stt/recognize`, served by
		* @deepseek-ai/dsh-host-stt-tencent). The proxy holds the cloud credentials;
		* this module only ever ships recorded audio and receives text.
		*/
		function base64Encode(bytes) {
			let binary = "";
			const CHUNK = 32768;
			for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
			return btoa(binary);
		}
		/**
		* Recognize one ≤60s PCM recording through the host proxy.
		* @param pcm - 16k mono 16-bit little-endian PCM bytes.
		* @returns the recognized text, or a structured failure.
		*/
		async function recognizePcm(pcm) {
			let response;
			try {
				response = await fetch("/stt/recognize", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						voiceFormat: "pcm",
						data: base64Encode(pcm)
					})
				});
			} catch (error) {
				return {
					ok: false,
					error: {
						code: "transport",
						message: error instanceof Error ? error.message : String(error)
					}
				};
			}
			let body;
			try {
				body = await response.json();
			} catch {
				return {
					ok: false,
					error: {
						code: "invalid-response",
						message: `non-JSON response (HTTP ${response.status})`
					}
				};
			}
			if (!response.ok || body.error !== void 0) {
				const failure = {
					code: typeof body.error?.code === "string" ? body.error.code : `http-${response.status}`,
					message: typeof body.error?.message === "string" ? body.error.message : response.statusText
				};
				if (typeof body.error?.requestId === "string") failure.requestId = body.error.requestId;
				return {
					ok: false,
					error: failure
				};
			}
			if (typeof body.text !== "string") return {
				ok: false,
				error: {
					code: "invalid-response",
					message: "missing text in response"
				}
			};
			return {
				ok: true,
				text: body.text
			};
		}
		async function readConfigResponse(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				return {
					ok: false,
					error: {
						code: "invalid-response",
						message: `non-JSON response (HTTP ${response.status})`
					}
				};
			}
			if (!response.ok || body.error !== void 0) return {
				ok: false,
				error: {
					code: typeof body.error?.code === "string" ? body.error.code : `http-${response.status}`,
					message: typeof body.error?.message === "string" ? body.error.message : response.statusText
				}
			};
			return {
				ok: true,
				engine: body.engine === "sentence" ? "sentence" : "flash",
				appId: typeof body.appId === "string" ? body.appId : ""
			};
		}
		/**
		* Read the current engine/appId from the host plugin's own config surface.
		* This route lives in the STT host plugin itself, so the settings card works
		* without any settings-namespace whitelist in the core apiproxy.
		*/
		async function fetchConfig() {
			try {
				return await readConfigResponse(await fetch("/stt/config"));
			} catch (error) {
				return {
					ok: false,
					error: {
						code: "transport",
						message: error instanceof Error ? error.message : String(error)
					}
				};
			}
		}
		/** Persist engine/appId through the host plugin's own config surface. */
		async function saveConfig(engine, appId) {
			try {
				return await readConfigResponse(await fetch("/stt/config", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						engine,
						appId
					})
				}));
			} catch (error) {
				return {
					ok: false,
					error: {
						code: "transport",
						message: error instanceof Error ? error.message : String(error)
					}
				};
			}
		}
		//#endregion
		//#region lib/types/client/recorder.js
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
		const TARGET_RATE = 16e3;
		function floatToInt16(value) {
			const clamped = Math.max(-1, Math.min(1, value));
			return clamped < 0 ? clamped * 32768 : clamped * 32767;
		}
		/** Down/up-sample one float buffer to the target rate (linear interpolation). */
		function resampleToPcm(input, inputRate, outputRate) {
			const ratio = inputRate / outputRate;
			if (ratio === 1) {
				const out = new Int16Array(input.length);
				for (let i = 0; i < input.length; i++) out[i] = floatToInt16(input[i] ?? 0);
				return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
			}
			const outLength = Math.floor(input.length / ratio);
			const out = new Int16Array(outLength);
			for (let i = 0; i < outLength; i++) {
				const pos = i * ratio;
				const lower = Math.floor(pos);
				const fraction = pos - lower;
				const upper = Math.min(lower + 1, input.length - 1);
				out[i] = floatToInt16((input[lower] ?? 0) * (1 - fraction) + (input[upper] ?? 0) * fraction);
			}
			return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
		}
		/**
		* Begin capturing the default microphone as 16k mono PCM.
		* @param options - capture options (frame streaming callback).
		* @returns a handle the caller stops (result) or cancels (discard).
		* @throws Error('unsupported') without getUserMedia; otherwise the
		* getUserMedia rejection (DOMException NotAllowedError on denied permission).
		*/
		async function startRecording(options = {}) {
			const mediaDevices = navigator.mediaDevices;
			if (typeof mediaDevices?.getUserMedia !== "function") throw new Error("unsupported");
			const stream = await mediaDevices.getUserMedia({ audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			} });
			const context = new AudioContext({ sampleRate: TARGET_RATE });
			await context.resume();
			const inputRate = context.sampleRate;
			const source = context.createMediaStreamSource(stream);
			const processor = context.createScriptProcessor(4096, 1, 1);
			const chunks = [];
			let capturedBytes = 0;
			let capped = false;
			let collecting = true;
			processor.onaudioprocess = (event) => {
				if (!collecting || capped) return;
				const pcm = resampleToPcm(event.inputBuffer.getChannelData(0), inputRate, TARGET_RATE);
				chunks.push(pcm);
				capturedBytes += pcm.byteLength;
				options.onFrame?.(pcm);
				if (capturedBytes >= 192e4) capped = true;
			};
			source.connect(processor);
			processor.connect(context.destination);
			const teardown = () => {
				collecting = false;
				try {
					processor.disconnect();
					source.disconnect();
				} catch {}
				context.close();
				for (const track of stream.getTracks()) track.stop();
			};
			const buildResult = () => {
				const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
				const pcm = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					pcm.set(chunk, offset);
					offset += chunk.byteLength;
				}
				return {
					pcm,
					durationMs: Math.round(total / 2 / TARGET_RATE * 1e3)
				};
			};
			return {
				stop: async () => {
					teardown();
					return buildResult();
				},
				snapshot: () => buildResult(),
				cancel: teardown
			};
		}
		//#endregion
		//#region lib/types/client/voice-session.js
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
		const CAPABILITIES_URL = "/stt/capabilities";
		/** Interim preview cadence for the sentence engine. */
		const PREVIEW_INTERVAL_MS = 3e3;
		/** How long stop() waits for the stream's final frame before falling back. */
		const FINAL_WAIT_MS = 1e4;
		let cachedCapabilities = null;
		async function fetchCapabilities() {
			if (cachedCapabilities !== null) return cachedCapabilities;
			try {
				const response = await fetch(CAPABILITIES_URL);
				if (!response.ok) return null;
				const body = await response.json();
				if (body.engine !== "flash" && body.engine !== "sentence") return null;
				const capabilities = {
					engine: body.engine,
					streamPath: typeof body.streamPath === "string" ? body.streamPath : "/stt/stream",
					sentencePath: typeof body.sentencePath === "string" ? body.sentencePath : "/stt/recognize"
				};
				cachedCapabilities = capabilities;
				return capabilities;
			} catch {
				return null;
			}
		}
		/**
		* Begin one voice session: probe the host, pick the engine, and start the mic.
		* @param callbacks - the seat's preview/result/error sinks.
		* @returns the live session.
		* @throws the recorder's start errors (unsupported / NotAllowedError).
		*/
		async function startVoiceSession(callbacks) {
			const capabilities = await fetchCapabilities();
			const mode = capabilities?.engine === "flash" ? "flash" : "sentence";
			let socket = null;
			let streamFailed = false;
			let sentences = [];
			let interim = "";
			let finalText = null;
			let settled = false;
			let finalWaiters = [];
			const handleStreamFrame = (raw) => {
				let frame;
				try {
					frame = JSON.parse(raw);
				} catch {
					return;
				}
				if (frame.type === "error") {
					streamFailed = true;
					return;
				}
				if (frame.type !== "result") return;
				const text = typeof frame.text === "string" ? frame.text : "";
				const sliceType = typeof frame.sliceType === "number" ? frame.sliceType : -1;
				if (frame.final === true) {
					finalText = sentences.join("") + text;
					settled = true;
					for (const waiter of finalWaiters) waiter();
					finalWaiters = [];
					return;
				}
				if (sliceType === 2) {
					sentences.push(text);
					interim = "";
				} else if (text !== "") interim = text;
				callbacks.onPreview(sentences.join("") + interim);
			};
			const openStream = (streamPath) => {
				try {
					socket = new WebSocket(streamPath);
				} catch {
					streamFailed = true;
					return;
				}
				socket.onmessage = (event) => {
					handleStreamFrame(String(event.data));
				};
				socket.onerror = () => {
					streamFailed = true;
				};
				socket.onclose = () => {
					if (!settled && !stopping) streamFailed = true;
					else if (!settled) {
						for (const waiter of finalWaiters) waiter();
						finalWaiters = [];
					}
				};
			};
			let stopping = false;
			const handle = await startRecording(mode === "flash" ? { onFrame: (frame) => {
				if (socket !== null && socket.readyState === WebSocket.OPEN && !streamFailed) {
					const payload = new Uint8Array(frame.byteLength);
					payload.set(frame);
					socket.send(payload.buffer);
				}
			} } : {});
			if (mode === "flash") openStream(capabilities.streamPath);
			let previewTimer = null;
			let previewInFlight = false;
			let previewSeq = 0;
			const runPreview = async () => {
				if (previewInFlight) return;
				previewInFlight = true;
				const seq = ++previewSeq;
				const outcome = await recognizePcm(handle.snapshot().pcm);
				previewInFlight = false;
				if (seq !== previewSeq) return;
				if (outcome.ok && outcome.text.trim() !== "") callbacks.onPreview(outcome.text);
			};
			if (mode === "sentence") previewTimer = window.setInterval(() => {
				runPreview();
			}, PREVIEW_INTERVAL_MS);
			let ended = false;
			const stop = async () => {
				if (ended) return;
				ended = true;
				stopping = true;
				if (previewTimer !== null) window.clearInterval(previewTimer);
				previewSeq += 1;
				const pcm = (await handle.stop()).pcm;
				if (mode === "flash" && socket !== null && !streamFailed && socket.readyState === WebSocket.OPEN) {
					const finalPromise = new Promise((resolve) => {
						if (settled) {
							resolve();
							return;
						}
						finalWaiters.push(resolve);
						window.setTimeout(() => {
							const index = finalWaiters.indexOf(resolve);
							if (index >= 0) finalWaiters.splice(index, 1);
							resolve();
						}, FINAL_WAIT_MS);
					});
					socket.send(JSON.stringify({ type: "end" }));
					await finalPromise;
					try {
						socket.close();
					} catch {}
					if (finalText !== null && finalText.trim() !== "") {
						callbacks.onResult(finalText);
						return;
					}
				}
				const outcome = await recognizePcm(pcm);
				if (outcome.ok) if (outcome.text.trim() !== "") callbacks.onResult(outcome.text);
				else callbacks.onError(EMPTY_SPEECH);
				else callbacks.onError(outcome.error.message);
			};
			const cancel = () => {
				if (ended) return;
				ended = true;
				stopping = true;
				if (previewTimer !== null) window.clearInterval(previewTimer);
				try {
					socket?.close();
				} catch {}
				handle.cancel();
			};
			return {
				stop,
				cancel
			};
		}
		/** The empty-transcript failure the seat localizes. */
		const EMPTY_SPEECH = "no-speech";
		//#endregion
		//#region \0dsh-css:/Users/skillre/deepseek-harness/packages/client/ui-voice-input/src/client/VoiceInputButton.module.css.mjs
		const css = ".yhNcYG_seat{flex:none;justify-content:center;align-items:center;gap:2px;display:flex;position:relative}.yhNcYG_mic{background:var(--dsw-specific-selector);width:28px;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:999px;place-items:center;transition:background-color .1s,color .1s;display:grid}.yhNcYG_mic:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}.yhNcYG_mic:disabled{opacity:.5;cursor:default}.yhNcYG_micActive,.yhNcYG_micActive:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:#fff;animation:1.4s ease-in-out infinite yhNcYG_voice-pulse}.yhNcYG_micBusy,.yhNcYG_micBusy:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:#fff;opacity:.8}@keyframes yhNcYG_voice-pulse{0%,to{box-shadow:0 0 0 0 color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)}50%{box-shadow:0 0 0 6px #0000}}.yhNcYG_preview{z-index:20;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);width:max-content;max-width:340px;max-height:128px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:break-word;pointer-events:none;border-radius:8px;padding:6px 10px;font-size:12px;line-height:17px;position:absolute;bottom:calc(100% + 8px);left:50%;overflow-y:auto;transform:translate(-50%);box-shadow:0 4px 16px #00000014}.yhNcYG_error{z-index:20;background:var(--dsw-alias-state-error-primary);color:#fff;white-space:nowrap;text-overflow:ellipsis;pointer-events:none;border-radius:8px;width:max-content;max-width:240px;padding:5px 10px;font-size:12px;line-height:17px;position:absolute;bottom:calc(100% + 8px);left:50%;overflow:hidden;transform:translate(-50%)}.yhNcYG_card{gap:10px;max-width:420px;display:grid}.yhNcYG_cardHead{font-size:13px;font-weight:600;line-height:20px}.yhNcYG_cardField{gap:4px;display:grid}.yhNcYG_cardLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}.yhNcYG_cardSelect,.yhNcYG_cardInput{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;height:30px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 8px;font-size:13px;line-height:20px}.yhNcYG_cardSelect:disabled,.yhNcYG_cardInput:disabled{opacity:.6}.yhNcYG_cardFoot{justify-content:space-between;align-items:center;gap:8px;display:flex}.yhNcYG_cardStatus{color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:17px;overflow:hidden}.yhNcYG_cardSave{background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;border:none;border-radius:999px;flex:none;height:28px;padding:0 14px;font-size:13px;line-height:28px}.yhNcYG_cardSave:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}.yhNcYG_cardSave:disabled{opacity:.5;cursor:default}";
		const tagId = "@deepseek-ai/dsh-client-ui-voice-input/VoiceInputButton.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-voice-input";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var VoiceInputButton_module_css_default = {
			"cardHead": "yhNcYG_cardHead",
			"preview": "yhNcYG_preview",
			"voice-pulse": "yhNcYG_voice-pulse",
			"cardField": "yhNcYG_cardField",
			"cardInput": "yhNcYG_cardInput",
			"cardStatus": "yhNcYG_cardStatus",
			"micActive": "yhNcYG_micActive",
			"cardSelect": "yhNcYG_cardSelect",
			"cardFoot": "yhNcYG_cardFoot",
			"error": "yhNcYG_error",
			"mic": "yhNcYG_mic",
			"seat": "yhNcYG_seat",
			"cardSave": "yhNcYG_cardSave",
			"micBusy": "yhNcYG_micBusy",
			"cardLabel": "yhNcYG_cardLabel",
			"card": "yhNcYG_card"
		};
		//#endregion
		//#region lib/types/client/VoiceInputButton.js
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
		/** Mic glyph (16px, currentColor) — the icon set has no mic, so it lives here. */
		function MicGlyph() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: "16",
				height: "16",
				"aria-hidden": true,
				fill: "currentColor",
				children: [(0, react_jsx_runtime.jsx)("path", { d: "M8 1.75A2.25 2.25 0 0 0 5.75 4v4a2.25 2.25 0 0 0 4.5 0V4A2.25 2.25 0 0 0 8 1.75Z" }), (0, react_jsx_runtime.jsx)("path", { d: "M3.75 7.75a.75.75 0 0 1 1.5 0 2.75 2.75 0 0 0 5.5 0 .75.75 0 0 1 1.5 0 4.25 4.25 0 0 1-3.5 4.18v1.32h1.75a.75.75 0 0 1 0 1.5H5.5a.75.75 0 0 1 0-1.5h1.75v-1.32a4.25 4.25 0 0 1-3.5-4.18Z" })]
			});
		}
		/**
		* The tool-row mic core: mic button, live preview bubble, and error bubble.
		*/
		function VoiceToolRowButton({ session, input, useInput, inputActions, t }) {
			const inputState = useInput((s) => s);
			const machineBusy = inputState?.phase === "adjudicating" || inputState?.phase === "submitting";
			const [phase, setPhase] = (0, react.useState)("idle");
			const [error, setError] = (0, react.useState)(null);
			const [preview, setPreview] = (0, react.useState)(null);
			const sessionRef = (0, react.useRef)(null);
			const capTimerRef = (0, react.useRef)(null);
			const [supported] = (0, react.useState)(() => typeof navigator.mediaDevices?.getUserMedia === "function");
			const draft = input?.draft ?? "";
			(0, react.useEffect)(() => () => {
				if (capTimerRef.current !== null) window.clearTimeout(capTimerRef.current);
				sessionRef.current?.cancel();
			}, []);
			const finishRecording = async () => {
				const session = sessionRef.current;
				if (session === null) return;
				sessionRef.current = null;
				if (capTimerRef.current !== null) {
					window.clearTimeout(capTimerRef.current);
					capTimerRef.current = null;
				}
				setPhase("recognizing");
				await session.stop();
				setPreview(null);
				setPhase("idle");
			};
			const toggle = () => {
				if (phase === "recording") {
					finishRecording();
					return;
				}
				if (phase !== "idle") return;
				setError(null);
				setPreview(null);
				startVoiceSession({
					onPreview: setPreview,
					onResult: (text) => {
						if (text === "" || inputActions === void 0) return;
						inputActions.setDraft(draft + text);
					},
					onError: (message) => {
						setError(message === "no-speech" ? t("noSpeech") : t("failed", { reason: message }));
					}
				}).then((session) => {
					sessionRef.current = session;
					setPhase("recording");
					capTimerRef.current = window.setTimeout(() => {
						finishRecording();
					}, 6e4);
				}).catch((reason) => {
					if (reason instanceof DOMException && reason.name === "NotAllowedError") setError(t("denied"));
					else if (reason instanceof Error && reason.message === "unsupported") setError(t("unsupported"));
					else setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			if (!supported) return null;
			const locked = session.removed || machineBusy;
			const label = phase === "recording" ? t("listening") : phase === "recognizing" ? t("recognizing") : t("mic");
			return (0, react_jsx_runtime.jsxs)("div", {
				className: VoiceInputButton_module_css_default.seat,
				children: [
					preview !== null && phase === "recording" && (0, react_jsx_runtime.jsx)("div", {
						className: VoiceInputButton_module_css_default.preview,
						role: "status",
						"aria-live": "polite",
						"data-voice-preview": true,
						children: preview
					}),
					error !== null && (0, react_jsx_runtime.jsx)("span", {
						role: "status",
						className: VoiceInputButton_module_css_default.error,
						"data-voice-error": true,
						children: error
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label,
						side: "top",
						delayMs: 500,
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: clsx(VoiceInputButton_module_css_default.mic, phase === "recording" && VoiceInputButton_module_css_default.micActive, phase === "recognizing" && VoiceInputButton_module_css_default.micBusy),
							"data-voice-input": true,
							"aria-label": label,
							"aria-pressed": phase === "recording",
							disabled: locked,
							onMouseDown: (event) => {
								event.preventDefault();
							},
							onClick: toggle,
							children: (0, react_jsx_runtime.jsx)(MicGlyph, {})
						})
					})
				]
			});
		}
		/**
		* The engine/AppId card on Settings → Plugins → 插件配置. Reads and writes
		* the host plugin's own `/stt/config` route — a plugin-owned surface, so the
		* card works without any settings-namespace whitelist in the core apiproxy.
		*/
		function VoiceConfigCard({ t }) {
			const [state, setState] = (0, react.useState)({
				engine: "flash",
				appId: "",
				loading: false,
				saving: false,
				error: null,
				saved: false
			});
			(0, react.useEffect)(() => {
				let cancelled = false;
				setState((current) => ({
					...current,
					loading: true
				}));
				fetchConfig().then((result) => {
					if (cancelled) return;
					setState((current) => ({
						...current,
						loading: false,
						...result.ok ? {
							engine: result.engine,
							appId: result.appId
						} : { error: result.error.message }
					}));
				});
				return () => {
					cancelled = true;
				};
			}, []);
			const save = () => {
				setState((current) => ({
					...current,
					saving: true,
					error: null,
					saved: false
				}));
				saveConfig(state.engine, state.appId).then((result) => {
					setState((current) => ({
						...current,
						saving: false,
						...result.ok ? {
							engine: result.engine,
							appId: result.appId,
							saved: true
						} : { error: result.error.message }
					}));
				});
			};
			const disabled = state.loading || state.saving;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: VoiceInputButton_module_css_default.card,
				"data-voice-config-card": true,
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: VoiceInputButton_module_css_default.cardHead,
						children: t("configTitle")
					}),
					(0, react_jsx_runtime.jsxs)("label", {
						className: VoiceInputButton_module_css_default.cardField,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: VoiceInputButton_module_css_default.cardLabel,
							children: t("configEngine")
						}), (0, react_jsx_runtime.jsxs)("select", {
							className: VoiceInputButton_module_css_default.cardSelect,
							value: state.engine,
							disabled,
							onChange: (event) => {
								const value = event.target.value;
								setState((current) => ({
									...current,
									engine: value === "sentence" ? "sentence" : "flash"
								}));
							},
							children: [(0, react_jsx_runtime.jsx)("option", {
								value: "flash",
								children: t("configEngineFlash")
							}), (0, react_jsx_runtime.jsx)("option", {
								value: "sentence",
								children: t("configEngineSentence")
							})]
						})]
					}),
					(0, react_jsx_runtime.jsxs)("label", {
						className: VoiceInputButton_module_css_default.cardField,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: VoiceInputButton_module_css_default.cardLabel,
							children: t("configAppId")
						}), (0, react_jsx_runtime.jsx)("input", {
							className: VoiceInputButton_module_css_default.cardInput,
							type: "text",
							inputMode: "numeric",
							placeholder: "1257133316",
							value: state.appId,
							disabled,
							onChange: (event) => {
								setState((current) => ({
									...current,
									appId: event.target.value,
									saved: false
								}));
							}
						})]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: VoiceInputButton_module_css_default.cardFoot,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: VoiceInputButton_module_css_default.cardStatus,
							"data-voice-config-status": true,
							children: state.loading ? t("configLoading") : state.saving ? t("configSaving") : state.saved ? t("configSaved") : state.error ?? ""
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: VoiceInputButton_module_css_default.cardSave,
							disabled,
							onClick: save,
							children: t("configSave")
						})]
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"mic": "语音输入",
			"listening": "正在聆听，点击结束",
			"recognizing": "识别中…",
			"unsupported": "当前浏览器不支持录音（需要 getUserMedia）",
			"denied": "麦克风权限被拒绝，请在浏览器设置中允许后重试",
			"noSpeech": "没有识别到语音，请重试",
			"tooLong": "录音已达 60 秒上限",
			"failed": "语音识别失败：{reason}",
			"empty": "（空）",
			"configTitle": "语音识别设置",
			"configEngine": "识别引擎",
			"configEngineFlash": "实时流式（flash，按音频时长计费）",
			"configEngineSentence": "一句话（sentence，按次计费）",
			"configAppId": "腾讯云 AppId",
			"configSave": "保存",
			"configLoading": "读取中…",
			"configSaving": "保存中…",
			"configSaved": "已保存"
		};
		/** English dictionary. */
		const en = {
			"mic": "Voice input",
			"listening": "Listening — click to stop",
			"recognizing": "Recognizing…",
			"unsupported": "Recording is not supported in this browser (getUserMedia required)",
			"denied": "Microphone access was denied. Allow it in your browser settings and try again.",
			"noSpeech": "No speech recognized. Try again.",
			"tooLong": "Recording reached the 60-second limit",
			"failed": "Speech recognition failed: {reason}",
			"empty": "(empty)",
			"configTitle": "Voice input settings",
			"configEngine": "Recognition engine",
			"configEngineFlash": "Real-time streaming (flash, billed by audio duration)",
			"configEngineSentence": "One-sentence (sentence, billed per call)",
			"configAppId": "Tencent Cloud AppId",
			"configSave": "Save",
			"configLoading": "Loading…",
			"configSaving": "Saving…",
			"configSaved": "Saved"
		};
		//#endregion
		//#region lib/types/client/index.js
		/**
		* Voice input client plugin: mounts the mic control and its configuration
		* card entirely through dsh's public plugin surface — no core package is
		* modified or rebuilt:
		* - `conversation.input.left` (official tool-row slot): the mic button,
		*   committing through the public `inputActions.setDraft` face.
		* - `settings.plugin.item` (official plugins-settings card slot): the
		*   engine/AppId card, reading and writing the host plugin's own
		*   `/stt/config` route (no settings-namespace whitelist involved).
		* The host STT proxy (`@deepseek-ai/dsh-host-stt-tencent`) holds the Tencent
		* credentials; this package only records, recognizes, configures, and writes
		* the draft.
		* @module @deepseek-ai/dsh-client-ui-voice-input
		*/
		/** Dictionary namespace owned by this plugin. */
		const NS = "voice.input";
		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale"];
		/**
		* Client plugin body: register the dictionaries and both mount points. The
		* tool row hosts the mic; the settings section hosts the configuration card.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-voice-input: dictionaries");
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "voice-input",
				locale: NS,
				inject: (_sessionId) => ({})
			}, VoiceToolRowButton));
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				id: "voice-input-config",
				order: 30,
				locale: NS,
				inject: () => ({})
			}, VoiceConfigCard));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map