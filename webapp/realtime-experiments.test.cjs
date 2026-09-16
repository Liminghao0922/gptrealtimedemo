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

test("same-origin browser requests use only the Demo header and cannot redirect credentials", () => {
  const page = "https://demo.azurewebsites.net/gpt-realtime-livevoice-demo.html";
  for (const url of ["/api/realtime-access", "https://demo.azurewebsites.net/api/realtime-access"]) {
    const request = browserAccessRequest(url, {
      demoKey: "demo-secret", functionKey: "external-secret"
    }, { transport: "webrtc" }, page);
    assert.equal(request.sameOrigin, true);
    assert.equal(request.options.headers["x-demo-key"], "demo-secret");
    assert.equal(request.options.headers["x-functions-key"], undefined);
    assert.equal(request.options.redirect, "error");
    assert.equal(request.options.cache, "no-store");
    assert.doesNotMatch(request.url + request.options.body, /secret/);
  }
  for (const url of ["/other", "/api/realtime-access?code=secret", "/api/realtime-access#fragment"]) {
    assert.throws(() => browserAccessRequest(url, { demoKey: "secret" }, {}, page));
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
  let request;
  let fail = false;
  const access = createBrowserAccess({
    document: { getElementById: id => fields[id] },
    pageUrl: "https://demo.azurewebsites.net/index.html",
    fetchImpl: async (url, options) => {
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
