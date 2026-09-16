const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_PRESET: CUSTOMER_PRESET, buildSessionUpdate, functionRequest, browserAccessRequest,
  createBrowserAccess, redact, ExperimentRecorder
} = require("./realtime-experiments.js");

test("Japanese preset preserves GA audio schema and transcription language", () => {
  const event = buildSessionUpdate({ ...CUSTOMER_PRESET, instructions: "Test instructions" });
  assert.deepEqual(event, {
    type: "session.update",
    session: {
      type: "realtime", instructions: "Test instructions", output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "gpt-4o-mini-transcribe", language: "ja" },
          turn_detection: {
            type: "server_vad", threshold: 0.75, prefix_padding_ms: 300,
            silence_duration_ms: 500, create_response: true, interrupt_response: false
          }
        },
        output: { voice: "coral", format: { type: "audio/pcm", rate: 24000 } }
      }
    }
  });
  // The model cannot be changed by a session update; use the token service's deployment.
  assert.equal(event.session.model, undefined);
});

test("disabled transcription uses null; custom deployment and prompt have no fallback", () => {
  for (const model of ["off", "whisper-1", "gpt-4o-transcribe", "custom-deployment"]) {
    const event = buildSessionUpdate({
      ...CUSTOMER_PRESET, transcriptionModel: model, language: "", prompt: "Technical terms"
    });
    assert.deepEqual(event.session.audio.input.transcription,
      model === "off" ? null : { model, prompt: "Technical terms" });
  }
  assert.throws(() => buildSessionUpdate({ ...CUSTOMER_PRESET, transcriptionModel: "" }));
  assert.throws(() => buildSessionUpdate({ ...CUSTOMER_PRESET, language: "ja-JP" }));
  for (const threshold of [-1, 1.01, NaN]) {
    assert.throws(() => buildSessionUpdate({ ...CUSTOMER_PRESET, threshold }));
  }
});

test("legacy Function code is moved to header and conflicting credentials rejected", () => {
  const request = functionRequest("https://example.azurewebsites.net/api/realtime-access?code=test-secret", "", {
    transport: "websocket", voice: "coral"
  });
  assert.equal(request.url, "https://example.azurewebsites.net/api/realtime-access");
  assert.equal(request.options.headers["x-functions-key"], "test-secret");
  assert.equal(JSON.parse(request.options.body).transport, "websocket");
  assert.throws(() => functionRequest("http://remote.example/api", "key", {}));
  assert.throws(() => functionRequest("https://example.test?code=a", "b", {}));
  assert.throws(() => functionRequest("https://example.test?code=a&code=b", "", {}));
  assert.equal(functionRequest("http://localhost:7071/api/realtime-access", "", {}).options.headers["x-functions-key"], undefined);
  assert.equal(functionRequest("http://127.0.0.1:7071/api/realtime-access", "local-secret", {}).options.headers["x-functions-key"], "local-secret");
  for (const url of ["http://localhost.example/api", "https://user:secret@example.test/api",
    "https://example.test/api?token=secret", "https://example.test/api?x-functions-key=secret"]) {
    assert.throws(() => functionRequest(url, "", {}));
  }
});

test("input and assistant transcripts remain separate across interleaved and late events", () => {
  let clock = 0;
  const recorder = new ExperimentRecorder(() => clock);
  const input = (suffix, item, data) => recorder.record({
    type: `conversation.item.input_audio_transcription.${suffix}`,
    item_id: item, content_index: 0, ...data
  });
  recorder.record({ type: "input_audio_buffer.committed", item_id: "user-1" });
  clock = 10;
  input("delta", "user-1", { delta: "partial" });
  input("delta", "user-2", { delta: "second" });
  recorder.record({
    type: "response.output_audio_transcript.done", item_id: "assistant-1",
    response_id: "response-1", content_index: 0, transcript: "Assistant answer"
  });
  recorder.record({ type: "response.done", response: { id: "response-1", status: "completed" } });
  clock = 30;
  input("completed", "user-1", { transcript: "Corrected final input" });
  input("delta", "user-1", { delta: "must not append after final" });
  input("failed", "user-2", { error: { code: "transcription_failed", message: "Unavailable model" } });
  const report = recorder.snapshot();
  assert.equal(report.inputTranscripts[0].text, "Corrected final input");
  assert.equal(report.inputTranscripts[0].firstAfterCommitMs, 10);
  assert.equal(report.inputTranscripts[0].finalAfterCommitMs, 30);
  assert.equal(report.inputTranscripts[1].status, "failed");
  assert.equal(report.inputTranscripts[1].error.code, "transcription_failed");
  assert.equal(report.inputTranscripts[1].finalAfterCommitMs, null);
  assert.equal(report.assistantTranscripts[0].text, "Assistant answer");
  assert.equal(report.errors.length, 1);
});

test("reports contain counts and bounded events, not audio payloads or credentials", () => {
  const recorder = new ExperimentRecorder(() => 0);
  recorder.record({ type: "session.updated", session: { client_secret: { value: "do-not-export" } } });
  recorder.record({ type: "response.output_audio.delta", delta: "AAAAAA==" });
  for (let i = 0; i < 510; i++) recorder.record({ type: "rate_limits.updated" });
  const report = recorder.snapshot();
  assert.equal(report.outputAudioBytes, 4);
  assert.equal(report.recentEvents.length, 500);
  assert.equal(report.eventCounts["response.output_audio.delta"], 1);
  assert.ok(!JSON.stringify(report).includes("do-not-export"));
  const sanitized = JSON.stringify(redact({
    authorization: "Bearer sample-secret", ephemeral_token: "sample-secret",
    url: "https://example.test?code=sample-secret&token=sample-secret", audio: "AAAA",
    error: "Authorization: Bearer sample-secret"
  }));
  assert.ok(!sanitized.includes("sample-secret"));
  assert.ok(!sanitized.includes("AAAA"));
});

test("stopped experiment duration remains stable when exporting later", () => {
  let now = 0;
  const recorder = new ExperimentRecorder(() => now);
  now = 200;
  recorder.finish();
  now = 500;
  recorder.finish();
  assert.equal(recorder.snapshot().durationMs, 200);
  assert.equal(recorder.snapshot().stopped, true);
});

test("retired same-origin token routes reject credentials instead of treating them as Demo issuer keys", () => {
  const page = "https://demo.azurewebsites.net/gpt-realtime-livevoice-demo.html";
  for (const url of ["/api/realtime-access", "https://demo.azurewebsites.net/api/realtime-access",
    "https://demo.azurewebsites.net/api/realtime-access/", "/api/realtime-access?code=secret"]) {
    assert.throws(() => browserAccessRequest(url, {
      demoKey: "demo-secret", functionKey: "external-secret"
    }, { transport: "webrtc" }, page));
  }
});

test("external browser requests require an explicit Function key, never the Demo credential", () => {
  const page = "https://demo.azurewebsites.net/index.html";
  const url = "https://external.azurewebsites.net/api/realtime-access";
  const anonymous = browserAccessRequest(url, { demoKey: "demo-secret" }, {}, page);
  assert.deepEqual(anonymous.options.headers, { "Content-Type": "application/json" });
  assert.equal(anonymous.sameOrigin, false);
  for (const [target, functionKey] of [[url, "function-secret"], [url + "?code=function-secret", ""]]) {
    const request = browserAccessRequest(target, { demoKey: "demo-secret", functionKey }, {}, page);
    assert.equal(request.url, url);
    assert.equal(request.options.headers["x-functions-key"], "function-secret");
    assert.equal(request.options.headers["x-demo-key"], undefined);
    assert.equal(request.options.redirect, "error");
    assert.equal(request.options.cache, "no-store");
  }
  for (const suffix of ["?token=secret", "?x-demo-key=secret", "?access_key=secret", "?key=secret"]) {
    assert.throws(() => browserAccessRequest(url + suffix, {}, {}, page));
  }
  assert.throws(() => browserAccessRequest(url, { demoKey: "same", functionKey: "same" }, {}, page));
  assert.throws(() => browserAccessRequest(url + "?code=same", { demoKey: "same" }, {}, page));
});

test("redaction covers structured and text Demo credentials and known echoed secrets", () => {
  const secret = "sensitive+/value";
  const safe = JSON.stringify(redact({
    access_key: secret, "x-demo-key": secret, "x-functions-key": secret,
    error: `Rejected ${secret} ${encodeURIComponent(secret)}; access_key=unrecognized-secret`,
    nested: { message: '"x-demo-key": "another-secret"' }
  }, [secret]));
  assert.doesNotMatch(safe, /sensitive|unrecognized-secret|another-secret/);
  assert.match(safe, /redacted/);
});

test("Demo environment/header naming variants are redacted and prohibited as query credentials", () => {
  const names = [
    "access_key", "access-key", "accessKey", "DEMO_ACCESS_KEY", "demoAccessKey",
    "demo-access-key", "demo_key", "demoKey", "x-demo-key", "X_DEMO_KEY", "xDemoKey"
  ];
  for (const name of names) {
    const safe = JSON.stringify(redact({
      [name]: "unrecognized-secret",
      error: `${name}=unrecognized-secret`,
      message: `"${name}": "unrecognized-secret"`,
      url: `https://example.test/api?${name}=unrecognized-secret`
    }));
    assert.doesNotMatch(safe, /unrecognized-secret/, name);
    assert.throws(() => browserAccessRequest(
      `https://external.azurewebsites.net/api/realtime-access?${name}=unrecognized-secret`,
      {}, {}, "https://demo.azurewebsites.net/index.html"
    ), name);
  }
  assert.equal(redact({ code: "DeploymentNotFound" }).code, "DeploymentNotFound");
});

test("browser access sanitizes token/error responses, legacy URLs and network errors", async () => {
  const fields = {
    functionUrl: { value: "https://external.azurewebsites.net/api/realtime-access?code=function-secret" },
    functionKey: { value: "" }, demoKey: { value: "demo-secret" }
  };
  for (const field of Object.values(fields)) field.addEventListener = () => {};
  let request;
  let fail = false;
  const access = createBrowserAccess({
    document: { getElementById: id => fields[id] },
    pageUrl: "https://demo.azurewebsites.net/index.html",
    fetchImpl: async (url, options) => {
      if (options.method === "GET") return { ok: false, status: 503 };
      request = { url, options };
      if (fail) throw new Error("Fetch failed with function-secret and demo-secret");
      return { ok: false, status: 403, json: async () => ({
        ephemeral_token: "ephemeral-secret", access_key: "demo-secret",
        error: { message: "echo demo-secret function-secret ephemeral-secret" }
      }) };
    }
  });
  await assert.rejects(access.getSession({ transport: "webrtc" }), error => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /demo-secret|function-secret|ephemeral-secret/);
    return true;
  });
  assert.equal(fields.functionUrl.value, "https://external.azurewebsites.net/api/realtime-access");
  assert.equal(fields.functionKey.value, "function-secret");
  assert.equal(request.options.headers["x-functions-key"], "function-secret");
  assert.doesNotMatch(request.url, /secret|code=/);
  fail = true;
  await assert.rejects(access.getSession({ transport: "webrtc" }), error => {
    assert.doesNotMatch(error.message, /function-secret|demo-secret/);
    return true;
  });
});

function accessHarness({
  url = "", functionKey = "", config, deferConfig = false, response,
  pageUrl = "https://demo.example/index.html"
} = {}) {
  const fields = Object.fromEntries(Object.entries({
    functionUrl: url, functionKey, demoKey: "relay-secret", configStatus: ""
  }).map(([name, value]) => [name, {
    value, textContent: "", listeners: {},
    addEventListener(event, listener) { this.listeners[event] = listener; }
  }]));
  const requests = [];
  let resolveConfig;
  const configResponse = new Promise(resolve => { resolveConfig = resolve; });
  const validResponse = {
    transport: "websocket", ephemeral_token: "ephemeral-secret", expires_at: Date.now() / 1000 + 60,
    realtime_url: "wss://example.openai.azure.com/openai/v1/realtime?model=test"
  };
  const access = createBrowserAccess({
    document: { getElementById: id => fields[id] },
    pageUrl,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === "GET") {
        if (deferConfig) return configResponse;
        return config || { ok: true, json: async () => ({ function_url: "https://function.example/api/realtime-access" }) };
      }
      return { ok: true, status: 200, json: async () => response ?? validResponse };
    }
  });
  return {
    access, fields, requests, validResponse, resolveConfig,
    edit(id, value) { fields[id].value = value; fields[id].listeners.input(); },
    posts: () => requests.filter(request => request.options.method === "POST")
  };
}

test("configuration is a credential-free GET, and Start waits for the configured Function URL", async () => {
  const ui = accessHarness({ deferConfig: true });
  const starting = ui.access.getSession({ transport: "websocket" });
  assert.equal(ui.posts().length, 0);
  assert.equal(ui.requests[0].url, "https://demo.example/api/demo-config");
  assert.deepEqual(ui.requests[0].options.headers, { Accept: "application/json" });
  assert.equal(ui.requests[0].options.credentials, "omit");
  assert.equal(ui.requests[0].options.redirect, "error");
  ui.resolveConfig({ ok: true, json: async () => ({ function_url: "https://function.example/api/realtime-access" }) });
  const session = await starting;
  assert.equal(ui.posts()[0].url, "https://function.example/api/realtime-access");
  assert.equal(session.connectFrame.access_key, "relay-secret");
  assert.equal(ui.posts()[0].options.headers["x-demo-key"], undefined);
});

test("manual Function configuration bypasses pending defaults and is never overwritten", async () => {
  const ui = accessHarness({ deferConfig: true });
  ui.edit("functionUrl", "http://localhost:7071/api/realtime-access");
  ui.edit("functionKey", "local-function-secret");
  const session = await ui.access.getSession({ transport: "websocket" });
  assert.equal(ui.posts()[0].url, "http://localhost:7071/api/realtime-access");
  assert.equal(ui.posts()[0].options.headers["x-functions-key"], "local-function-secret");
  assert.equal(session.connectFrame.access_key, "relay-secret");
  assert.doesNotMatch(JSON.stringify(session.connectFrame), /local-function-secret/);
  ui.resolveConfig({ ok: true, json: async () => ({ function_url: "https://function.example/api/realtime-access" }) });
  await ui.access.ready;
  assert.equal(ui.fields.functionUrl.value, "http://localhost:7071/api/realtime-access");
  assert.equal(ui.fields.functionKey.value, "local-function-secret");
});

test("configuration failure, invalid defaults, and static hosting require explicit manual configuration", async () => {
  for (const config of [
    { ok: false, status: 503 }, { ok: false, status: 404 },
    { ok: true, json: async () => { throw new Error("HTML response"); } },
    ...["", "/api/realtime-access", "https://demo.example/api/realtime-access",
      "http://remote.example/api", "https://function.example/api?code=secret",
      "https://function.example/api?token=secret", "https://name:secret@function.example/api"].map(function_url => ({
      ok: true, json: async () => ({ function_url })
    }))
  ]) {
    const ui = accessHarness({ config });
    await ui.access.ready;
    assert.equal(ui.fields.functionUrl.value, "");
    assert.match(ui.fields.configStatus.textContent, /取得できません.*手動入力/);
    assert.doesNotMatch(ui.fields.configStatus.textContent, /secret/);
    await assert.rejects(ui.access.getSession({ transport: "websocket" }), /手動入力/);
    assert.equal(ui.posts().length, 0);
    ui.edit("functionUrl", "https://manual.example/api/realtime-access");
    ui.edit("functionKey", "manual-key");
    await ui.access.getSession({ transport: "websocket" });
    assert.equal(ui.posts()[0].url, "https://manual.example/api/realtime-access");
  }
});

test("file-hosted pages do not fetch a default but allow a manually specified local Function", async () => {
  const ui = accessHarness({ pageUrl: "file:///C:/demo/index.html" });
  await ui.access.ready;
  assert.equal(ui.requests.length, 0);
  assert.match(ui.fields.configStatus.textContent, /手動入力/);
  ui.edit("functionUrl", "http://127.0.0.1:7071/api/realtime-access");
  await ui.access.getSession({ transport: "websocket" });
  assert.equal(ui.posts()[0].url, "http://127.0.0.1:7071/api/realtime-access");
});

test("changing Function destination clears only its key and requires re-entry before sending", async () => {
  const ui = accessHarness({ url: "https://first.example/api", functionKey: "first-secret" });
  await ui.access.ready;
  ui.edit("functionUrl", "https://second.example/api");
  assert.equal(ui.fields.functionKey.value, "");
  assert.equal(ui.fields.demoKey.value, "relay-secret");
  await assert.rejects(ui.access.getSession({ transport: "websocket" }), /再入力/);
  assert.equal(ui.posts().length, 0);
  ui.edit("functionKey", "second-secret");
  await ui.access.getSession({ transport: "websocket" });
  assert.equal(ui.posts()[0].options.headers["x-functions-key"], "second-secret");
  assert.doesNotMatch(JSON.stringify(ui.posts()), /first-secret|relay-secret/);
  ui.fields.functionUrl.value = "https://third.example/api";
  await assert.rejects(ui.access.getSession({ transport: "websocket" }), /再入力/);
  assert.equal(ui.posts().length, 1);
});

test("credentials entered before the default URL loads are not sent to the newly loaded destination", async () => {
  const ui = accessHarness({ deferConfig: true });
  ui.edit("functionKey", "unbound-secret");
  const starting = ui.access.getSession({ transport: "websocket" });
  ui.resolveConfig({ ok: true, json: async () => ({ function_url: "https://function.example/api" }) });
  await assert.rejects(starting, /再入力/);
  assert.equal(ui.posts().length, 0);
  assert.equal(ui.fields.functionKey.value, "");
  ui.edit("functionKey", "confirmed-secret");
  await ui.access.getSession({ transport: "websocket" });
  assert.equal(ui.posts()[0].options.headers["x-functions-key"], "confirmed-secret");
});

test("editing the target while Start awaits configuration requires an explicit second Start", async () => {
  const ui = accessHarness({ deferConfig: true });
  const starting = ui.access.getSession({ transport: "websocket" });
  ui.edit("functionUrl", "https://manual.example/api");
  ui.edit("functionKey", "manual-secret");
  ui.resolveConfig({ ok: true, json: async () => ({ function_url: "https://function.example/api" }) });
  await assert.rejects(starting, /もう一度開始/);
  assert.equal(ui.posts().length, 0);
  await ui.access.getSession({ transport: "websocket" });
  assert.equal(ui.posts()[0].url, "https://manual.example/api");
});

test("Function response requires a valid token, transport, endpoint, and any supplied expiry", async () => {
  const valid = accessHarness().validResponse;
  for (const change of [
    { ephemeral_token: "" }, { ephemeral_token: null }, { ephemeral_token: "   " },
    { ephemeral_token: 123 }, { ephemeral_token: "relay-secret" }, { ephemeral_token: "function-secret" },
    { transport: "webrtc" }, { transport: undefined }, { realtime_url: undefined },
    { realtime_url: "https://example.openai.azure.com/openai/v1/realtime" },
    { realtime_url: "wss://example.test?token=ephemeral-secret" },
    { realtime_url: "wss://example.test/function-secret" },
    { expires_at: 1 }, { expires_at: "future" }, { expires_at: Infinity }, { expires_at: 0 }
  ]) {
    const ui = accessHarness({
      url: "https://function.example/api", functionKey: "function-secret", response: { ...valid, ...change }
    });
    await assert.rejects(ui.access.getSession({ transport: "websocket" }));
  }
  for (const expires_at of [null, undefined, Date.now() / 1000 + 60]) {
    const ui = accessHarness({ url: "https://function.example/api", response: { ...valid, expires_at } });
    assert.equal((await ui.access.getSession({ transport: "websocket" })).token, valid.ephemeral_token);
  }
});
