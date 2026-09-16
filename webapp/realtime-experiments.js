(function (root) {
  "use strict";

  const DEFAULT_PRESET = Object.freeze({
    voice: "coral", transcriptionModel: "gpt-4o-mini-transcribe", language: "ja",
    prompt: "", threshold: 0.75, prefixPaddingMs: 300, silenceDurationMs: 500,
    createResponse: true, interruptResponse: false
  });

  function buildSessionUpdate(options) {
    const { threshold, prefixPaddingMs, silenceDurationMs } = options;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1 ||
        !Number.isInteger(prefixPaddingMs) || prefixPaddingMs < 0 ||
        !Number.isInteger(silenceDurationMs) || silenceDurationMs < 1) {
      throw new Error("Invalid VAD settings: threshold 0..1, padding >= 0, silence > 0.");
    }
    const model = options.transcriptionModel.trim();
    const language = options.language.trim();
    if (language && !/^[a-z]{2}$/.test(language)) {
      throw new Error("Use an ISO-639-1 language such as ja, en or zh, or leave it empty.");
    }
    const transcription = model === "off" ? null : { model };
    if (transcription) {
      if (!model) throw new Error("A transcription model ID or deployment name is required.");
      if (language) transcription.language = language;
      if (options.prompt.trim()) transcription.prompt = options.prompt.trim();
    }
    return {
      type: "session.update",
      session: {
        type: "realtime",
        instructions: options.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription,
            turn_detection: {
              type: "server_vad", threshold, prefix_padding_ms: prefixPaddingMs,
              silence_duration_ms: silenceDurationMs,
              create_response: options.createResponse,
              interrupt_response: options.interruptResponse
            }
          },
          output: { voice: options.voice, format: { type: "audio/pcm", rate: 24000 } }
        }
      }
    };
  }

  function functionRequest(baseUrl, key, body) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.hash ||
        (url.protocol !== "https:" &&
         !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
      throw new Error("Use HTTPS for the Function, or HTTP on localhost for local tests.");
    }
    const queryKeys = url.searchParams.getAll("code");
    if (queryKeys.length > 1 || (key && queryKeys[0] && key !== queryKeys[0])) {
      throw new Error("Conflicting Function keys. Use either the key field or one code parameter.");
    }
    const functionKey = key || queryKeys[0];
    url.searchParams.delete("code");
    const headers = { "Content-Type": "application/json" };
    if (functionKey) headers["x-functions-key"] = functionKey;
    return { url: url.href, options: {
      method: "POST", headers, body: JSON.stringify(body), redirect: "error", cache: "no-store"
    } };
  }

  const SECRET_FIELD = /^(authorization|api[-_]?key|x[-_]?functions[-_]?key|x[-_]?demo[-_]?key|access[-_]?key|demo(?:[-_]?access)?[-_]?key|function[-_]?key|key|token|ephemeral_token|client_secret|value)$/i;

  function credentialQueryKey(key) {
    return key.toLowerCase() === "code" || SECRET_FIELD.test(key);
  }

  function redact(value, secrets = []) {
    if (Array.isArray(value)) return value.map(item => redact(item, secrets));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key, SECRET_FIELD.test(key)
          ? "[redacted]" : key === "audio" && typeof item === "string"
            ? `[audio omitted: ${item.length} base64 chars]` : redact(item, secrets)
      ]));
    }
    if (typeof value === "string") {
      const variants = [...new Set(secrets.filter(secret => typeof secret === "string" && secret)
        .flatMap(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))]
        .sort((a, b) => b.length - a.length);
      for (const secret of variants) value = value.split(secret).join("[redacted]");
      value = value.replace(/(["']?(?:x[-_]?demo[-_]?key|x[-_]?functions[-_]?key|access[-_]?key|demo(?:[-_]?access)?[-_]?key|function[-_]?key|api[-_]?key|ephemeral_token|client_secret|token|key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]");
    }
    return typeof value === "string"
      ? value.replace(/([?&](?:code|api[-_]?key|token|access[-_]?key|x[-_]?demo[-_]?key|demo(?:[-_]?access)?[-_]?key|function[-_]?key|key)=)[^&#\s]+/gi, "$1[redacted]")
        .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
      : value;
  }

  function browserAccessRequest(baseUrl, { demoKey = "", functionKey = "" }, body, pageUrl) {
    if (!baseUrl.trim()) throw new Error("アクセス API URL を入力してください。");
    const url = new URL(baseUrl, pageUrl);
    const sameOrigin = url.origin === new URL(pageUrl).origin;
    if (sameOrigin) {
      if (url.pathname !== "/api/realtime-access" || url.search || url.hash || url.username || url.password) {
        throw new Error("Demo キーの送信先は同一オリジンの /api/realtime-access のみです。URL にキーを含めないでください。");
      }
      const request = functionRequest(url.href, "", body);
      if (demoKey) request.options.headers["x-demo-key"] = demoKey;
      return { ...request, sameOrigin, accessKey: demoKey };
    }
    const request = functionRequest(url.href, functionKey, body);
    if ([...new URL(request.url).searchParams.keys()].some(credentialQueryKey)) {
      throw new Error("キー・トークンは URL ではなく専用のキー欄に入力してください。");
    }
    if (demoKey && request.options.headers["x-functions-key"] === demoKey) {
      throw new Error("Demo キーを外部 URL に送信することはできません。外部 Function 専用キーを使用してください。");
    }
    return { ...request, sameOrigin: false };
  }

  function validateRealtimeUrl(value, transport) {
    const url = new URL(value);
    if (url.protocol !== (transport === "websocket" ? "wss:" : "https:") ||
        url.username || url.password || url.hash ||
        [...url.searchParams.keys()].some(credentialQueryKey)) {
      throw new Error("Realtime 接続 URL は安全な接続先である必要があります。URL にキーを含めないでください。");
    }
    return url.href;
  }

  function createBrowserAccess({ document, pageUrl, fetchImpl }) {
    const urlInput = document.getElementById("functionUrl");
    const demoInput = document.getElementById("demoKey");
    const functionInput = document.getElementById("functionKey");
    const secrets = new Set();
    function remember(value) {
      if (typeof value === "string" && value) secrets.add(value);
    }
    function safe(value) {
      remember(demoInput.value.trim());
      remember(functionInput.value.trim());
      return redact(value, [...secrets]);
    }
    async function getSession(body) {
      const demoKey = demoInput.value.trim();
      const functionKey = functionInput.value.trim();
      remember(demoKey);
      remember(functionKey);
      try {
        const pastedUrl = new URL(urlInput.value, pageUrl);
        for (const key of pastedUrl.searchParams.getAll("code")) remember(key);
        const request = browserAccessRequest(urlInput.value.trim(), { demoKey, functionKey }, body, pageUrl);
        urlInput.value = request.sameOrigin ? "/api/realtime-access" : request.url;
        if (!request.sameOrigin && request.options.headers["x-functions-key"]) {
          functionInput.value = request.options.headers["x-functions-key"];
        }
        const response = await fetchImpl(request.url, {
          ...request.options, signal: AbortSignal.timeout(20000)
        });
        let data;
        try {
          data = await response.json();
        } catch {
          throw new Error(`アクセス API HTTP ${response.status}: JSON 応答を取得できませんでした。`);
        }
        const token = data?.ephemeral_token || data?.session?.client_secret?.value;
        remember(token);
        if (!response.ok) {
          throw new Error(`アクセス API HTTP ${response.status}: ${JSON.stringify(safe(data))}`);
        }
        const transport = body.transport;
        const endpoint = data?.realtime_url ||
          (transport === "websocket" ? data?.websocket_url : data?.webrtc_url);
        if (typeof token !== "string" || !token || typeof endpoint !== "string" ||
            (transport === "websocket" ? data.transport !== transport : data.transport && data.transport !== transport)) {
          throw new Error("アクセス API の応答に必要な一時トークン・接続 URL・transport がありません。");
        }
        const realtimeUrl = validateRealtimeUrl(endpoint, transport);
        const info = safe({
          functionUrl: request.url, transport, tokenKind: "realtime_ephemeral_client_secret",
          issuerPath: "/openai/v1/realtime/client_secrets",
          tokenSource: typeof data.token_source === "string" ? data.token_source : null,
          expiresAt: data.expires_at ?? null, deployment: data.model,
          realtimeUrl, functionHttpStatus: response.status,
          note: "ブラウザーは client_secrets の短期トークンを使用します。Entra 認証はバックエンドのみです。"
        });
        return {
          token, webrtcUrl: transport === "webrtc" ? realtimeUrl : undefined,
          websocketUrl: transport === "websocket" ? realtimeUrl : undefined, info,
          connectFrame: transport === "websocket" ? {
            type: "connect", url: realtimeUrl, token,
            ...(request.sameOrigin ? { access_key: request.accessKey } : {})
          } : undefined
        };
      } catch (error) {
        throw new Error(safe(error?.message || String(error)));
      }
    }
    return { getSession, safe };
  }

  class ExperimentRecorder {
    constructor(now = () => performance.now()) {
      this.now = now;
      this.startedAt = now();
      this.startedUtc = new Date().toISOString();
      this.inputs = new Map();
      this.outputs = new Map();
      this.counts = {};
      this.events = [];
      this.audioBytes = 0;
      this.errors = [];
      this.session = null;
    }

    record(event) {
      const at = Math.round(this.now() - this.startedAt);
      const type = event.type;
      this.counts[type] = (this.counts[type] || 0) + 1;
      const isAudio = ["response.output_audio.delta", "response.audio.delta"].includes(type);
      if (isAudio) {
        this.audioBytes += Math.floor(event.delta.length * 3 / 4) -
          (event.delta.endsWith("==") ? 2 : event.delta.endsWith("=") ? 1 : 0);
      } else {
        this.events.push({ atMs: at, ...redact(event) });
        if (this.events.length > 500) this.events.shift();
      }
      if (type === "session.updated") this.session = redact(event.session);
      if (type === "error" || type.endsWith("input_audio_transcription.failed")) {
        this.errors.push(redact(event));
      }
      if (type === "input_audio_buffer.speech_stopped" || type === "input_audio_buffer.committed") {
        for (const row of this.inputs.values()) {
          if (row.itemId === event.item_id) row.committedAtMs ??= at;
        }
        const key = `${event.item_id}:0`;
        if (!this.inputs.has(key)) this.inputs.set(key, {
          itemId: event.item_id, contentIndex: 0, text: "", status: "pending", committedAtMs: at
        });
      }
      if (type.startsWith("conversation.item.input_audio_transcription.")) {
        const key = `${event.item_id}:${event.content_index ?? 0}`;
        const row = this.inputs.get(key) || {
          itemId: event.item_id, contentIndex: event.content_index ?? 0, text: "", status: "pending"
        };
        if (type.endsWith(".delta") && row.status === "pending") {
          row.firstAtMs ??= at;
          row.text += event.delta;
        } else if (type.endsWith(".completed")) {
          row.firstAtMs ??= at;
          row.finalAtMs = at;
          row.text = event.transcript;
          row.status = "completed";
        } else if (type.endsWith(".failed")) {
          row.finalAtMs = at;
          row.status = "failed";
          row.error = redact(event.error);
        }
        this.inputs.set(key, row);
      }
      if (/^response\.(output_audio_transcript|audio_transcript)\.(delta|done)$/.test(type)) {
        const key = `${event.response_id}:${event.item_id}:${event.content_index ?? 0}`;
        const row = this.outputs.get(key) || {
          responseId: event.response_id, itemId: event.item_id,
          contentIndex: event.content_index ?? 0, text: "", status: "pending", firstAtMs: at
        };
        if (type.endsWith(".done")) {
          row.text = event.transcript;
          row.finalAtMs = at;
          row.status = "completed";
        } else if (row.status === "pending") row.text += event.delta;
        this.outputs.set(key, row);
      }
      if (type === "response.done" && event.response?.status !== "completed") {
        this.errors.push(redact(event));
      }
    }

    finish() {
      this.finishedAt ??= this.now();
    }

    snapshot() {
      return {
        startedUtc: this.startedUtc,
        durationMs: Math.round((this.finishedAt ?? this.now()) - this.startedAt),
        stopped: this.finishedAt !== undefined,
        observedSession: this.session, eventCounts: { ...this.counts },
        outputAudioBytes: this.audioBytes,
        inputTranscripts: [...this.inputs.values()].map(row => ({
          ...row,
          firstAfterCommitMs: row.committedAtMs === undefined || row.firstAtMs === undefined
            ? null : row.firstAtMs - row.committedAtMs,
          finalAfterCommitMs: row.committedAtMs === undefined || row.finalAtMs === undefined
            ? null : row.finalAtMs - row.committedAtMs
        })),
        assistantTranscripts: [...this.outputs.values()].map(row => ({ ...row })),
        errors: [...this.errors], recentEvents: [...this.events]
      };
    }
  }

  const api = {
    DEFAULT_PRESET, CUSTOMER_PRESET: DEFAULT_PRESET, buildSessionUpdate, functionRequest,
    browserAccessRequest, createBrowserAccess, redact, ExperimentRecorder
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RealtimeExperiments = api;
})(globalThis);
