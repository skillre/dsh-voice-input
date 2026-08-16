import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
//#region lib/types/tencent-asr.js
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
function sha256Hex(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
function hmac(key, value) {
	return createHmac("sha256", key).update(value, "utf8").digest();
}
/**
* Tencent Cloud Signature v3 (TC3-HMAC-SHA256) for a JSON-body POST to the
* product root. Canonical request, string-to-sign, and the four-stage HMAC
* chain exactly as the 云 API 签名方法 v3 spec defines them.
*/
function tc3Sign(input) {
	const timestamp = input.timestamp ?? Math.floor(Date.now() / 1e3);
	const date = (/* @__PURE__ */ new Date(timestamp * 1e3)).toISOString().slice(0, 10);
	const names = Object.keys(input.signedHeaders).sort();
	const canonicalHeaders = names.map((name) => `${name}:${(input.signedHeaders[name] ?? "").trim()}`).join("\n") + "\n";
	const signedHeaderNames = names.join(";");
	const canonicalRequest = [
		input.method,
		input.uri,
		input.query,
		canonicalHeaders,
		signedHeaderNames,
		sha256Hex(input.body)
	].join("\n");
	const scope = `${date}/${input.service}/tc3_request`;
	const stringToSign = [
		"TC3-HMAC-SHA256",
		String(timestamp),
		scope,
		sha256Hex(canonicalRequest)
	].join("\n");
	const signature = hmac(hmac(hmac(hmac(`TC3${input.secretKey}`, date), input.service), "tc3_request"), stringToSign).toString("hex");
	return {
		authorization: `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
		timestamp
	};
}
/** Tencent's service-side error, carried verbatim for the GUI to surface. */
var TencentAsrError = class extends Error {
	code;
	requestId;
	constructor(code, message, requestId = void 0) {
		super(message);
		this.code = code;
		this.requestId = requestId;
		this.name = "TencentAsrError";
	}
};
const SERVICE = "asr";
const HOST = "asr.tencentcloudapi.com";
const VERSION = "2019-06-14";
const ACTION = "SentenceRecognition";
/**
* Recognize one ≤60s utterance through 一句话识别 (synchronous POST).
* @param options - credentials, audio, and engine selection.
* @returns the recognized text and the request trace id.
* @throws TencentAsrError on service-side errors and transport failures.
*/
async function recognizeSentence(options) {
	const payload = {
		ProjectId: 0,
		SubServiceType: 2,
		EngSerViceType: options.engineModelType,
		SourceType: 1,
		VoiceFormat: options.voiceFormat,
		Data: Buffer.from(options.audio).toString("base64"),
		DataLen: options.audio.byteLength
	};
	const body = JSON.stringify(payload);
	const signed = tc3Sign({
		method: "POST",
		uri: "/",
		query: "",
		signedHeaders: {
			"content-type": "application/json; charset=utf-8",
			host: HOST
		},
		body,
		service: SERVICE,
		secretId: options.secretId,
		secretKey: options.secretKey
	});
	const headers = {
		"Content-Type": "application/json; charset=utf-8",
		Host: HOST,
		"X-TC-Action": ACTION,
		"X-TC-Version": VERSION,
		"X-TC-Region": options.region,
		"X-TC-Timestamp": String(signed.timestamp),
		Authorization: signed.authorization
	};
	let response;
	try {
		response = await fetch(options.endpoint ?? `https://${HOST}`, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.timeout(options.timeoutMs)
		});
	} catch (error) {
		throw new TencentAsrError("transport", `upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const raw = await response.text();
	let envelope;
	try {
		envelope = JSON.parse(raw);
	} catch {
		throw new TencentAsrError("invalid-response", `non-JSON upstream response (HTTP ${response.status})`);
	}
	const error = envelope.Response?.Error;
	if (error !== void 0) {
		const code = String(error.Code ?? "unknown");
		throw new TencentAsrError(code, String(error.Message ?? code), typeof envelope.Response?.RequestId === "string" ? envelope.Response.RequestId : void 0);
	}
	if (envelope.Response === void 0) throw new TencentAsrError("invalid-response", `malformed upstream response (HTTP ${response.status})`);
	return {
		text: typeof envelope.Response.Result === "string" ? envelope.Response.Result : "",
		audioDurationMs: typeof envelope.Response.AudioDuration === "number" ? envelope.Response.AudioDuration : 0,
		requestId: typeof envelope.Response.RequestId === "string" ? envelope.Response.RequestId : ""
	};
}
/** The signed WebSocket URL for one real-time session (HMAC-SHA1, base64). */
function buildStreamUrl(params, secretKey) {
	const query = Object.entries({
		engine_model_type: params.engineModelType,
		expired: String(params.expired),
		needvad: String(params.needvad),
		nonce: String(params.nonce),
		secretid: params.secretId,
		timestamp: String(params.timestamp),
		voice_format: String(params.voiceFormat),
		voice_id: params.voiceId
	}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
	const signingText = `asr.cloud.tencent.com/asr/v2/${params.appId}?${query}`;
	const signature = createHmac("sha1", secretKey).update(signingText, "utf8").digest("base64");
	return `wss://asr.cloud.tencent.com/asr/v2/${params.appId}?${query}&signature=${encodeURIComponent(signature)}`;
}
/**
* Parse one upstream 实时识别 JSON frame. Errors throw TencentAsrError so the
* proxy can surface the service's own code/message to the browser half.
*/
function parseStreamFrame(raw) {
	let frame;
	try {
		frame = JSON.parse(raw);
	} catch {
		throw new TencentAsrError("invalid-frame", "non-JSON frame from the streaming uplink");
	}
	if (frame.code !== void 0 && Number(frame.code) !== 0) throw new TencentAsrError(String(frame.code), String(frame.message ?? frame.code));
	const result = frame.result;
	if (result === void 0) return {
		final: frame.final === 1 || frame.final === "1",
		text: "",
		sliceType: -1
	};
	const sliceType = typeof result.slice_type === "number" ? result.slice_type : -1;
	const text = typeof result.voice_text_str === "string" ? result.voice_text_str : typeof result.text === "string" ? result.text : "";
	return {
		final: frame.final === 1 || frame.final === "1",
		text,
		sliceType
	};
}
/** The end-of-stream control frame (the docs' `{"type": "end"}` text message). */
function buildStreamEndFrame() {
	return JSON.stringify({ type: "end" });
}
//#endregion
//#region lib/types/stream-proxy.js
/**
* 实时语音识别 V2 (WebSocket) proxy: bridges one browser WebSocket to the
* Tencent streaming uplink. The browser half speaks a minimal protocol —
* binary frames are raw PCM, the text frame {"type":"end"} ends the session —
* and receives simplified JSON result frames; this module owns the Tencent
* wire protocol (signed URL, voice_id correlation, final-frame handshake).
* @module @deepseek-ai/dsh-host-stt-tencent
*/
/** Signed-URL lifetime for one stream session. */
const URL_TTL_SECONDS = 3600;
/** How long the browser may wait for the final frame after its end signal. */
const FINAL_FRAME_TIMEOUT_MS = 15e3;
/** Owns the noServer WebSocketServer and per-connection bridging. */
var StreamProxy = class {
	resolveCredentials;
	server = new WebSocketServer({ noServer: true });
	/**
	* @param resolveCredentials - per-connection async credential resolve;
	* returning null rejects the session (missing appId/secrets) without
	* touching Tencent.
	*/
	constructor(resolveCredentials) {
		this.resolveCredentials = resolveCredentials;
	}
	/** The webserver upgrade-route handler for `/stt/stream`. */
	handleUpgrade(req, socket, head) {
		this.server.handleUpgrade(req, socket, head, (browser) => {
			this.bridge(browser);
		});
	}
	/** Terminate every live session (plugin teardown). */
	close() {
		for (const socket of this.server.clients) socket.terminate();
		this.server.close();
	}
	async bridge(browser) {
		const credentials = await this.resolveCredentials();
		if (credentials === null) {
			browser.close(1011, "stt stream unavailable: credentials or appId missing");
			return;
		}
		const now = Math.floor(Date.now() / 1e3);
		const voiceId = randomUUID();
		const url = buildStreamUrl({
			appId: credentials.appId,
			secretId: credentials.secretId,
			engineModelType: credentials.engineModelType,
			expired: now + URL_TTL_SECONDS,
			nonce: randomInt(1e3, 99999),
			timestamp: now,
			voiceFormat: 1,
			voiceId,
			needvad: 1
		}, credentials.secretKey);
		let upstream;
		try {
			upstream = new WebSocket(url);
		} catch (error) {
			this.send(browser, {
				type: "error",
				text: "",
				final: false,
				sliceType: -1,
				code: "upstream-connect",
				message: String(error)
			});
			browser.close(1011, "upstream connect failed");
			return;
		}
		let finalized = false;
		let ended = false;
		let tornDown = false;
		let upstreamOpen = false;
		const pendingFrames = [];
		const teardown = () => {
			if (tornDown) return;
			tornDown = true;
			try {
				browser.close();
			} catch {}
			try {
				upstream.close();
			} catch {}
		};
		const relay = (frame) => {
			this.send(browser, frame);
			if (frame.type === "result" && frame.final) finalized = true;
		};
		const handleControl = (text) => {
			try {
				if (JSON.parse(text).type === "end") {
					ended = true;
					if (!finalized) upstream.send(buildStreamEndFrame());
					setTimeout(() => {
						if (!finalized) {
							relay({
								type: "error",
								text: "",
								final: false,
								sliceType: -1,
								code: "final-timeout",
								message: "no final frame from the uplink"
							});
							teardown();
						}
					}, FINAL_FRAME_TIMEOUT_MS);
				}
			} catch {}
		};
		upstream.on("open", () => {
			upstreamOpen = true;
			for (const pending of pendingFrames) if (pending.isBinary) upstream.send(pending.data);
			else handleControl(pending.data.toString());
			pendingFrames.length = 0;
		});
		upstream.on("message", (data) => {
			if (finalized) return;
			const raw = data.toString();
			try {
				const frame = parseStreamFrame(raw);
				if (frame.text === "" && !frame.final && frame.sliceType === -1) return;
				relay({
					type: "result",
					text: frame.text,
					final: frame.final,
					sliceType: frame.sliceType
				});
			} catch (error) {
				relay({
					type: "error",
					text: "",
					final: false,
					sliceType: -1,
					code: error instanceof TencentAsrError ? error.code : "internal",
					message: error instanceof Error ? error.message : String(error)
				});
			}
		});
		upstream.on("error", (error) => {
			relay({
				type: "error",
				text: "",
				final: false,
				sliceType: -1,
				code: "upstream",
				message: String(error)
			});
			teardown();
		});
		upstream.on("close", () => teardown());
		browser.on("message", (data, isBinary) => {
			if (tornDown || ended) return;
			if (!upstreamOpen) {
				pendingFrames.push({
					data,
					isBinary
				});
				return;
			}
			if (isBinary) {
				upstream.send(data);
				return;
			}
			handleControl(data.toString());
		});
		browser.on("close", () => teardown());
		browser.on("error", () => teardown());
	}
	send(socket, frame) {
		if (socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify(frame));
	}
};
//#endregion
//#region lib/types/index.js
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
/** Cordis plugin name used by loader diagnostics. */
const name = "stt-tencent";
/** Service required before the route can register. */
const inject = ["webServer", "settings"];
const Config = z.object({
	secretId: z.string().role("secret"),
	secretKey: z.string().role("secret"),
	secretIdEnv: z.string().role("credential-ref").default("TENCENTCLOUD_SECRET_ID"),
	secretKeyEnv: z.string().role("credential-ref").default("TENCENTCLOUD_SECRET_KEY"),
	appId: z.string().role("credential-ref"),
	engine: z.union([z.const("flash"), z.const("sentence")]).default("flash"),
	region: z.string().default("ap-guangzhou"),
	engineModelType: z.string().default("16k_zh"),
	timeoutMs: z.number().step(1).min(1e3).default(15e3),
	maxAudioBytes: z.number().step(1).min(1024).default(2e6)
});
/** Settings namespace carrying this plugin's editable section. */
const STT_TENCENT_SETTINGS_NAMESPACE = settingsNamespace("stt-tencent");
/** Route path the browser half posts recorded audio to. */
const RECOGNIZE_ROUTE = "/stt/recognize";
/** Route path the browser half connects the streaming uplink to. */
const STREAM_ROUTE = "/stt/stream";
/** Route path the browser half probes for the active engine. */
const CAPABILITIES_ROUTE = "/stt/capabilities";
/** Route path the browser half reads/writes engine + appId through. */
const CONFIG_ROUTE = "/stt/config";
/** JSON body cap: base64 of maxAudioBytes plus envelope slack. */
const MAX_BODY_BYTES = 35e5;
/** Resolve the effective credentials for one request (config literal → credentials seam → launch environment). */
async function resolveCredentials(ctx, config) {
	if (config.secretId !== void 0 && config.secretId.length > 0 && config.secretKey !== void 0 && config.secretKey.length > 0) return {
		secretId: config.secretId,
		secretKey: config.secretKey
	};
	const credentials = ctx.get("credentials");
	const environment = launchEnvironmentOf(ctx);
	const resolveRef = async (env) => {
		if (credentials !== void 0) {
			const resolved = await credentials.resolve(credentialRef(env));
			if (resolved !== void 0 && resolved.value.length > 0) return resolved.value;
		}
		const ambient = environment.get(env);
		return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
	};
	const LEGACY_ID_ENV = "TENCENT_SECRET_ID";
	const LEGACY_KEY_ENV = "TENCENT_SECRET_KEY";
	const secretId = config.secretId?.length ? config.secretId : await resolveRef(config.secretIdEnv) ?? await resolveRef(LEGACY_ID_ENV);
	const secretKey = config.secretKey?.length ? config.secretKey : await resolveRef(config.secretKeyEnv) ?? await resolveRef(LEGACY_KEY_ENV);
	if (secretId === void 0 || secretKey === void 0) return null;
	return {
		secretId,
		secretKey
	};
}
/** Whether a browser page may call the route: same machine (loopback) always; LAN only with an all-interfaces bind. */
function originAllowed(origin, bindHost) {
	let url;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	const hostname = url.hostname;
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || bindHost === "0.0.0.0";
}
/** Collect the request body, refusing anything over the cap. */
function readBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let failed = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				if (!failed) {
					failed = true;
					reject(/* @__PURE__ */ new Error(`request body exceeds ${maxBytes} bytes`));
				}
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (failed) return;
			resolve(Buffer.concat(chunks));
		});
		req.on("error", reject);
	});
}
function respond(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(json);
}
/** Validate the route payload and return the decoded audio, or a failure message. */
function parsePayload(raw, maxAudioBytes) {
	if (typeof raw !== "object" || raw === null) return {
		ok: false,
		message: "expected a JSON object"
	};
	const { voiceFormat, data } = raw;
	if (voiceFormat !== "pcm" && voiceFormat !== "wav") return {
		ok: false,
		message: "voiceFormat must be \"pcm\" or \"wav\""
	};
	if (typeof data !== "string" || data.length === 0) return {
		ok: false,
		message: "data must be a non-empty base64 string"
	};
	let audio;
	try {
		audio = Buffer.from(data, "base64");
	} catch {
		return {
			ok: false,
			message: "data is not valid base64"
		};
	}
	if (audio.length === 0) return {
		ok: false,
		message: "audio is empty"
	};
	if (audio.length > maxAudioBytes) return {
		ok: false,
		message: `audio exceeds the ${maxAudioBytes}-byte limit (60s of 16k PCM ≈ 1.92 MB)`
	};
	return {
		ok: true,
		voiceFormat,
		audio
	};
}
/** One recognize request: origin gate → payload gate → credentials → upstream call. */
async function handleRecognize(ctx, configOf, req, res) {
	if (req.method !== "POST") {
		respond(res, 405, { error: {
			code: "method-not-allowed",
			message: "POST only"
		} });
		return;
	}
	const origin = req.headers.origin;
	if (origin !== void 0 && !originAllowed(origin, ctx.webServer.host)) {
		respond(res, 403, { error: {
			code: "origin-forbidden",
			message: "cross-origin calls are not allowed"
		} });
		return;
	}
	let raw;
	try {
		const body = await readBody(req, MAX_BODY_BYTES);
		raw = JSON.parse(body.toString("utf8"));
	} catch (error) {
		respond(res, 400, { error: {
			code: "bad-request",
			message: error instanceof Error ? error.message : String(error)
		} });
		return;
	}
	const config = configOf();
	const parsed = parsePayload(raw, config.maxAudioBytes);
	if (!parsed.ok) {
		respond(res, 400, { error: {
			code: "bad-request",
			message: parsed.message
		} });
		return;
	}
	const secrets = await resolveCredentials(ctx, config);
	if (secrets === null) {
		respond(res, 503, { error: {
			code: "credentials-missing",
			message: `Tencent Cloud credentials are not configured (set ${config.secretIdEnv}/${config.secretKeyEnv} or the stt-tencent section)`
		} });
		return;
	}
	try {
		const result = await recognizeSentence({
			secretId: secrets.secretId,
			secretKey: secrets.secretKey,
			region: config.region,
			engineModelType: config.engineModelType,
			voiceFormat: parsed.voiceFormat,
			audio: parsed.audio,
			timeoutMs: config.timeoutMs
		});
		respond(res, 200, {
			text: result.text,
			audioDurationMs: result.audioDurationMs
		});
	} catch (error) {
		if (error instanceof Error && error.name === "TencentAsrError") {
			const { code, message, requestId } = error;
			respond(res, 502, { error: {
				code,
				message,
				requestId
			} });
			return;
		}
		respond(res, 500, { error: {
			code: "internal",
			message: error instanceof Error ? error.message : String(error)
		} });
	}
}
/**
* The self-served configuration surface: GET returns the effective engine
* and appId; POST persists engine/appId into the settings section (host-side
* write — the apiproxy whitelist only gates browser→API, never this route).
*/
async function handleConfig(ctx, req, res, configOf, persist) {
	const origin = req.headers.origin;
	if (origin !== void 0 && !originAllowed(origin, ctx.webServer.host)) {
		respond(res, 403, { error: {
			code: "origin-forbidden",
			message: "cross-origin calls are not allowed"
		} });
		return;
	}
	if (req.method === "GET") {
		const current = configOf();
		respond(res, 200, {
			engine: current.engine,
			appId: current.appId ?? ""
		});
		return;
	}
	if (req.method !== "POST") {
		respond(res, 405, { error: {
			code: "method-not-allowed",
			message: "GET or POST only"
		} });
		return;
	}
	let raw;
	try {
		const body = await readBody(req, 16384);
		raw = JSON.parse(body.toString("utf8"));
	} catch (error) {
		respond(res, 400, { error: {
			code: "bad-request",
			message: error instanceof Error ? error.message : String(error)
		} });
		return;
	}
	const { engine, appId } = raw;
	if (engine !== "flash" && engine !== "sentence") {
		respond(res, 400, { error: {
			code: "bad-request",
			message: "engine must be \"flash\" or \"sentence\""
		} });
		return;
	}
	if (appId !== void 0 && typeof appId !== "string") {
		respond(res, 400, { error: {
			code: "bad-request",
			message: "appId must be a string"
		} });
		return;
	}
	const next = { engine };
	if (appId !== void 0) next.appId = appId.trim();
	persist(next);
	respond(res, 200, {
		engine,
		appId: next.appId ?? ""
	});
}
/**
* Register the voice-input routes (recognize, capabilities, stream upgrade,
* config) and the settings section.
* @param ctx - cordis context carrying the injected `webServer`.
* @param config - the composition entry's config (defaults for the section).
*/
function apply(ctx, config) {
	let configOf = () => config;
	const scope = ctx.settings.register(STT_TENCENT_SETTINGS_NAMESPACE, Config, { base: config });
	configOf = () => scope.get();
	scope.watch(() => {});
	const appIdOf = (current) => {
		if (current.appId !== void 0 && current.appId.trim() !== "") return current.appId.trim();
		const ambient = launchEnvironmentOf(ctx).get("TENCENTCLOUD_APPID");
		return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
	};
	const effectiveEngine = (current) => current.engine === "flash" && appIdOf(current) !== void 0 ? "flash" : "sentence";
	ctx.effect(() => {
		return ctx.webServer.register({
			kind: "exact",
			path: CAPABILITIES_ROUTE,
			handler: (req, res) => {
				if (req.method !== "GET") {
					respond(res, 405, { error: {
						code: "method-not-allowed",
						message: "GET only"
					} });
					return;
				}
				respond(res, 200, {
					engine: effectiveEngine(configOf()),
					streamPath: STREAM_ROUTE,
					sentencePath: RECOGNIZE_ROUTE
				});
			}
		});
	}, "stt-tencent: /stt/capabilities route");
	ctx.effect(() => {
		return ctx.webServer.register({
			kind: "exact",
			path: CONFIG_ROUTE,
			handler: (req, res) => void handleConfig(ctx, req, res, () => configOf(), (next) => {
				scope.replace(next);
			})
		});
	}, "stt-tencent: /stt/config route");
	ctx.effect(() => {
		return ctx.webServer.register({
			kind: "exact",
			path: RECOGNIZE_ROUTE,
			handler: (req, res) => void handleRecognize(ctx, configOf, req, res)
		});
	}, "stt-tencent: /stt/recognize route");
	ctx.effect(() => {
		const proxy = new StreamProxy(async () => {
			const current = configOf();
			if (effectiveEngine(current) !== "flash") return null;
			const secrets = await resolveCredentials(ctx, current);
			if (secrets === null) return null;
			const appId = appIdOf(current);
			if (appId === void 0) return null;
			return {
				appId,
				secretId: secrets.secretId,
				secretKey: secrets.secretKey,
				engineModelType: current.engineModelType
			};
		});
		const unregister = ctx.webServer.registerUpgrade({
			path: STREAM_ROUTE,
			handler: (req, socket, head) => proxy.handleUpgrade(req, socket, head)
		});
		return () => {
			unregister();
			proxy.close();
		};
	}, "stt-tencent: /stt/stream upgrade route");
}
//#endregion
export { CAPABILITIES_ROUTE, CONFIG_ROUTE, Config, RECOGNIZE_ROUTE, STREAM_ROUTE, STT_TENCENT_SETTINGS_NAMESPACE, apply, inject, name };
