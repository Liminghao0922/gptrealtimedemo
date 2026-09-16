const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setImmediate: nextTurn } = require("node:timers/promises");
const RealtimeExperiments = require("./realtime-experiments.js");

function browserHarness({
  functionUrl = "/api/realtime-access", demoKey = "demo-secret", functionKey = "",
  deferSessionUpdated = false
} = {}) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, disabled: false, textContent: "",
      listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      click() { this.listeners.click?.(); }, remove() {}
    });
    return elements.get(id);
  };
  const values = {
    functionUrl, demoKey, functionKey, voice: "coral", instructions: "Test",
    transcriptionModel: "gpt-4o-mini-transcribe", transcriptionLanguage: "ja",
    transcriptionPrompt: "", vadThreshold: "0.75", prefixPadding: "300", silenceDuration: "500"
  };
  for (const [id, value] of Object.entries(values)) getElement(id).value = value;
  for (const id of ["stopBtn", "responseBtn", "exportBtn"]) getElement(id).disabled = true;
  getElement("createResponse").checked = true;
  getElement("muteDuringPlayback").checked = true;
  const sent = [];
  const requests = [];
  let connection;
  let audio;
  let tracksStopped = 0;
  let exportedBlob;
  class MockURL extends URL {
    static createObjectURL(blob) { exportedBlob = blob; return "blob:test"; }
    static revokeObjectURL() {}
  }
  class MockSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() {
      connection = this;
      this.readyState = 0;
      queueMicrotask(() => { this.readyState = 1; this.onopen(); });
    }
    send(text) {
      const event = JSON.parse(text);
      sent.push(event);
      if (event.type === "connect") queueMicrotask(() => {
        this.emit({ type: "relay.ready" });
        this.emit({ type: "session.created", session: { id: "test-session" } });
      });
      if (event.type === "session.update" && !deferSessionUpdated) {
        queueMicrotask(() => this.emit({ type: "session.updated", session: event.session }));
      }
    }
    emit(event) { this.onmessage({ data: JSON.stringify(event) }); }
    close() {
      this.readyState = 3;
      this.onclose({ code: 1000, reason: "test" });
    }
  }
  class MockAudioContext {
    constructor() { audio = this; this.sampleRate = 24000; this.currentTime = 0; }
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      this.processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      return this.processor;
    }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    createBuffer(_, length, rate) {
      return { duration: length / rate, getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
      this.source = { connect() {}, start() {}, stop() {}, onended: null };
      return this.source;
    }
    async close() { this.closed = true; }
  }
  const context = vm.createContext({
    RealtimeExperiments, URL: MockURL, Blob, AbortSignal, performance, setTimeout, clearTimeout,
    atob, btoa, console,
    document: {
      getElementById: getElement,
      createElement: () => ({ click() {}, remove() {} }),
      body: { appendChild() {} }
    },
    window: { location: { href: "http://localhost:8000/gpt-realtime-websocket-demo.html" } },
    navigator: { mediaDevices: { getUserMedia: async () => ({
      getTracks: () => [{ stop() { tracksStopped++; } }]
    }) } },
    AudioContext: MockAudioContext, WebSocket: MockSocket,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({
        transport: "websocket", ephemeral_token: `test-token-${requests.length}`, model: "test",
        websocket_url: "wss://example.openai.azure.com/openai/v1/realtime?model=test"
      }) };
    }
  });
  const html = fs.readFileSync(path.join(__dirname, "gpt-realtime-websocket-demo.html"), "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  vm.runInContext(script, context);
  return {
    run: code => vm.runInContext(code, context), sent, requests, getElement,
    emit: event => connection.emit(event),
    audio: () => audio,
    capture: () => audio.processor.onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array([0, 0.5, -0.5]) }
    }),
    tracksStopped: () => tracksStopped,
    exported: () => exportedBlob.text()
  };
}

test("UI waits for session.updated; half-duplex gating covers response, playback tail, and manual pause", async () => {
  const ui = browserHarness();
  await ui.run("start()");
  assert.deepEqual(ui.sent.map(e => e.type), ["connect", "session.update"]);
  assert.equal(ui.getElement("settings").disabled, true);
  const appendCount = () => ui.sent.filter(e => e.type === "input_audio_buffer.append").length;
  ui.capture();
  assert.equal(appendCount(), 1);
  ui.emit({ type: "response.created", response: { id: "r", status: "in_progress" } });
  ui.capture();
  assert.equal(appendCount(), 1);
  ui.emit({ type: "response.output_audio.delta", delta: "AAAAAA==" });
  ui.emit({ type: "response.done", response: { id: "r", status: "completed" } });
  ui.capture();
  assert.equal(appendCount(), 1);
  ui.audio().source.onended();
  ui.audio().currentTime = 0.299;
  ui.capture();
  assert.equal(appendCount(), 1);
  ui.audio().currentTime = 0.301;
  ui.capture();
  assert.equal(appendCount(), 2);
  ui.getElement("pauseMicrophone").checked = true;
  ui.capture();
  assert.equal(appendCount(), 2);
  await ui.run("stop()");
  assert.equal(ui.tracksStopped(), 1);
  assert.equal(ui.audio().closed, true);
  assert.equal(ui.getElement("settings").disabled, false);
  assert.equal(ui.getElement("startBtn").disabled, false);
});

test("transcription failure stays visible without stopping speech; manual reconnect mints fresh token", async () => {
  const ui = browserHarness();
  await ui.run("start()");
  ui.emit({
    type: "conversation.item.input_audio_transcription.failed", item_id: "user", content_index: 0,
    error: { code: "DeploymentNotFound", message: "test" }
  });
  assert.match(ui.getElement("inputTranscript").textContent, /DeploymentNotFound/);
  assert.equal(ui.getElement("stopBtn").disabled, false);
  await ui.run("stop()");
  await ui.run("start()");
  assert.equal(ui.requests.length, 2);
  assert.deepEqual(ui.sent.filter(e => e.type === "connect").map(e => e.token), ["test-token-1", "test-token-2"]);
  assert.ok(!ui.getElement("events").textContent.includes("test-token"));
  await ui.run("stop()");
  await nextTurn();
});

test("disabled transcription does not show an input item as waiting for ASR", async () => {
  const ui = browserHarness();
  ui.getElement("transcriptionModel").value = "off";
  await ui.run("start()");
  ui.emit({ type: "input_audio_buffer.committed", item_id: "user" });
  assert.equal(ui.sent.find(e => e.type === "session.update").session.audio.input.transcription, null);
  assert.match(ui.getElement("inputTranscript").textContent, /\[disabled\]/);
  assert.doesNotMatch(ui.getElement("inputTranscript").textContent, /\[pending\]/);
  await ui.run("stop()");
});

test("same-origin API and first relay frame receive the Demo key, never a credential query", async () => {
  const ui = browserHarness({ functionKey: "unused-function-secret" });
  await ui.run("start()");
  assert.equal(ui.requests[0].url, "http://localhost:8000/api/realtime-access");
  assert.equal(ui.requests[0].options.headers["x-demo-key"], "demo-secret");
  assert.equal(ui.requests[0].options.headers["x-functions-key"], undefined);
  const connect = ui.sent[0];
  assert.deepEqual(connect, {
    type: "connect",
    url: "wss://example.openai.azure.com/openai/v1/realtime?model=test",
    token: "test-token-1", access_key: "demo-secret"
  });
  assert.doesNotMatch(connect.url + ui.requests[0].url, /demo-secret|test-token-1/);
  assert.doesNotMatch(ui.getElement("events").textContent, /demo-secret|test-token-1/);
  await ui.run("stop()");
});

test("external Function compatibility uses explicit Function key without relay access_key", async () => {
  const ui = browserHarness({
    functionUrl: "https://external.azurewebsites.net/api/realtime-access?code=function-secret"
  });
  await ui.run("start()");
  assert.equal(ui.requests[0].options.headers["x-functions-key"], "function-secret");
  assert.equal(ui.requests[0].options.headers["x-demo-key"], undefined);
  assert.equal(Object.hasOwn(ui.sent[0], "access_key"), false);
  assert.doesNotMatch(JSON.stringify(ui.sent), /demo-secret|function-secret/);
  assert.doesNotMatch(ui.getElement("functionUrl").value, /code=|function-secret/);
  await ui.run("stop()");
});

test("transcripts and settings export remain separate and redact echoed credentials after stopping", async () => {
  const ui = browserHarness();
  await ui.run("start()");
  ui.emit({ type: "input_audio_buffer.committed", item_id: "u" });
  ui.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "u", transcript: "日本語の入力 demo-secret"
  });
  ui.emit({
    type: "response.output_audio_transcript.done",
    response_id: "r", item_id: "a", transcript: "日本語の回答 test-token-1"
  });
  ui.emit({
    type: "error", error: {
      message: "demo-secret test-token-1", access_key: "demo-secret", "x-demo-key": "demo-secret"
    }
  });
  await ui.run("stop()");
  ui.getElement("exportBtn").click();
  const text = await ui.exported();
  const report = JSON.parse(text);
  assert.equal(report.stopped, true);
  assert.equal(report.inputTranscripts.length, 1);
  assert.equal(report.assistantTranscripts.length, 1);
  assert.match(report.inputTranscripts[0].text, /日本語の入力/);
  assert.match(report.assistantTranscripts[0].text, /日本語の回答/);
  assert.equal(report.requested.session.audio.input.transcription.language, "ja");
  assert.equal(report.connection.issuerPath, "/openai/v1/realtime/client_secrets");
  assert.doesNotMatch(text, /demo-secret|test-token-1/);
  for (const id of ["events", "inputTranscript", "outputTranscript", "sessionConfig"]) {
    assert.doesNotMatch(ui.getElement(id).textContent, /demo-secret|test-token-1/);
  }
});

test("generic preset restores Japanese GA settings without changing credentials", () => {
  const ui = browserHarness();
  ui.getElement("voice").value = "alloy";
  ui.getElement("vadThreshold").value = "0.5";
  ui.getElement("transcriptionModel").value = "off";
  ui.getElement("presetBtn").click();
  assert.equal(ui.getElement("voice").value, "coral");
  assert.equal(ui.getElement("vadThreshold").value, 0.75);
  assert.equal(ui.getElement("transcriptionModel").value, "gpt-4o-mini-transcribe");
  assert.equal(ui.getElement("transcriptionLanguage").value, "ja");
  assert.equal(ui.getElement("interruptResponse").checked, false);
  assert.equal(ui.getElement("muteDuringPlayback").checked, true);
  assert.equal(ui.getElement("demoKey").value, "demo-secret");
});

test("microphone upload cannot start before the server acknowledges session.update", async () => {
  const ui = browserHarness({ deferSessionUpdated: true });
  const starting = ui.run("start()");
  await nextTurn();
  assert.deepEqual(ui.sent.map(event => event.type), ["connect", "session.update"]);
  assert.equal(ui.audio().processor, undefined);
  assert.equal(ui.getElement("responseBtn").disabled, true);
  ui.emit({ type: "session.updated", session: ui.sent[1].session });
  await starting;
  assert.equal(typeof ui.audio().processor.onaudioprocess, "function");
  ui.capture();
  assert.equal(ui.sent.at(-1).type, "input_audio_buffer.append");
  await ui.run("stop()");
});
