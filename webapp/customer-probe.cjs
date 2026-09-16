#!/usr/bin/env node
"use strict";

// Direct, non-browser diagnostic client. No proxy, cloud discovery, or deployments.
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const tls = require("node:tls");
const { WebSocket } = require("ws");
const { CUSTOMER_PRESET, buildSessionUpdate } = require("./realtime-experiments.js");

const RATE = 24000;
const MAX_HTTP_BYTES = 1024 * 1024;
const MAX_AUDIO_BYTES = RATE * 2 * 120;
const TRANSCRIPTION_MODELS = ["disabled", "whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"];
const REFERENCES = {
  websocket: "https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-websockets",
  ephemeral: "https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-webrtc",
  speech: "https://learn.microsoft.com/azure/foundry/openai/reference-preview-latest#create-speech",
};
const HELP = `Direct customer Realtime probe (Node >=22; no browser, WebRTC, or relay)

node customer-probe.cjs <command> [options]
  inspect               Mint credentials; verify WS Upgrade + session.created/updated.
  audio | transcribe    Send a local spoken WAV; await input transcript AND response.done.
  auth-matrix           Compare ephemeral Bearer, supplied Entra Bearer, and API key.
  transcribe-matrix     Same WAV: disabled, whisper-1, mini-transcribe, transcribe, custom.
  reconnect             Deliberately drop one connection; mint fresh token and reconnect.
  soak                  Bounded idle session/concurrency observation (explicit opt-in).
  network               DNS and TLS to exactly one configured AOAI host, TCP 443.
  tts                   Separate opt-in coral MP3 speech request (not a Realtime token).
  openai                Direct OpenAI control: audio if --wav, otherwise inspect.

Options (credentials ONLY in environment, never command-line arguments):
  --wav PATH                 PCM16 little-endian mono WAV, 16000 or 24000 Hz, <=30 s.
  --report PATH              Redacted JSON report (new file; never overwrites).
  --output-wav PATH          Save assistant PCM24k as WAV (single audio run only).
  --auth ephemeral|entra|api-key   Default ephemeral; no silent auth fallback.
  --transcription MODEL      Default gpt-4o-mini-transcribe; "disabled" uses null.
  --custom-transcription NAME     Additional deployment/model in transcription matrix.
  --voice NAME               session.update output voice; default coral.
  --token-voice NAME         Function mint voice; default coral; compare in report.
  --instructions TEXT       session.update instructions (default brief Japanese reply).
  --token-instructions TEXT Function mint instructions (default same as update).
  --manual-commit            Disable VAD explicitly; nonempty commit + response.create.
                            Default exact customer server_vad + 800ms silence padding.
  --omit-session-model       Conventional update baseline: omit immutable model field.
                            Default includes model ONLY to test the exact customer
                            payload experimentally. Model is selected in the WS URL.
                            A model-field rejection never triggers silent fallback.
  --timeout-ms N            1000..120000; default 60000 per session.
  --auth-retries N          0..2; default 1; ONLY ephemeral HTTP 401/403 retries.
  --reuse-token             Additional same-token reconnect experiment, opt-in only.
  --allow-load --seconds N --concurrency N
                            soak only: 1..3600 seconds, 1..4 connections.
  --tts-auth entra|api-key   Required for normal tts; independent credentials.
  --text TEXT               tts text, <=500 chars; default short Japanese greeting.
  --output-mp3 PATH          Optional speech output (new file).
  --negative-ephemeral      tts ONLY: deliberately test a minted ephemeral Bearer.
  --help

Environment:
  PROBE_FUNCTION_URL        Full HTTPS .../api/realtime-access; pasted ?code= normalized.
  PROBE_FUNCTION_KEY        Sent as x-functions-key, never forwarded to AOAI.
  AOAI_ENDPOINT             Actual AOAI resource HTTPS origin (NOT Function hostname).
  AOAI_REALTIME_DEPLOYMENT  Deployment name, not necessarily the base model name.
  PROBE_ENTRA_TOKEN         Separately acquired AOAI-audience Entra access token.
  AOAI_API_KEY              Separately supplied AOAI API key, for --auth api-key.
  OPENAI_BASE_URL           Default https://api.openai.com/v1 (OpenAI control only).
  OPENAI_MODEL              Default gpt-realtime (OpenAI control only).
  OPENAI_API_KEY            OpenAI control Bearer API key.
  TTS_AOAI_ENDPOINT, TTS_DEPLOYMENT, TTS_API_KEY, TTS_ENTRA_TOKEN
                            Separate explicit TTS configuration; NO realtime fallback.

Examples (PowerShell; set credentials securely in the environment):
  node .\\customer-probe.cjs inspect --report .\\inspect.json
  node .\\customer-probe.cjs audio --wav .\\question-ja.wav --output-wav .\\reply.wav
  node .\\customer-probe.cjs audio --auth entra --wav .\\question-ja.wav --report .\\entra.json
  node .\\customer-probe.cjs transcribe-matrix --wav .\\question-ja.wav --report .\\matrix.json
  node .\\customer-probe.cjs transcribe-matrix --auth entra --omit-session-model --wav ..\\assets\\transcription-ja-16k.wav --report .\\sample-matrix.json
  node .\\customer-probe.cjs auth-matrix --report .\\auth.json
  node .\\customer-probe.cjs reconnect --reuse-token --report .\\reconnect.json
  node .\\customer-probe.cjs soak --allow-load --seconds 60 --concurrency 2
  node .\\customer-probe.cjs tts --tts-auth api-key --output-mp3 .\\speech.mp3
  node .\\customer-probe.cjs openai --wav .\\question-ja.wav

Live calls incur usage. Only run with authorized endpoints and nonsensitive recordings.
Reports contain transcripts/instructions; review before sharing. Audio Base64 is summarized.
Expiry is issuer-reported, not a fixed two-hour promise. Regions and service limits remain
unverified. A short disabled-transcription observation does not prove permanent absence.
TTS uses /openai/v1/audio/speech?api-version=preview (official reference above).
`;

class ProbeError extends Error {
  constructor(message, category = "configuration", details = {}) {
    super(message);
    this.name = "ProbeError";
    this.category = category;
    Object.assign(this, details);
  }
}

function classifyError(error) {
  if (error.category) return error.category;
  const code = error.code || error.cause?.code || "";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return "tls";
  if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) return "tcp";
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code) || /Timeout|Abort/.test(error.name)) return "timeout";
  return "network-or-client";
}

class Redactor {
  constructor(secrets = []) { this.secrets = new Set(secrets.filter(s => typeof s === "string" && s)); }
  add(secret) { if (typeof secret === "string" && secret) this.secrets.add(secret); }
  discover(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(value|ephemeral_token|access_token|api[-_]?key|token|authorization|x-functions-key)$/i.test(key)) this.add(child);
      if (child && typeof child === "object") this.discover(child);
    }
  }
  text(text) {
    let safe = String(text);
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      safe = safe.split(secret).join("[REDACTED]");
      safe = safe.split(encodeURIComponent(secret)).join("[REDACTED]");
    }
    safe = safe.replace(/\bBearer\s+[^\s"',;<>]+/gi, "Bearer [REDACTED]");
    safe = safe.replace(/((?:authorization|api[-_]?key|x-functions-key|ephemeral_token|access_token|client_secret|value)\s*["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1[REDACTED]");
    return safe.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, candidate => {
      try {
        const url = new URL(candidate);
        if (url.username || url.password) { url.username = "REDACTED"; url.password = "REDACTED"; }
        for (const key of [...url.searchParams.keys()]) {
          if (!["model", "api-version"].includes(key)) url.searchParams.set(key, "[REDACTED]");
        }
        url.hash = "";
        return url.toString();
      } catch { return "[REDACTED URL]"; }
    });
  }
  clean(value, key = "") {
    if (/^(authorization|proxy-authorization|api[-_]?key|x-functions-key|cookie|set-cookie|ephemeral_token|access_token|refresh_token|client_secret|token|value)$/i.test(key)) {
      return value == null ? value : "[REDACTED]";
    }
    if (Buffer.isBuffer(value)) return { bytes: value.length };
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map(item => this.clean(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.clean(v, k)]));
    return value;
  }
}

function normalizeFunctionAccess(value, key, allowLocal = false) {
  let url;
  try { url = new URL(value); } catch { throw new ProbeError("PROBE_FUNCTION_URL must be an absolute HTTPS URL."); }
  if (url.username || url.password || url.hash ||
      (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:" && isLocal(url)))) {
    throw new ProbeError("Function URL must use HTTPS without credentials or fragment.");
  }
  const codes = url.searchParams.getAll("code");
  if (codes.length > 1 || (key && codes[0] && key !== codes[0])) throw new ProbeError("Conflicting Function keys; supply exactly one.");
  const functionKey = key || codes[0];
  // This endpoint accepts transport in the body. No Function query is ever forwarded.
  url.search = "";
  return { url: url.toString(), key: functionKey };
}

function isLocal(url) { return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); }
function azureHost(host) {
  return [".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com"].some(suffix => host.endsWith(suffix));
}
function validateRealtimeUrl(value, { provider = "azure", model, allowLocal = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new ProbeError("Missing or invalid upstream WebSocket URL."); }
  const local = allowLocal && isLocal(url);
  if ((url.protocol !== "wss:" && !(local && url.protocol === "ws:")) ||
      url.username || url.password || url.hash || (!local && url.port && url.port !== "443") ||
      url.hostname.endsWith(".azurewebsites.net") ||
      (provider === "azure" && !azureHost(url.hostname) && !local)) {
    throw new ProbeError("WebSocket target must be the actual AOAI host over WSS; never a Function host.");
  }
  const expectedPath = provider === "azure" ? "/openai/v1/realtime" : "/v1/realtime";
  if (url.pathname !== expectedPath || url.searchParams.getAll("model").length !== 1 ||
      !url.searchParams.get("model") || [...url.searchParams.keys()].some(k => k !== "model") ||
      (model && url.searchParams.get("model") !== model)) {
    throw new ProbeError("Expected Realtime v1 path and exactly one matching model deployment; no code/api-version/auth query.");
  }
  return url.toString();
}

function buildRealtimeUrl(endpoint, model, provider = "azure", allowLocal = false) {
  if (typeof model !== "string" || !model.trim()) throw new ProbeError("A Realtime deployment/model is required.");
  let base;
  try { base = new URL(endpoint); } catch { throw new ProbeError("An explicit model resource endpoint is required."); }
  const permittedPaths = provider === "azure" ? ["/", "/openai/v1", "/openai/v1/"] : ["/", "/v1", "/v1/"];
  if (!permittedPaths.includes(base.pathname) || base.search || base.hash ||
      (base.protocol !== "https:" && !(allowLocal && base.protocol === "http:" && isLocal(base)))) {
    throw new ProbeError("Model endpoint must be an HTTPS origin or v1 base URL, without query/fragment.");
  }
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = provider === "azure" ? "/openai/v1/realtime" : "/v1/realtime";
  base.searchParams.set("model", model);
  return validateRealtimeUrl(base, { provider, model, allowLocal });
}

function customerSession(model, { voice = CUSTOMER_PRESET.voice, instructions, transcription = CUSTOMER_PRESET.transcriptionModel, manualCommit = false, omitSessionModel = false } = {}) {
  const { session } = buildSessionUpdate({
    ...CUSTOMER_PRESET, voice, instructions,
    transcriptionModel: transcription === "disabled" ? "off" : transcription,
  });
  if (!omitSessionModel) session.model = model;
  if (!instructions) delete session.instructions;
  if (manualCommit) session.audio.input.turn_detection = null;
  return session;
}

function readWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WAVE" || buffer.readUInt32LE(4) + 8 !== buffer.length) {
    throw new ProbeError("Expected a complete RIFF/WAVE PCM16 file.");
  }
  let format, pcm, offset = 12;
  for (; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > buffer.length) throw new ProbeError("Truncated WAV chunk.");
    if (id === "fmt ") {
      if (format || length < 16) throw new ProbeError("Invalid WAV format chunk.");
      format = {
        encoding: buffer.readUInt16LE(offset + 8), channels: buffer.readUInt16LE(offset + 10),
        rate: buffer.readUInt32LE(offset + 12), byteRate: buffer.readUInt32LE(offset + 16),
        align: buffer.readUInt16LE(offset + 20), bits: buffer.readUInt16LE(offset + 22),
      };
    } else if (id === "data") {
      if (pcm) throw new ProbeError("Multiple WAV data chunks are not supported.");
      pcm = buffer.subarray(offset + 8, end);
    }
    offset = end + (length % 2);
  }
  if (offset !== buffer.length) throw new ProbeError("Incomplete WAV chunk header or padding.");
  if (!format || !pcm?.length || pcm.length % 2 || format.encoding !== 1 || format.channels !== 1 ||
      format.bits !== 16 || ![16000, RATE].includes(format.rate) || format.align !== 2 || format.byteRate !== format.rate * 2) {
    throw new ProbeError("WAV must be nonempty mono PCM16 little-endian, 16000 or 24000 Hz; stereo/float/compressed are rejected.");
  }
  if (pcm.length / (format.rate * 2) > 30) throw new ProbeError("WAV exceeds the bounded 30-second input limit.");
  return { pcm, rate: format.rate, durationMs: pcm.length / (format.rate * 2) * 1000 };
}

function resamplePcm16(pcm, sourceRate) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || ![16000, RATE].includes(sourceRate)) throw new ProbeError("Invalid PCM16 resampling input.");
  if (sourceRate === RATE) return Buffer.from(pcm);
  const count = pcm.length / 2;
  const output = Buffer.alloc(Math.round(count * RATE / sourceRate) * 2);
  for (let i = 0; i < output.length / 2; i++) {
    const position = i * sourceRate / RATE;
    const left = Math.min(Math.floor(position), count - 1);
    const right = Math.min(left + 1, count - 1);
    output.writeInt16LE(Math.round(pcm.readInt16LE(left * 2) * (1 - (position - left)) +
      pcm.readInt16LE(right * 2) * (position - left)), i * 2);
  }
  return output;
}

function makeWav(pcm, rate = RATE) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2) throw new ProbeError("Cannot encode odd-length PCM16.");
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function pcmDelta(value) {
  if (typeof value !== "string" || !value.length || value.length % 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ProbeError("Audio delta is not canonical Base64.", "event-contract");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length % 2 || bytes.toString("base64") !== value) throw new ProbeError("Audio delta is not whole PCM16 samples.", "event-contract");
  return bytes;
}

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const string = value => typeof value === "string";
const index = value => Number.isInteger(value) && value >= 0;
const nonempty = value => string(value) && value.length > 0;
function validateEvent(event) {
  const errors = [];
  const requireField = (condition, field) => { if (!condition) errors.push(field); };
  if (!object(event) || !nonempty(event.type)) return ["event.type"];
  const known = /^(session\.(created|updated)|input_audio_buffer\.(speech_started|speech_stopped|committed)|conversation\.item\.input_audio_transcription\.(delta|completed|failed)|response\.(created|done|output_audio\.(delta|done)|output_audio_transcript\.(delta|done))|error)$/.test(event.type);
  if (!known) return errors;
  requireField(nonempty(event.event_id), "event_id");
  if (event.type.startsWith("session.")) {
    requireField(object(event.session), "session");
    requireField(nonempty(event.session?.id), "session.id");
    requireField(event.session?.type === "realtime", "session.type");
  } else if (event.type.startsWith("input_audio_buffer.")) {
    requireField(nonempty(event.item_id), "item_id");
    if (event.type.endsWith("speech_started")) requireField(index(event.audio_start_ms), "audio_start_ms");
    if (event.type.endsWith("speech_stopped")) requireField(index(event.audio_end_ms), "audio_end_ms");
    if (event.type.endsWith("committed")) requireField(event.previous_item_id === null || string(event.previous_item_id), "previous_item_id");
  } else if (event.type.startsWith("conversation.item.input_audio_transcription.")) {
    requireField(nonempty(event.item_id), "item_id"); requireField(index(event.content_index), "content_index");
    if (event.type.endsWith(".delta")) requireField(string(event.delta), "delta");
    if (event.type.endsWith(".completed")) requireField(string(event.transcript), "transcript");
    if (event.type.endsWith(".failed")) {
      requireField(object(event.error) && string(event.error.message) && nonempty(event.error.code), "error.code/message");
    }
  } else if (event.type === "response.created" || event.type === "response.done") {
    requireField(object(event.response) && nonempty(event.response.id), "response.id");
    requireField(["in_progress", "completed", "cancelled", "failed", "incomplete"].includes(event.response?.status), "response.status");
    requireField(Array.isArray(event.response?.output), "response.output");
    for (const item of Array.isArray(event.response?.output) ? event.response.output : []) {
      requireField(object(item) && nonempty(item.id) && nonempty(item.type), "response.output item.id/type");
      if (item?.type === "message") {
        requireField(item.role === "assistant" && Array.isArray(item.content), "response.output message.role/content");
        for (const part of Array.isArray(item.content) ? item.content : []) {
          requireField(object(part) && nonempty(part.type), "response.output content.type");
          if (part?.type === "output_audio") requireField(string(part.transcript), "response.output content.transcript");
        }
      }
    }
    if (event.type === "response.done") requireField(event.response?.status !== "in_progress", "response.done terminal status");
  } else if (event.type.startsWith("response.output_")) {
    for (const field of ["response_id", "item_id"]) requireField(nonempty(event[field]), field);
    for (const field of ["output_index", "content_index"]) requireField(index(event[field]), field);
    if (event.type === "response.output_audio.delta") {
      try { pcmDelta(event.delta); } catch (error) { errors.push(error.message); }
    }
    if (event.type === "response.output_audio_transcript.delta") requireField(string(event.delta), "delta");
    if (event.type === "response.output_audio_transcript.done") requireField(string(event.transcript), "transcript");
  } else if (event.type === "error") {
    requireField(object(event.error) && nonempty(event.error.type) && string(event.error.message), "error.type/message");
    requireField(event.error?.code == null || string(event.error.code), "error.code");
    requireField(event.error?.param == null || string(event.error.param), "error.param");
  }
  return errors;
}

function configurationDifferences(expected, actual, path = "session") {
  const differences = [];
  for (const [key, value] of Object.entries(expected)) {
    if (path === "session" && key === "model") continue; // Deployment aliases may resolve to a base model name.
    const observed = actual?.[key];
    if (value === null && observed == null) continue;
    if (object(value)) differences.push(...configurationDifferences(value, observed, `${path}.${key}`));
    else if (JSON.stringify(value) !== JSON.stringify(observed)) differences.push({ field: `${path}.${key}`, expected: value, observed: observed ?? null });
  }
  return differences;
}

class EventCollector {
  constructor({ transcription = CUSTOMER_PRESET.transcriptionModel, now = Date.now, redactor = new Redactor() } = {}) {
    this.now = now; this.started = now(); this.redactor = redactor; this.transcription = transcription;
    this.inputs = new Map(); this.expectedItems = new Set(); this.activeSpeech = new Set(); this.responses = new Map(); this.assistant = new Map();
    this.audio = []; this.audioBytes = 0; this.audioChunks = 0; this.audioDone = 0; this.lastRelevant = now();
    this.events = []; this.counts = {}; this.issues = []; this.failures = []; this.uploadStarted = null; this.textBytes = 0;
  }
  accept(event) {
    const issues = validateEvent(event);
    this.counts[event?.type || "invalid"] = (this.counts[event?.type || "invalid"] || 0) + 1;
    if (issues.length) {
      this.issues.push({ type: event?.type, fields: issues });
      throw new ProbeError("Server event does not match the expected JSON contract.", "event-contract", { fields: issues });
    }
    const elapsedMs = this.now() - (this.uploadStarted ?? this.started);
    this.textBytes += event.type === "response.output_audio.delta" ? 0 : Buffer.byteLength(JSON.stringify(event));
    if (this.textBytes > 4 * MAX_HTTP_BYTES) throw new ProbeError("Event text exceeded bounded memory limit.", "workload-limit");
    const stored = event.type === "response.output_audio.delta"
      ? { ...event, delta: { encoding: "base64", bytes: Buffer.from(event.delta, "base64").length } } : event;
    if (this.events.length < 1000) this.events.push({ elapsedMs, event: this.redactor.clean(stored) });
    if (event.type === "session.created") this.created = event.session;
    if (event.type === "session.updated") this.updated = event.session;
    if (["input_audio_buffer.committed", "input_audio_buffer.speech_stopped", "input_audio_buffer.speech_started"].includes(event.type)) this.expectedItems.add(event.item_id);
    if (event.type === "input_audio_buffer.speech_started") this.activeSpeech.add(event.item_id);
    if (event.type === "input_audio_buffer.speech_stopped") this.activeSpeech.delete(event.item_id);
    if (event.type.startsWith("conversation.item.input_audio_transcription.")) {
      const key = JSON.stringify([event.item_id, event.content_index]);
      const entry = this.inputs.get(key) || { item_id: event.item_id, content_index: event.content_index, delta: "", firstLatencyMs: elapsedMs, status: "pending" };
      if (event.type.endsWith(".delta")) entry.delta += event.delta;
      if (event.type.endsWith(".completed")) Object.assign(entry, { transcript: event.transcript, status: "completed", finalLatencyMs: elapsedMs });
      if (event.type.endsWith(".failed")) {
        Object.assign(entry, { error: event.error, status: "failed", finalLatencyMs: elapsedMs });
        this.failures.push({ type: event.type, error: event.error });
      }
      this.inputs.set(key, entry);
    }
    if (["response.created", "response.done"].includes(event.type)) {
      this.responses.set(event.response.id, event.response);
      if (event.type === "response.done") this.responseFinalLatencyMs = elapsedMs;
      if (event.type === "response.done" && event.response.status !== "completed") this.failures.push({ type: event.type, response: event.response });
    }
    if (event.type.startsWith("response.output_audio_transcript.")) {
      const key = JSON.stringify([event.response_id, event.item_id, event.content_index]);
      const entry = this.assistant.get(key) || { response_id: event.response_id, item_id: event.item_id, content_index: event.content_index, delta: "", firstLatencyMs: elapsedMs };
      if (event.type.endsWith(".delta")) entry.delta += event.delta;
      else Object.assign(entry, { transcript: event.transcript, finalLatencyMs: elapsedMs });
      this.assistant.set(key, entry);
    }
    if (event.type === "response.output_audio.delta") {
      const pcm = pcmDelta(event.delta);
      if (this.audioBytes + pcm.length > MAX_AUDIO_BYTES) throw new ProbeError("Output exceeded bounded audio memory limit.", "workload-limit");
      this.audio.push(pcm); this.audioBytes += pcm.length; this.audioChunks++;
      this.firstAudioLatencyMs ??= elapsedMs;
    }
    if (event.type === "response.output_audio.done") { this.audioDone++; this.audioFinalLatencyMs = elapsedMs; }
    if (event.type === "error") this.failures.push({ type: event.type, error: event.error });
    if (!event.type.startsWith("session.") && event.type !== "rate_limits.updated") this.lastRelevant = this.now();
  }
  complete() {
    if (this.activeSpeech.size || !this.responses.size || [...this.responses.values()].some(r => r.status === "in_progress")) return false;
    if (this.transcription === "disabled") return true;
    const inputs = [...this.inputs.values()];
    if (!inputs.length || inputs.some(input => input.status === "pending")) return false;
    return [...this.expectedItems].every(id => inputs.some(input => input.item_id === id && ["completed", "failed"].includes(input.status)));
  }
  outcomes() {
    const inputs = [...this.inputs.values()];
    const responses = [...this.responses.values()];
    const missingInputItems = [...this.expectedItems].filter(id => !inputs.some(input => input.item_id === id && ["completed", "failed"].includes(input.status)));
    const responseCompleted = responses.length > 0 && responses.every(response => response.status === "completed");
    return {
      inputTranscription: this.transcription === "disabled" ? "not-requested"
        : inputs.some(input => input.status === "failed") ? "failed"
        : inputs.length && !missingInputItems.length && inputs.every(input => input.status === "completed") ? "completed"
        : "pending-or-unobserved",
      pendingInputItems: missingInputItems,
      assistantResponse: responseCompleted ? "completed"
        : responses.some(response => ["failed", "cancelled", "incomplete"].includes(response.status)) ? "failed-or-incomplete"
        : "pending-or-unobserved",
      assistantVoice: responseCompleted && this.audioChunks > 0 && this.audioDone > 0 ? "audio-and-completed-response-observed" : "not-fully-observed",
      note: "Input ASR failure is independent of assistant voice generation. Overall probe failure can coexist with successful assistant PCM audio and response.done; no physical playback/listening is verified.",
    };
  }
  evidence() {
    return {
      outcomes: this.outcomes(),
      eventCounts: this.counts, eventContracts: { checked: true, issues: this.issues },
      events: this.events, eventsTruncated: Object.values(this.counts).reduce((a, b) => a + b, 0) > this.events.length,
      sessionCreated: this.created, sessionUpdated: this.updated,
      inputTranscripts: [...this.inputs.values()], assistantTranscripts: [...this.assistant.values()],
      expectedInputItems: [...this.expectedItems], responses: [...this.responses.values()],
      audio: { chunks: this.audioChunks, bytes: this.audioBytes, doneEvents: this.audioDone, pcm16EvenBytes: this.audioBytes % 2 === 0, sampleRate: RATE, channels: 1, firstLatencyMs: this.firstAudioLatencyMs, finalLatencyMs: this.audioFinalLatencyMs },
      responseFinalLatencyMs: this.responseFinalLatencyMs,
      failures: this.failures, observationMs: this.now() - this.started,
      transcriptionObservation: this.transcription === "disabled"
        ? "No input transcription requested. Event counts cover ONLY this bounded observation; absence is not proven."
        : "Input deltas/completed/failed keyed by item_id + content_index, separate from assistant transcripts. Latencies measured from first audio append.",
    };
  }
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function boundedBody(response, maxBytes = MAX_HTTP_BYTES) {
  const chunks = []; let length = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw new ProbeError("HTTP response exceeded bounded size.", "http-body");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function issueToken(config, context, io = {}) {
  const normalized = normalizeFunctionAccess(config.functionUrl, config.functionKey, io.allowLocal);
  context.redactor.add(normalized.key);
  const headers = { "Content-Type": "application/json" };
  if (normalized.key) headers["x-functions-key"] = normalized.key;
  const body = { transport: "websocket", voice: config.tokenVoice, instructions: config.tokenInstructions };
  const evidence = { method: "POST", url: normalized.url, headers: context.redactor.clean(headers), body, status: null };
  context.report.tokenRequests.push(evidence);
  let response;
  try {
    response = await (io.fetch || fetch)(normalized.url, {
      method: "POST", headers, body: JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(config.timeoutMs),
    });
    evidence.status = response.status;
    evidence.responseHeaders = context.redactor.clean(Object.fromEntries(response.headers));
    const raw = await boundedBody(response);
    let parsed;
    try { parsed = JSON.parse(raw.toString("utf8")); } catch {
      evidence.response = context.redactor.text(raw.toString("utf8"));
      throw new ProbeError("Function returned non-JSON response.", "http-body", { status: response.status });
    }
    context.redactor.discover(parsed);
    evidence.response = context.redactor.clean(parsed);
    if (!response.ok) throw new ProbeError("Function token POST failed.", response.status === 401 || response.status === 403 ? "http-auth" : "http", { status: response.status });
    if (parsed.transport !== "websocket" || !nonempty(parsed.model) || !nonempty(parsed.ephemeral_token) ||
        !/^[\x21-\x7e]+$/.test(parsed.ephemeral_token)) throw new ProbeError("Function response missing valid websocket transport, model, or ephemeral_token.", "http-body");
    context.redactor.add(parsed.ephemeral_token);
    const url = validateRealtimeUrl(parsed.websocket_url || parsed.realtime_url, { model: parsed.model, allowLocal: io.allowLocal });
    if (parsed.websocket_url && parsed.realtime_url && parsed.websocket_url !== parsed.realtime_url) throw new ProbeError("Function response contains conflicting Realtime URLs.", "http-body");
    if (config.endpoint && buildRealtimeUrl(config.endpoint, config.model || parsed.model, "azure", io.allowLocal) !== url) throw new ProbeError("Function AOAI endpoint/deployment differs from explicit client configuration.");
    const rawExpiry = parsed.expires_at ?? parsed.session?.expires_at ?? parsed.session?.client_secret?.expires_at ?? null;
    const expiry = typeof rawExpiry === "number" && Number.isFinite(rawExpiry) ? rawExpiry : null;
    const credential = {
      kind: "ephemeral", url, model: parsed.model, token: parsed.ephemeral_token,
      headers: { Authorization: `Bearer ${parsed.ephemeral_token}` },
      expiry: { reported: rawExpiry, unixSeconds: expiry, remainingSecondsAtReceipt: expiry == null ? null : Math.floor(expiry - Date.now() / 1000), source: "Function/upstream client_secrets response; not decoded from token" },
      issuer: `${new URL(url).origin.replace(/^wss:/, "https:")}/openai/v1/realtime/client_secrets`,
      issuerVerification: "Inferred from Function contract; upstream mint authentication is not independently visible to this client.",
    };
    context.endpointHint = url;
    return credential;
  } catch (error) {
    evidence.error = errorEvidence(error, context.redactor);
    throw error;
  }
}

function credentialSummary(credential) {
  return { kind: credential.kind, websocketUrl: credential.url, model: credential.model, headers: Object.keys(credential.headers), expiry: credential.expiry,
    issuer: credential.issuer, issuerVerification: credential.issuerVerification,
    typeEvidence: credential.kind === "ephemeral" ? "Function client_secrets contract; NOT an Entra token or an API key. Never inferred from token spelling."
      : "Credential type explicitly selected by caller; token contents not inspected." };
}
function errorEvidence(error, redactor) {
  return { category: classifyError(error), message: redactor.text(error.message || "Probe failed"), status: error.status ?? null,
    networkCode: /^[A-Z_0-9]+$/.test(error.code || error.cause?.code || "") ? error.code || error.cause?.code : null };
}

async function acquireCredential(kind, config, context, io = {}) {
  if (kind === "ephemeral") return issueToken(config, context, io);
  const openai = config.provider === "openai";
  const token = openai ? config.openaiKey : kind === "entra" ? config.entraToken : config.apiKey;
  if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new ProbeError(`Missing/invalid ${openai ? "OPENAI_API_KEY" : kind === "entra" ? "PROBE_ENTRA_TOKEN" : "AOAI_API_KEY"}.`);
  context.redactor.add(token);
  const url = !openai && context.endpointHint && !config.endpoint ? context.endpointHint
    : buildRealtimeUrl(config.endpoint, config.model, config.provider, io.allowLocal);
  return { kind: openai ? "openai-api-key" : kind, url, model: new URL(url).searchParams.get("model"), token,
    headers: kind === "api-key" && !openai ? { "api-key": token } : { Authorization: `Bearer ${token}` } };
}

async function runSession(credential, config, context, io = {}) {
  const collector = new EventCollector({ transcription: config.transcription, redactor: context.redactor });
  const requested = customerSession(credential.model, config);
  const report = {
    startedAt: new Date().toISOString(), auth: credentialSummary(credential), requestedSession: requested,
    modelFieldExperiment: {
      mode: config.omitSessionModel ? "conventional-update-model-omitted" : "exact-customer-update-model-included-experimental",
      note: "The WebSocket URL selects the deployment. The session model is immutable; normal session.update omits it. Inclusion is an explicit customer-payload experiment, not a recommendation or model switch. Rejection never triggers automatic fallback.",
    },
    handshake: { status: null, upgraded: false }, status: "running",
  };
  let socket, settled = false, configured = false, updateSent = false, uploadFinished = false, configuredAt, quietTimer, deadline;
  let uploadedBytes = 0;
  const wait = io.sleep || sleep;
  return new Promise(resolve => {
    const finish = (error, detail) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearInterval(quietTimer);
      report.finishedAt = new Date().toISOString();
      report.status = error ? "failed" : collector.failures.length ? "failed" : "passed";
      if (error) report.error = errorEvidence(error, context.redactor);
      if (detail) report.detail = detail;
      report.upload = { bytes: uploadedBytes, finished: uploadFinished, mode: config.manualCommit ? "explicit nonempty commit" : "server_vad with 300ms leading/800ms trailing silence", sampleRate: RATE };
      Object.assign(report, collector.evidence());
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      resolve({ report: context.redactor.clean(report), pcm: Buffer.concat(collector.audio), credential });
    };
    deadline = setTimeout(() => finish(new ProbeError("Bounded session deadline reached; requested transcript/response or readiness was not fully observed.", "timeout")), config.timeoutMs + (config.holdMs || 0));
    const send = event => {
      if (settled || socket.readyState !== WebSocket.OPEN) throw new ProbeError("WebSocket dropped during send.", "websocket-close");
      if (socket.bufferedAmount > MAX_HTTP_BYTES) throw new ProbeError("WebSocket send backlog exceeded limit.", "workload-limit");
      socket.send(JSON.stringify(event));
    };
    const sendAudio = async () => {
      try {
        const pcm = config.pcm;
        if (!pcm?.length || pcm.length % 2) throw new ProbeError("Refusing empty or malformed audio; no empty commit is sent.");
        const audio = config.manualCommit ? pcm : Buffer.concat([Buffer.alloc(RATE * 2 * 0.3), pcm, Buffer.alloc(RATE * 2 * 0.8)]);
        collector.uploadStarted = collector.now();
        for (let offset = 0; offset < audio.length; offset += 4800) {
          if (settled) return;
          const chunk = audio.subarray(offset, offset + 4800);
          send({ type: "input_audio_buffer.append", audio: chunk.toString("base64") });
          uploadedBytes += chunk.length;
          await wait(chunk.length / (RATE * 2) * 1000);
        }
        if (settled) return;
        uploadFinished = true;
        collector.lastRelevant = collector.now();
        if (config.manualCommit) {
          send({ type: "input_audio_buffer.commit" });
          send({ type: "response.create", response: { output_modalities: ["audio"], max_output_tokens: 512 } });
        }
      } catch (error) { finish(error); }
    };
    try {
      socket = (io.connect || ((url, options) => new WebSocket(url, options)))(credential.url, {
        headers: credential.headers, handshakeTimeout: Math.min(config.timeoutMs, 15000),
        maxPayload: MAX_HTTP_BYTES, followRedirects: false, perMessageDeflate: false,
      });
      socket.on("upgrade", response => {
        report.handshake = { status: response.statusCode, upgraded: response.statusCode === 101, responseHeaders: context.redactor.clean(response.headers) };
      });
      socket.on("unexpected-response", (_, response) => {
        report.handshake = { status: response.statusCode, upgraded: false, responseHeaders: context.redactor.clean(response.headers) };
        response.resume();
        finish(new ProbeError("WebSocket Upgrade rejected.", [401, 403].includes(response.statusCode) ? "websocket-auth" : "http-upgrade", { status: response.statusCode }));
      });
      socket.on("error", error => finish(error));
      socket.on("close", code => finish(new ProbeError(`WebSocket closed before probe completed (${code}).`, "websocket-close")));
      socket.on("message", (raw, binary) => {
        if (settled) return;
        try {
          if (binary) throw new ProbeError("Expected JSON text WebSocket event, received binary frame.", "event-contract");
          let event;
          try { event = JSON.parse(raw.toString()); } catch { throw new ProbeError("Expected valid JSON WebSocket event.", "event-contract"); }
          collector.accept(event);
          if (event.type === "error") {
            const authFailure = ["invalid_api_key", "authentication_error", "invalid_token", "token_expired"].includes(event.error.code);
            finish(new ProbeError("Realtime server returned an explicit error; no model/auth fallback attempted.",
              authFailure ? "websocket-auth" : "realtime-error", { status: authFailure ? 401 : null }));
          } else if (event.type === "session.created" && !updateSent) {
            updateSent = true;
            send({ type: "session.update", session: requested });
          } else if (event.type === "session.updated" && updateSent && !configured) {
            report.configurationDifferences = configurationDifferences(requested, event.session);
            if (report.configurationDifferences.length) throw new ProbeError("session.updated did not confirm the requested settings; see configurationDifferences.", "session-configuration");
            configured = true; configuredAt = Date.now();
            report.readyAt = new Date(configuredAt).toISOString();
            if (config.dropAfterReady) finish(null, "Client deliberately terminated the connection after session.updated; subsequent attempt is separate.");
            else if (config.pcm) void sendAudio();
            else if (!config.holdMs) finish();
          }
        } catch (error) { finish(error); }
      });
      quietTimer = setInterval(() => {
        if (!configured || settled) return;
        if (config.holdMs && Date.now() - configuredAt >= config.holdMs) {
          finish(null, `Observed one idle connection for ${config.holdMs}ms; not an expiry or service-limit guarantee.`);
        } else if (uploadFinished && collector.complete() && Date.now() - collector.lastRelevant >= (io.quietMs ?? 1200)) {
          if (!collector.audioChunks || !collector.audioDone) finish(new ProbeError("Response completed without requested output audio delta/done evidence.", "audio-output"));
          else finish();
        }
      }, io.pollMs ?? 50);
    } catch (error) { finish(error); }
  });
}

async function runWithAuth(kind, config, context, io = {}, fixedCredential) {
  const attempts = [];
  const retries = fixedCredential || kind !== "ephemeral" ? 0 : config.authRetries;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let result;
    try {
      const credential = fixedCredential || await acquireCredential(kind, config, context, io);
      result = await runSession(credential, config, context, io);
    } catch (error) { result = { report: { status: "failed", error: errorEvidence(error, context.redactor) } }; }
    attempts.push(result.report);
    if (![401, 403].includes(result.report.error?.status) || attempt === retries) return { ...result, attempts };
    await (io.sleep || sleep)(Math.min(250 * (attempt + 1), 1000));
  }
}

function integerOption(value, fallback, min, max, name) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new ProbeError(`${name} must be an integer from ${min} to ${max}.`);
  return result;
}

function parseArgs(argv) {
  const flags = new Set(["help", "manual-commit", "omit-session-model", "reuse-token", "allow-load", "negative-ephemeral"]);
  const valued = new Set(["wav", "report", "output-wav", "auth", "transcription", "custom-transcription", "voice", "token-voice",
    "instructions", "token-instructions", "timeout-ms", "auth-retries", "seconds", "concurrency", "tts-auth", "text", "output-mp3"]);
  const result = { command: "inspect" };
  if (argv[0] && !argv[0].startsWith("-")) result.command = argv.shift();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || (!flags.has(key) && !valued.has(key))) throw new ProbeError("Unknown option. Use --help; credentials are accepted only through environment variables.");
    if (key in result) throw new ProbeError(`Duplicate --${key}.`);
    if (flags.has(key)) result[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new ProbeError(`Missing value for --${key}.`);
      result[key] = argv[++i];
    }
  }
  return result;
}

function loadConfig(args, env) {
  const commands = ["inspect", "audio", "transcribe", "auth-matrix", "transcribe-matrix", "reconnect", "soak", "tts", "network", "openai"];
  if (!commands.includes(args.command)) throw new ProbeError("Unknown command; use --help.");
  const provider = args.command === "openai" ? "openai" : "azure";
  const instructions = args.instructions ?? "日本語で短く一文で返答してください。";
  const config = {
    ...args, provider, auth: provider === "openai" ? "api-key" : args.auth || "ephemeral",
    functionUrl: env.PROBE_FUNCTION_URL, functionKey: env.PROBE_FUNCTION_KEY,
    endpoint: provider === "openai" ? env.OPENAI_BASE_URL || "https://api.openai.com/v1" : env.AOAI_ENDPOINT,
    model: provider === "openai" ? env.OPENAI_MODEL || "gpt-realtime" : env.AOAI_REALTIME_DEPLOYMENT,
    apiKey: env.AOAI_API_KEY, entraToken: env.PROBE_ENTRA_TOKEN, openaiKey: env.OPENAI_API_KEY,
    voice: args.voice || CUSTOMER_PRESET.voice, tokenVoice: args["token-voice"] || CUSTOMER_PRESET.voice, instructions,
    tokenInstructions: args["token-instructions"] ?? instructions,
    transcription: args.transcription?.trim() === "off" ? "disabled" : args.transcription?.trim() || CUSTOMER_PRESET.transcriptionModel,
    manualCommit: !!args["manual-commit"],
    omitSessionModel: !!args["omit-session-model"],
    timeoutMs: integerOption(args["timeout-ms"], 60000, 1000, 120000, "--timeout-ms"),
    authRetries: integerOption(args["auth-retries"], 1, 0, 2, "--auth-retries"),
    ttsEndpoint: env.TTS_AOAI_ENDPOINT, ttsDeployment: env.TTS_DEPLOYMENT, ttsApiKey: env.TTS_API_KEY, ttsEntraToken: env.TTS_ENTRA_TOKEN,
  };
  if (!["ephemeral", "entra", "api-key"].includes(config.auth)) throw new ProbeError("--auth must be ephemeral, entra, or api-key.");
  if (args["reuse-token"] && args.command !== "reconnect") throw new ProbeError("--reuse-token is only valid with reconnect.");
  if (args["negative-ephemeral"] && args.command !== "tts") throw new ProbeError("--negative-ephemeral is only valid with tts.");
  if (["audio", "transcribe", "transcribe-matrix"].includes(args.command) && !args.wav) throw new ProbeError("A local spoken --wav is required.");
  if (args.wav && !["audio", "transcribe", "transcribe-matrix", "openai"].includes(args.command)) throw new ProbeError("--wav requires audio, transcribe, transcribe-matrix, or openai; it is never silently ignored.");
  if (args.command === "reconnect" && config.auth !== "ephemeral") throw new ProbeError("reconnect verifies Function-issued fresh ephemeral tokens; use --auth ephemeral.");
  if (args["output-wav"] && !["audio", "transcribe", "openai"].includes(args.command)) throw new ProbeError("--output-wav is only valid for a single audio run.");
  if (args["output-wav"] && !args.wav) throw new ProbeError("--output-wav requires --wav input.");
  if (args["custom-transcription"] && args.command !== "transcribe-matrix") throw new ProbeError("--custom-transcription requires transcribe-matrix; use --transcription for a single model.");
  if (args.command !== "tts" && (args["tts-auth"] || args.text || args["output-mp3"])) throw new ProbeError("TTS options require the tts command.");
  if (args["negative-ephemeral"] && args["tts-auth"]) throw new ProbeError("Choose either --tts-auth or --negative-ephemeral, not both.");
  if (args.command === "soak") {
    if (!args["allow-load"] || args.seconds === undefined || args.concurrency === undefined) throw new ProbeError("soak requires explicit --allow-load --seconds N --concurrency N.");
    config.holdMs = integerOption(args.seconds, 0, 1, 3600, "--seconds") * 1000;
    config.concurrency = integerOption(args.concurrency, 1, 1, 4, "--concurrency");
  } else if (args.seconds !== undefined || args.concurrency !== undefined || args["allow-load"]) {
    throw new ProbeError("Load parameters are only accepted by soak.");
  }
  return config;
}

const QUESTION_TEXT = {
  Q1: "Token issuer/type: client_secrets ephemeral versus Entra versus API key",
  Q2: "Empirical ephemeral Bearer WS and independent Entra/API-key comparison",
  "Q2-1": "Actual AOAI WSS host + /openai/v1/realtime?model=deployment, no Function key/api-version",
  Q3: "Resource endpoint/deployment and actual model region (not Function region)",
  Q4: "Token POST body/header/status/response/error evidence",
  Q5: "Reported expiry, opt-in token reuse, fresh reconnect, bounded auth retries/session/concurrency",
  Q6: "Token voice/instructions versus observed session.updated settings",
  Q7: "Customer realtime audio PCM24k Japanese transcription/server_vad/coral payload",
  Q8: "Same-WAV transcription A/B including disabled, whisper-1, mini, full, custom",
  Q9: "Exact JSON event contracts, input versus assistant transcripts, audio output lifecycle",
  Q10: "Function x-functions-key header and normalized pasted code query",
  Q11: "Single-host DNS/TCP443/TLS/HTTP Upgrade diagnosis",
  Q12: "Separate TTS deployment/auth, coral MP3, explicit negative ephemeral probe only",
};
function createContext(config, env = {}) {
  const secrets = [config.functionKey, config.apiKey, config.entraToken, config.openaiKey, config.ttsApiKey, config.ttsEntraToken,
    ...Object.entries(env).filter(([k]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k)).map(([, v]) => v)];
  const redactor = new Redactor(secrets);
  if (config.functionUrl) {
    try { for (const [key, value] of new URL(config.functionUrl).searchParams) if (/code|key|token|secret/i.test(key)) redactor.add(value); } catch { /* Validation reports a safe error later. */ }
  }
  return {
    redactor, report: {
      schemaVersion: 1, command: config.command, startedAt: new Date().toISOString(),
      client: "Direct Node WebSocket; represents Jetson PCM16 16k -> 24k flow; no browser/relay/WebRTC",
      references: REFERENCES, tokenRequests: [], probes: [],
      questions: Object.fromEntries(Object.entries(QUESTION_TEXT).map(([key, question]) => [key, { question, status: "unverified", evidence: "Not exercised by this command." }])),
      limits: "All results are observations of this endpoint/deployment/time, not universal limits or guarantees. Unsupported settings remain explicit failures; no silent fallback or automatic deployment.",
    },
  };
}

async function networkProbe(config, io = {}) {
  const target = new URL(buildRealtimeUrl(config.endpoint, config.model || "network-check", "azure", io.allowLocal));
  const timeout = Math.min(config.timeoutMs, 15000);
  const result = { host: target.hostname, port: 443, checklist: [
    "Resolve only the model-resource hostname (not the Function host).",
    "Allow outbound TCP 443, TLS SNI and trusted certificate chain.",
    "Allow HTTP/1.1 Connection: Upgrade / Upgrade: websocket and long-lived traffic through proxies.",
    "Use inspect/auth-matrix for authenticated HTTP 101 + session readiness; TLS success alone is not WS success.",
    "This client uses direct sockets; it does not automatically configure a corporate HTTP proxy.",
  ] };
  let dnsTimer;
  try {
    result.addresses = await Promise.race([
      (io.lookup || dns.lookup)(target.hostname, { all: true }),
      new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new ProbeError("DNS deadline exceeded.", "dns")), timeout); }),
    ]);
  } finally { clearTimeout(dnsTimer); }
  result.tls = await new Promise((resolve, reject) => {
    const connection = (io.tlsConnect || tls.connect)({ host: target.hostname, servername: target.hostname, port: 443, rejectUnauthorized: true });
    const timer = setTimeout(() => { connection.destroy(); reject(new ProbeError("TCP/TLS deadline exceeded.", "timeout")); }, timeout);
    connection.once("secureConnect", () => {
      clearTimeout(timer);
      resolve({ authorized: connection.authorized, protocol: connection.getProtocol(), tcp443: "connected" });
      connection.destroy();
    });
    connection.once("error", error => { clearTimeout(timer); connection.destroy(); reject(error); });
  });
  result.websocket = "unverified: use inspect/auth-matrix";
  return result;
}

function ttsRequest(config, credential, io = {}) {
  const wsUrl = new URL(buildRealtimeUrl(config.ttsEndpoint, config.ttsDeployment, "azure", io.allowLocal));
  wsUrl.protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
  wsUrl.pathname = "/openai/v1/audio/speech"; wsUrl.search = "?api-version=preview";
  let token, headers, kind;
  if (config["negative-ephemeral"]) {
    if (credential?.kind !== "ephemeral") throw new ProbeError("Negative TTS probe requires a freshly minted Realtime ephemeral credential.");
    token = credential.token; headers = { Authorization: `Bearer ${token}` }; kind = "negative-realtime-ephemeral";
  } else {
    const auth = config["tts-auth"];
    if (!["entra", "api-key"].includes(auth)) throw new ProbeError("tts requires explicit --tts-auth entra|api-key and separate TTS credentials.");
    token = auth === "entra" ? config.ttsEntraToken : config.ttsApiKey;
    if (!token) throw new ProbeError("Missing separate TTS_ENTRA_TOKEN or TTS_API_KEY; Realtime credentials are never used automatically.");
    if (token === credential?.token || token === config.realtimeEphemeralToken) throw new ProbeError("Refusing accidental Realtime ephemeral token reuse for TTS.");
    headers = auth === "entra" ? { Authorization: `Bearer ${token}` } : { "api-key": token };
    kind = auth;
  }
  if (!/^[\x21-\x7e]+$/.test(token)) throw new ProbeError("Invalid TTS header credential.");
  const text = config.text ?? "こんにちは。音声の接続テストです。";
  if (!text.trim() || text.length > 500) throw new ProbeError("TTS text must contain 1..500 characters.");
  return { url: wsUrl.toString(), headers: { ...headers, "Content-Type": "application/json" },
    body: { model: config.ttsDeployment, input: text, voice: "coral", response_format: "mp3" }, kind };
}

async function runTts(config, context, io = {}) {
  const credential = config["negative-ephemeral"] ? await issueToken(config, context, io) : undefined;
  const request = ttsRequest(config, credential, io);
  const report = { kind: "tts", request: context.redactor.clean(request), status: "running" };
  context.report.probes.push(report);
  const response = await (io.fetch || fetch)(request.url, {
    method: "POST", headers: request.headers, body: JSON.stringify(request.body),
    redirect: "error", signal: AbortSignal.timeout(config.timeoutMs),
  });
  report.httpStatus = response.status; report.responseHeaders = context.redactor.clean(Object.fromEntries(response.headers));
  const body = await boundedBody(response, 5 * MAX_HTTP_BYTES);
  if (!response.ok) {
    let detail;
    try { detail = JSON.parse(body.toString()); } catch { detail = body.toString(); }
    report.error = context.redactor.clean(detail);
    report.status = config["negative-ephemeral"] && [401, 403].includes(response.status) ? "observed-rejection" : "failed";
    return;
  }
  const looksMp3 = body.length > 3 && (body.toString("ascii", 0, 3) === "ID3" || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0));
  report.audio = { bytes: body.length, mp3HeaderObserved: looksMp3, sha256: crypto.createHash("sha256").update(body).digest("hex") };
  report.status = looksMp3 ? "passed" : "failed";
  if (config["negative-ephemeral"]) report.interpretation = "Unexpected acceptance observed for this token/endpoint only; not assumed to be a supported general credential.";
  if (config["output-mp3"] && looksMp3) await (io.writeFile || fs.writeFile)(config["output-mp3"], body, { flag: "wx", mode: 0o600 });
}

function summarizeQuestions(context, config) {
  const { report } = context;
  const q = (key, status, evidence) => Object.assign(report.questions[key], { status, evidence });
  const sessions = report.probes.flatMap(p => p.attempts || []).filter(p => p.auth);
  const tokenCredentials = sessions.filter(s => s.auth.kind === "ephemeral");
  const errors = !!report.error || report.probes.flatMap(p => p.attempts || [p]).some(p => p.status === "failed");
  if (report.tokenRequests.length) {
    q("Q1", report.tokenRequests.some(r => r.status >= 200 && r.status < 300 && r.response?.ephemeral_token) ? "observed" : "unverified", { credential: tokenCredentials[0]?.auth ?? null, note: "Function client_secrets contract defines an ephemeral credential, not Entra/API key. Issuer credential used inside Function is not exposed. No token-prefix or JWT-type inference." });
    q("Q4", "observed", { tokenRequests: "tokenRequests[] includes sanitized request body/headers, HTTP status, response, and errors." });
    q("Q10", "observed", "Function query removed; code normalized to x-functions-key header, never AOAI query. All secrets redacted.");
  } else if (config.auth !== "ephemeral" || (config.command === "auth-matrix" && !config.functionUrl)) {
    const reason = "Skipped: direct caller-supplied credentials used; Function token issuer, POST contract and x-functions-key were not exercised.";
    q("Q1", "skipped", { reason, configuredCredentialKind: config.provider === "openai" ? "openai-api-key" : config.auth,
      note: "Credential provenance is explicitly selected by the caller, never inferred from token contents." });
    q("Q4", "skipped", reason);
    q("Q10", "skipped", reason);
  }
  if (report.probes.length) q("Q2", sessions.length ? "observed" : "unverified", { authModesAttempted: [...new Set(sessions.map(s => s.auth.kind))], note: "Compare auth-matrix outcomes; a skipped mode or one result is not proof of general support." });
  if (sessions.length) {
    q("Q2-1", "observed", { targets: [...new Set(sessions.map(s => s.auth.websocketUrl))], note: "Validated actual upstream v1 host/path/model before sending any WS credential." });
    q("Q3", "unverified", { endpointsAndDeployments: sessions.map(s => ({ url: s.auth.websocketUrl, deployment: s.auth.model, observedModel: s.sessionCreated?.model })), modelRegion: "unknown; never inferred from Function region or hostname" });
    q("Q5", "observed", { expiry: tokenCredentials.map(s => s.auth.expiry), command: config.command, maxAuthRetries: tokenCredentials.length ? config.authRetries : 0,
      reuse: config["reuse-token"] ? "Explicitly requested; see labeled reconnect probes." : "skipped: opt-in --reuse-token",
      longSession: config.command === "soak" ? "Bounded idle observation only; not service maximum, active audio longevity, or admission-token expiry." : "skipped: opt-in soak",
      note: tokenCredentials.length ? "Fresh credentials minted for reconnect and each bounded 401/403 retry. Expiry is not assumed to be two hours or session lifetime."
        : "Function mint/ephemeral expiry/reuse skipped. Supplied credential expiry is unknown and not decoded. Direct Entra/API-key authentication is not automatically refreshed or retried." });
    q("Q6", "observed", { tokenVoice: report.tokenRequests.length ? config.tokenVoice : null, tokenInstructions: report.tokenRequests.length ? config.tokenInstructions : null,
      mintComparison: report.tokenRequests.length ? "Compare Function mint body with sessionCreated/sessionUpdated." : "skipped: no Function mint in direct-auth mode",
      sessionVoice: config.voice, sessionInstructions: config.instructions, note: "Compare sessionCreated, requestedSession, sessionUpdated and configurationDifferences; voice cannot necessarily change after audio starts." });
    q("Q7", "observed", { payload: sessions[0].requestedSession, modelFieldExperiment: sessions[0].modelFieldExperiment,
      note: config.manualCommit ? "Explicit manual-commit override sets turn_detection=null; default preserves exact customer VAD." : "Customer PCM24k/ja/VAD/audio output settings; see separately labeled immutable-model-field experiment." });
    q("Q9", "observed", "Each attempt records structural contract issues, exact sanitized events, speech boundaries, per-item input completion/failure, separate assistant transcript, audio delta/done counts and response.done. Missing events remain visible.");
    q("Q11", "observed", "Inspect per-attempt handshake HTTP status and classified errors. TLS/Upgrade success is not proof of all network paths. Run network for a single-host DNS/TCP443/TLS checklist.");
  }
  if (config.command === "transcribe-matrix") q("Q8", "observed", { sameWav: report.input, models: report.probes.map(p => ({ model: p.label, status: p.status })),
    custom: config["custom-transcription"] ? "requested" : "skipped: no --custom-transcription provided",
    note: "No silent fallback. Model errors are deployment-specific evidence; no claim that a separate transcription deployment is mandatory. Disabled observation does not prove permanent absence." });
  else if (config.pcm) q("Q8", "observed", { model: config.transcription, comparison: "skipped: use transcribe-matrix for same-WAV A/B" });
  if (config.command === "network") q("Q11", errors ? "failed" : "observed", report.probes);
  if (config.command === "tts") q("Q12", errors ? "failed" : "observed", "Separate explicit TTS auth/deployment, coral MP3, v1 audio/speech?api-version=preview. Negative ephemeral mode requires explicit opt-in. Token type is caller-declared, never inferred from spelling.");
  else q("Q12", "skipped", "Optional tts command requires separate explicit TTS resource/deployment/auth; never reuse Realtime token automatically.");
}

async function execute(config, context = createContext(config), io = {}) {
  const report = context.report;
  const pushRun = async (label, kind, runConfig = config, fixed) => {
    const result = await runWithAuth(kind, runConfig, context, io, fixed);
    report.probes.push({ label, status: result.report.status, attempts: result.attempts });
    return result;
  };
  try {
    if (config.wav && ["audio", "transcribe", "transcribe-matrix", "openai"].includes(config.command)) {
      const file = await (io.readFile || fs.readFile)(config.wav);
      const wav = readWav(file);
      config = { ...config, pcm: resamplePcm16(wav.pcm, wav.rate) };
      report.input = { file: config.wav, sha256: crypto.createHash("sha256").update(file).digest("hex"), sourceRate: wav.rate,
        sourceChannels: 1, sourceBits: 16, wireRate: RATE, wireBytes: config.pcm.length, durationMs: wav.durationMs,
        resampler: wav.rate === RATE ? "identity" : "linear interpolation 16000 -> 24000; mono PCM16 little-endian" };
    }
    if (config.command === "network") {
      report.probes.push({ label: "single-host-network", status: "passed", evidence: await networkProbe(config, io) });
    } else if (config.command === "tts") {
      await runTts(config, context, io);
    } else if (config.command === "auth-matrix") {
      for (const kind of ["ephemeral", "entra", "api-key"]) {
        const available = kind === "ephemeral" ? config.functionUrl : kind === "entra" ? config.entraToken : config.apiKey;
        if (!available) report.probes.push({ label: kind, status: "skipped", reason: "Independent credentials/configuration not supplied." });
        else await pushRun(kind, kind);
      }
    } else if (config.command === "transcribe-matrix") {
      const models = [...new Set([...TRANSCRIPTION_MODELS, ...(config["custom-transcription"] ? [config["custom-transcription"]] : [])])];
      for (const transcription of models) await pushRun(transcription, config.auth, { ...config, transcription });
    } else if (config.command === "reconnect") {
      const initial = await pushRun("initial-deliberate-drop", "ephemeral", { ...config, dropAfterReady: true });
      if (initial.report.status !== "passed") {
        report.probes.push({ label: "fresh-token-reconnect", status: "skipped", reason: "Initial connection did not become ready; no dropped-session claim." });
      } else {
        if (config["reuse-token"]) await pushRun("opt-in-same-token-reuse", "ephemeral", config, initial.credential);
        const beforeMint = report.tokenRequests.length;
        const fresh = await pushRun("fresh-token-reconnect", "ephemeral");
        report.freshReconnect = { newMintRequest: report.tokenRequests.length > beforeMint, distinctTokenValueObserved: !!fresh.credential && fresh.credential.token !== initial.credential.token };
        if (fresh.credential && !report.freshReconnect.distinctTokenValueObserved) {
          report.probes.at(-1).status = "failed";
          report.freshReconnect.error = "Issuer returned the same token for a fresh mint request; token freshness not established.";
        }
      }
    } else if (config.command === "soak") {
      await Promise.all(Array.from({ length: config.concurrency }, (_, i) => pushRun(`bounded-idle-session-${i + 1}`, config.auth)));
      const intervals = report.probes.flatMap(p => p.attempts).filter(a => a.readyAt && a.finishedAt);
      const boundaries = intervals.flatMap(a => [[Date.parse(a.readyAt), 1], [Date.parse(a.finishedAt), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let active = 0, peak = 0;
      for (const [, change] of boundaries) { active += change; peak = Math.max(peak, active); }
      report.concurrency = { requested: config.concurrency, heldMs: config.holdMs, peakObservedReadyConnections: peak,
        observation: "Ready-to-finish timestamp overlap of these idle probes only; not proof of service concurrency limit or active audio longevity." };
    } else {
      const result = await pushRun(config.command, config.auth);
      if (config["output-wav"] && result.pcm?.length) {
        await (io.writeFile || fs.writeFile)(config["output-wav"], makeWav(result.pcm), { flag: "wx", mode: 0o600 });
      }
    }
  } catch (error) { report.error = errorEvidence(error, context.redactor); }
  summarizeQuestions(context, config);
  report.finishedAt = new Date().toISOString();
  report.status = report.error || report.probes.some(p => p.status === "failed") ? "failed"
    : report.probes.some(p => ["passed", "observed-rejection"].includes(p.status)) ? "completed" : "unverified";
  return context.redactor.clean(report);
}

async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  let context;
  try {
    const args = parseArgs([...argv]);
    if (args.help) { (io.stdout || console.log)(HELP); return 0; }
    const config = loadConfig(args, env);
    context = createContext(config, env);
    const report = await execute(config, context, io);
    if (args.report) await (io.writeFile || fs.writeFile)(args.report, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    (io.stdout || console.log)(JSON.stringify(report, null, 2));
    return report.status === "completed" ? 0 : 1;
  } catch (error) {
    const redactor = context?.redactor || new Redactor(Object.entries(env).filter(([k]) => /KEY|TOKEN|SECRET|PASSWORD|URL/i.test(k)).map(([, v]) => v));
    (io.stderr || console.error)(JSON.stringify({ status: "failed", error: errorEvidence(error, redactor) }));
    return 1;
  }
}

module.exports = {
  HELP, RATE, REFERENCES, TRANSCRIPTION_MODELS, ProbeError, Redactor, classifyError, normalizeFunctionAccess,
  validateRealtimeUrl, buildRealtimeUrl, customerSession, readWav, resamplePcm16, makeWav, pcmDelta, validateEvent,
  configurationDifferences, EventCollector, issueToken, acquireCredential, runSession, runWithAuth,
  parseArgs, loadConfig, createContext, execute, networkProbe, ttsRequest, main,
};
if (require.main === module) main().then(code => { process.exitCode = code; });
