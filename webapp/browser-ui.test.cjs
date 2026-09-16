const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setImmediate: nextTurn } = require("node:timers/promises");

const pages = [
  "gpt-realtime-livevoice-demo.html",
  "gpt-realtime_function_call_map.html",
  "gpt-realtime-websocket-demo.html"
];
const source = file => fs.readFileSync(path.join(__dirname, file), "utf8");
const normalize = value => JSON.parse(JSON.stringify(value));

function browserHarness(file, { error, response, sdpError } = {}) {
  const html = source(file);
  const elements = new Map();
  function element() {
    return {
      value: "", checked: false, disabled: false, textContent: "", srcObject: null,
      children: [], listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      appendChild(child) { this.children.push(child); },
      remove() { this.removed = true; },
      play: async () => {}
    };
  }
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  for (const match of html.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const item = getElement(match[1]);
    item.value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] || "";
    item.checked = /\bchecked\b/.test(match[0]);
  }
  for (const match of html.matchAll(/<textarea\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    getElement(match[1]).value = match[2];
  }
  for (const match of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>/g)];
    getElement(match[1]).value = (options.find(option => /\bselected\b/.test(option[0])) || options[0])[1];
  }
  const requests = [];
  const sent = [];
  const peers = [];
  const tracks = [];
  const consoleMessages = [];
  const body = element();
  class MockPeer {
    constructor() { this.connectionState = "new"; peers.push(this); }
    addTrack(track) { this.track = track; }
    createDataChannel() {
      this.channel = {
        ...element(),
        emit(type, payload = {}) {
          this.listeners[type]?.(payload);
          this[`on${type}`]?.(payload);
        },
        send(text) {
          const message = JSON.parse(text);
          sent.push(message);
          if (message.type === "session.update") queueMicrotask(() => this.emit("message", {
            data: JSON.stringify({ type: "session.updated", session: message.session })
          }));
        },
        close() { this.closed = true; this.emit("close"); }
      };
      return this.channel;
    }
    async createOffer() { return { type: "offer", sdp: "mock-offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription(answer) {
      this.answer = answer;
      this.connectionState = "connected";
      this.channel.emit("open");
    }
    close() { this.closed = true; }
  }
  const context = vm.createContext({
    URL, Blob, AbortSignal, performance, setTimeout, clearTimeout, queueMicrotask, atob, btoa,
    console: {
      log: (...args) => consoleMessages.push(args),
      error: (...args) => consoleMessages.push(args)
    },
    document: { getElementById: getElement, createElement: element, body },
    window: { location: { href: `https://demo.azurewebsites.net/${file}` } },
    navigator: { mediaDevices: { getUserMedia: async () => {
      const track = { kind: "audio", enabled: true, stop() { this.stopped = true; } };
      tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } },
    MediaStream: class { addTrack() {} },
    RTCPeerConnection: MockPeer,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (options.headers["Content-Type"] === "application/sdp") {
        return { ok: !sdpError, status: sdpError ? 403 : 200, text: async () => sdpError || "mock-answer" };
      }
      if (error) throw new Error(error);
      const transport = JSON.parse(options.body).transport;
      return {
        ok: response?.ok ?? true, status: response?.status ?? 200,
        json: async () => response?.data ?? ({
          transport, ephemeral_token: "ephemeral-secret", expires_at: 1234567890, model: "test",
          token_source: "client_secrets",
          [transport === "websocket" ? "websocket_url" : "webrtc_url"]: transport === "websocket"
            ? "wss://example.openai.azure.com/openai/v1/realtime?model=test"
            : "https://example.openai.azure.com/openai/v1/realtime/calls",
          access_key: "unexpected-private-field"
        })
      };
    }
  });
  vm.runInContext(source("realtime-experiments.js"), context);
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(match[1], context);
  }
  getElement("demoKey").value = "demo-secret";
  return {
    html, getElement, requests, sent, peers, tracks, body, consoleMessages,
    run: code => vm.runInContext(code, context),
    logs: () => getElement("events").textContent +
      getElement("logContainer").children.map(child => child.textContent).join("\n")
  };
}

for (const file of [...pages, "index.html"]) {
  test(`${file}: generic Japanese presentation and ephemeral/Entra provenance`, () => {
    const html = source(file);
    assert.match(html, /lang="ja"/);
    assert.doesNotMatch(html, /Robotics|K1\s*Pro|\bQ[789]\b|お客様|customer|ロボット/i);
    assert.match(html, /client_secrets/);
    assert.match(html, /Entra 認証はバックエンドのみ/);
    assert.doesNotMatch(html, /localStorage|sessionStorage|code=\$\{|console\.(?:log|error)/);
  });
}

for (const file of pages) {
  test(`${file}: real page defaults use shared same-origin auth and no raw token response`, async () => {
    const ui = browserHarness(file);
    assert.equal(ui.getElement("functionUrl").value, "/api/realtime-access");
    assert.match(ui.html, /<script src="realtime-experiments\.js"><\/script>/);
    for (const id of ["demoKey", "functionKey"]) {
      assert.match(ui.html, new RegExp(`<input id="${id}"[^>]*type="password"[^>]*autocomplete="off"`));
    }
    ui.getElement("functionKey").value = "external-secret";
    const session = await ui.run("getEphemeralSession()");
    assert.equal(session.token, "ephemeral-secret");
    assert.equal(session.raw, undefined);
    const request = ui.requests[0];
    assert.equal(request.url, "https://demo.azurewebsites.net/api/realtime-access");
    assert.equal(request.options.headers["x-demo-key"], "demo-secret");
    assert.equal(request.options.headers["x-functions-key"], undefined);
    assert.equal(request.options.redirect, "error");
    assert.doesNotMatch(request.url + request.options.body, /demo-secret|external-secret/);
    assert.equal(session.info.issuerPath, "/openai/v1/realtime/client_secrets");
    assert.equal(session.info.tokenSource, "client_secrets");
    assert.doesNotMatch(JSON.stringify(session.info), /ephemeral-secret|unexpected-private-field/);
    if (file.includes("websocket")) assert.equal(session.connectFrame.access_key, "demo-secret");
  });

  test(`${file}: external Function URL is opt-in and receives only its explicit header key`, async () => {
    const ui = browserHarness(file);
    ui.getElement("functionUrl").value = "https://external.azurewebsites.net/api/realtime-access?code=external-secret";
    const session = await ui.run("getEphemeralSession()");
    assert.equal(ui.requests[0].options.headers["x-functions-key"], "external-secret");
    assert.equal(ui.requests[0].options.headers["x-demo-key"], undefined);
    assert.doesNotMatch(ui.requests[0].url, /secret|code=/);
    assert.equal(ui.getElement("functionUrl").value, "https://external.azurewebsites.net/api/realtime-access");
    assert.equal(ui.getElement("functionKey").value, "external-secret");
    if (session.connectFrame) assert.equal(Object.hasOwn(session.connectFrame, "access_key"), false);
  });

  test(`${file}: errors do not leak entered keys or echoed token fields`, async () => {
    for (const options of [
      { error: "Failed request: demo-secret external-secret" },
      { response: { ok: false, status: 403, data: {
        ephemeral_token: "ephemeral-secret",
        error: { message: "Denied demo-secret external-secret ephemeral-secret" },
        "x-demo-key": "unknown-secret", access_key: "unknown-secret"
      } } },
      { response: { data: { ephemeral_token: "ephemeral-secret", webrtc_url: "https://example.test?token=ephemeral-secret" } } }
    ]) {
      const ui = browserHarness(file, options);
      ui.getElement("functionKey").value = "external-secret";
      const start = file.includes("function_call_map") ? "startSession()" : "start()";
      await ui.run(start);
      assert.doesNotMatch(ui.logs(), /demo-secret|external-secret|ephemeral-secret|unknown-secret/);
      assert.equal(ui.getElement("startBtn").disabled, false);
      assert.equal(ui.peers.length, 0);
      assert.equal(ui.tracks.length, 0);
      assert.deepEqual(ui.consoleMessages, []);
      assert.match(ui.logs(), /失敗|Error starting/);
    }
  });
}

test("WebSocket HTML defaults preserve the configurable Japanese half-duplex preset", () => {
  const ui = browserHarness(pages[2]);
  assert.equal(ui.getElement("voice").value, "coral");
  assert.equal(ui.getElement("transcriptionModel").value, "gpt-4o-mini-transcribe");
  assert.equal(ui.getElement("transcriptionLanguage").value, "ja");
  assert.equal(ui.getElement("vadThreshold").value, "0.75");
  assert.equal(ui.getElement("prefixPadding").value, "300");
  assert.equal(ui.getElement("silenceDuration").value, "500");
  assert.equal(ui.getElement("createResponse").checked, true);
  assert.equal(ui.getElement("interruptResponse").checked, false);
  assert.equal(ui.getElement("muteDuringPlayback").checked, true);
  assert.equal(ui.getElement("pauseMicrophone").checked, false);
});

for (const file of pages.slice(0, 2)) {
  const map = file.includes("function_call_map");
  const start = map ? "startSession()" : "start()";
  const stop = map ? "stopSession()" : "stop()";
  test(`${file}: WebRTC exchange uses only ephemeral authorization and cleans up for reconnect`, async () => {
    const ui = browserHarness(file);
    await ui.run(start);
    await nextTurn();
    assert.equal(ui.requests.length, 2);
    const sdp = ui.requests[1];
    assert.equal(sdp.options.headers.Authorization, "Bearer ephemeral-secret");
    assert.equal(sdp.options.headers["x-demo-key"], undefined);
    assert.equal(sdp.options.headers["x-functions-key"], undefined);
    assert.equal(sdp.options.redirect, "error");
    assert.equal(ui.peers[0].answer.sdp, "mock-answer");
    assert.equal(ui.getElement("startBtn").disabled, true);
    assert.equal(ui.getElement("stopBtn").disabled, false);
    assert.equal(ui.sent.filter(event => event.type === "response.create").length, 1);
    ui.peers[0].channel.emit("message", { data: JSON.stringify({
      type: "error", error: {
        code: "ExampleError", message: "echo demo-secret ephemeral-secret",
        "x-demo-key": "unknown-private-key", access_key: "unknown-private-key"
      }
    }) });
    assert.doesNotMatch(ui.logs(), /ephemeral-secret|demo-secret|unexpected-private-field/);
    assert.doesNotMatch(ui.logs(), /unknown-private-key/);
    await ui.run(start);
    assert.equal(ui.requests.length, 2, "a second click must not create a second microphone stream");
    await ui.run(stop);
    assert.equal(ui.tracks[0].stopped, true);
    assert.equal(ui.peers[0].closed, true);
    assert.equal(ui.peers[0].channel.closed, true);
    assert.equal(ui.getElement("startBtn").disabled, false);
    assert.equal(ui.getElement("stopBtn").disabled, true);
    if (map) assert.equal(ui.body.children[0].removed, true);
    else assert.equal(ui.getElement("remoteAudio").srcObject, null);
    await ui.run(start);
    assert.equal(ui.requests.length, 4, "reconnect mints another ephemeral token");
    await ui.run(stop);
  });

  test(`${file}: failed SDP response is redacted and releases microphone/media resources`, async () => {
    const ui = browserHarness(file, { sdpError: "echo demo-secret ephemeral-secret" });
    await ui.run(start);
    assert.equal(ui.tracks[0].stopped, true);
    assert.equal(ui.peers[0].closed, true);
    assert.equal(ui.getElement("startBtn").disabled, false);
    assert.doesNotMatch(ui.logs(), /demo-secret|ephemeral-secret/);
    assert.match(ui.logs(), /403/);
    assert.deepEqual(ui.consoleMessages, []);
  });
}

test("map retains GA session.update, transcript handling and function output/response sequence", async () => {
  const ui = browserHarness(pages[1]);
  await ui.run("startSession()");
  const update = ui.sent.find(event => event.type === "session.update");
  assert.equal(update.session.type, "realtime");
  assert.equal(update.session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
  assert.equal(update.session.audio.input.transcription.language, "ja");
  assert.equal(update.session.audio.input.turn_detection.threshold, 0.75);
  assert.equal(update.session.tools[0].name, "map_geocoding");
  const emit = event => ui.peers[0].channel.emit("message", { data: JSON.stringify(event) });
  emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "東京駅に案内して" });
  emit({ type: "response.output_audio_transcript.done", transcript: "東京駅を表示します" });
  assert.match(ui.logs(), /東京駅に案内して/);
  assert.match(ui.logs(), /東京駅を表示します/);
  ui.run('geocodeAddress = async () => ({ name: "東京駅", latitude: 35.68, longitude: 139.76 })');
  emit({
    type: "response.function_call_arguments.done", name: "map_geocoding",
    call_id: "call-1", arguments: '{"destination":"東京駅"}'
  });
  await nextTurn();
  const output = ui.sent.find(event => event.type === "conversation.item.create");
  assert.equal(output.item.type, "function_call_output");
  assert.equal(output.item.call_id, "call-1");
  assert.deepEqual(JSON.parse(output.item.output), { name: "東京駅", latitude: 35.68, longitude: 139.76 });
  assert.deepEqual(normalize(ui.sent.at(-1)), { type: "response.create" });
  await ui.run("stopSession()");
});
