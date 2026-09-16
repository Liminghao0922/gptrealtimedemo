"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { WebSocketServer } = require("ws");
const probe = require("./customer-probe.cjs");

const ENDPOINT = "https://example.openai.azure.com";
const MODEL = "customer-realtime-deployment";
const TOKEN = "opaque-test-credential-not-a-jwt";
const event = (type, fields = {}) => ({ event_id: `event-${type}`, type, ...fields });
const outputFields = { response_id: "response-1", item_id: "assistant-1", output_index: 0, content_index: 0 };
const transcript = (type = "completed", itemId = "user-1", contentIndex = 0) => event(`conversation.item.input_audio_transcription.${type}`, {
  item_id: itemId, content_index: contentIndex,
  ...(type === "delta" ? { delta: "こんにちは" } : type === "failed"
    ? { error: { type: "transcription_error", code: "unsupported_model", message: "This transcription model is unavailable." } }
    : { transcript: "こんにちは。" }),
});
function config(overrides = {}) {
  return { ...probe.loadConfig({ command: "inspect" }, {
    AOAI_ENDPOINT: ENDPOINT, AOAI_REALTIME_DEPLOYMENT: MODEL,
    AOAI_API_KEY: "separate-api-key", PROBE_ENTRA_TOKEN: "separate-entra-token",
    PROBE_FUNCTION_URL: "https://example.azurewebsites.net/api/realtime-access",
    PROBE_FUNCTION_KEY: "function-key-secret",
  }), timeoutMs: 600, authRetries: 0, ...overrides };
}
function inputPcm(samples = 320, rate = 16000) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 12000), i * 2);
  return pcm;
}
function credential(url, kind = "ephemeral") {
  return { kind, url, model: MODEL, token: TOKEN, headers: { Authorization: `Bearer ${TOKEN}` } };
}
function responseEvents() {
  return [
    event("response.created", { response: { id: "response-1", status: "in_progress", output: [] } }),
    event("response.output_audio.delta", { ...outputFields, delta: Buffer.from([0, 1, 2, 3]).toString("base64") }),
    event("response.output_audio.done", outputFields),
    event("response.output_audio_transcript.delta", { ...outputFields, delta: "お答え" }),
    event("response.output_audio_transcript.done", { ...outputFields, transcript: "お答えします。" }),
    event("response.done", { response: { id: "response-1", status: "completed", output: [{
      id: "assistant-1", type: "message", role: "assistant", content: [{ type: "output_audio", transcript: "お答えします。" }],
    }] } }),
  ];
}

async function fakeServer(t, { onRequest, onConnection, rejectUpgrade } = {}) {
  const server = http.createServer(onRequest || ((_, res) => res.writeHead(404).end()));
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (rejectUpgrade) {
      socket.end(`HTTP/1.1 ${rejectUpgrade} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } else {
      wss.handleUpgrade(req, socket, head, ws => {
        wss.emit("connection", ws, req);
      });
    }
  });
  const received = [], headers = [];
  wss.on("connection", (ws, req) => {
    headers.push(req.headers);
    ws.on("message", raw => received.push(JSON.parse(raw.toString())));
    if (onConnection) onConnection(ws, req);
    else {
      ws.send(JSON.stringify(event("session.created", { session: { id: "session-1", type: "realtime", model: MODEL } })));
      ws.on("message", raw => {
        const message = JSON.parse(raw.toString());
        if (message.type === "session.update") ws.send(JSON.stringify(event("session.updated", { session: { id: "session-1", ...message.session } })));
      });
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: `${origin.replace("http:", "ws:")}/openai/v1/realtime?model=${MODEL}`, received, headers };
}
function streamingServer(options = {}) {
  return {
    onConnection(ws) {
      let sent = false;
      const send = item => { if (ws.readyState === 1) ws.send(JSON.stringify(item)); };
      send(event("session.created", { session: { id: "session-1", type: "realtime", model: MODEL } }));
      ws.on("message", raw => {
        const message = JSON.parse(raw.toString());
        if (message.type === "session.update") {
          const session = { id: "session-1", ...message.session };
          if (options.rejectModel && session.audio.input.transcription?.model === options.rejectModel) {
            send(event("error", { error: { type: "invalid_request_error", code: "unsupported_model", message: "The requested transcription model is unsupported." } }));
            return;
          }
          send(event("session.updated", { session }));
        }
        const trigger = options.manual ? message.type === "response.create" : message.type === "input_audio_buffer.append";
        if (trigger && !sent) {
          sent = true;
          send(event("input_audio_buffer.speech_started", { item_id: "user-1", audio_start_ms: 0 }));
          send(event("input_audio_buffer.speech_stopped", { item_id: "user-1", audio_end_ms: 20 }));
          send(event("input_audio_buffer.committed", { item_id: "user-1", previous_item_id: null }));
          if (options.transcriptFirst) send(transcript(options.failTranscript ? "failed" : "completed"));
          for (const output of responseEvents()) send(output);
          if (!options.noTranscript && !options.transcriptFirst) {
            setTimeout(() => {
              if (!options.failTranscript) send(transcript("delta"));
              send(transcript(options.failTranscript ? "failed" : "completed"));
            }, options.delay ?? 30);
          }
        }
      });
    },
  };
}

test("Q1/Q4/Q10: Function mint request evidence, issuer provenance, real expiry and header normalization", async t => {
  let request;
  const upstream = await fakeServer(t);
  const expiry = Math.floor(Date.now() / 1000) + 57;
  const tokenServer = await fakeServer(t, { onRequest(req, res) {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      request = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({
        transport: "websocket", model: MODEL, websocket_url: upstream.url, realtime_url: upstream.url,
        ephemeral_token: TOKEN, expires_at: expiry, session: { value: TOKEN, expires_at: expiry },
      }));
    });
  } });
  const cfg = config({ endpoint: undefined, functionUrl: `${tokenServer.origin}/api/realtime-access?code=function-key-secret&api-version=wrong` });
  const ctx = probe.createContext(cfg);
  const auth = await probe.issueToken(cfg, ctx, { allowLocal: true });
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/api/realtime-access");
  assert.equal(request.headers["x-functions-key"], "function-key-secret");
  assert.equal(request.headers.authorization, undefined);
  assert.deepEqual(request.body, { transport: "websocket", voice: "coral", instructions: cfg.instructions });
  assert.equal(auth.kind, "ephemeral");
  assert.equal(auth.token, TOKEN);
  assert.equal(auth.expiry.unixSeconds, expiry);
  assert.ok(auth.expiry.remainingSecondsAtReceipt <= 57 && auth.expiry.remainingSecondsAtReceipt > 50);
  assert.match(auth.issuer, /\/openai\/v1\/realtime\/client_secrets$/);
  assert.equal(ctx.report.tokenRequests[0].status, 201);
  const output = JSON.stringify(ctx.redactor.clean(ctx.report));
  assert.ok(!output.includes(TOKEN));
  assert.ok(!output.includes("function-key-secret"));
  assert.match(output, /REDACTED/);
});

test("Q2-1: validated AOAI target never derives from Function URL or forwards query credentials", () => {
  const expected = `${ENDPOINT.replace("https:", "wss:")}/openai/v1/realtime?model=deployment+with+space`;
  assert.equal(probe.buildRealtimeUrl(ENDPOINT, "deployment with space"), expected);
  assert.equal(probe.buildRealtimeUrl(`${ENDPOINT}/openai/v1`, MODEL), `${ENDPOINT.replace("https:", "wss:")}/openai/v1/realtime?model=${MODEL}`);
  for (const value of [
    `wss://example.azurewebsites.net/openai/v1/realtime?model=${MODEL}`,
    `wss://example.openai.azure.com/openai/v1/realtime?model=${MODEL}&code=secret`,
    `wss://example.openai.azure.com/openai/v1/realtime?model=${MODEL}&api-version=preview`,
    `wss://example.openai.azure.com/openai/v1/realtime?model=${MODEL}&model=other`,
    `wss://example.openai.azure.com/openai/v1/realtime/calls?model=${MODEL}`,
    `wss://example.openai.azure.com.evil.invalid/openai/v1/realtime?model=${MODEL}`,
    `wss://user:password@example.openai.azure.com/openai/v1/realtime?model=${MODEL}`,
    `ws://example.openai.azure.com/openai/v1/realtime?model=${MODEL}`,
  ]) assert.throws(() => probe.validateRealtimeUrl(value, { model: MODEL }), probe.ProbeError);
  assert.throws(() => probe.buildRealtimeUrl("https://example.azurewebsites.net", MODEL), /Function host/);
  assert.throws(() => probe.buildRealtimeUrl(`${ENDPOINT}?code=secret`, MODEL));
  assert.throws(() => probe.validateRealtimeUrl(`wss://example.openai.azure.com/openai/v1/realtime?model=other`, { model: MODEL }));
  assert.throws(() => probe.validateRealtimeUrl(`ws://127.0.0.1/openai/v1/realtime?model=${MODEL}`));
});

test("Q10: conflicting keys and duplicate code are rejected; HTTPS is required outside injected tests", () => {
  assert.deepEqual(probe.normalizeFunctionAccess("https://f.azurewebsites.net/api/realtime-access?code=a%2Bb%3D"), {
    url: "https://f.azurewebsites.net/api/realtime-access", key: "a+b=",
  });
  assert.throws(() => probe.normalizeFunctionAccess("https://f.azurewebsites.net/api/realtime-access?code=one", "two"), /Conflicting/);
  assert.throws(() => probe.normalizeFunctionAccess("https://f.azurewebsites.net/api/realtime-access?code=one&code=one"), /Conflicting/);
  assert.throws(() => probe.normalizeFunctionAccess("http://f.azurewebsites.net/api/realtime-access"), /HTTPS/);
});

test("redaction recursively removes known secrets, URLs, nested client_secret and raw auth errors", () => {
  const redactor = new probe.Redactor(["fn+/=", TOKEN, "separate-api-key"]);
  const data = {
    url: "https://f.azurewebsites.net/api/realtime-access?code=fn%2B%2F%3D&token=other-secret",
    headers: { Authorization: `Bearer ${TOKEN}`, "api-key": "separate-api-key", "x-functions-key": "fn+/=", "set-cookie": "secret-session" },
    session: { client_secret: { value: "nested-new-secret", expires_at: 1234 }, value: "top-new-secret" },
    error: { code: "unsupported_model", message: `Rejected Bearer ${TOKEN}, api-key=separate-api-key and fn+/=` },
  };
  redactor.discover(data);
  const clean = redactor.clean(data);
  const encoded = JSON.stringify(clean);
  for (const secret of ["fn+/=", "fn%2B%2F%3D", TOKEN, "separate-api-key", "nested-new-secret", "top-new-secret", "other-secret", "secret-session"]) assert.ok(!encoded.includes(secret), secret);
  assert.equal(clean.error.code, "unsupported_model");
});

test("Q4: token HTTP failures and non-JSON errors preserve status without leaking echoed secrets", async () => {
  for (const [status, body] of [[403, { error: `Rejected function-key-secret`, details: { code: "Forbidden" } }], [502, "bad gateway function-key-secret"]]) {
    const cfg = config(); const ctx = probe.createContext(cfg);
    await assert.rejects(probe.issueToken(cfg, ctx, { fetch: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }) }),
      error => error.status === status);
    assert.equal(ctx.report.tokenRequests[0].status, status);
    assert.ok(!JSON.stringify(ctx.report).includes("function-key-secret"));
  }
});

test("Q4: malformed Function response, conflicting endpoint/deployment and conflicting URLs fail closed", async () => {
  const good = { transport: "websocket", model: MODEL, ephemeral_token: TOKEN, websocket_url: probe.buildRealtimeUrl(ENDPOINT, MODEL) };
  for (const patch of [{ transport: "webrtc" }, { ephemeral_token: null }, { model: "wrong-deployment" },
    { realtime_url: "wss://different.openai.azure.com/openai/v1/realtime?model=other" },
    { websocket_url: "wss://f.azurewebsites.net/openai/v1/realtime?model=x" }]) {
    const cfg = config(); const ctx = probe.createContext(cfg);
    await assert.rejects(probe.issueToken(cfg, ctx, { fetch: async () => Response.json({ ...good, ...patch }) }), probe.ProbeError);
    assert.ok(!JSON.stringify(ctx.report).includes(TOKEN));
  }
  const cfg = config({ endpoint: "https://different.openai.azure.com" }); const ctx = probe.createContext(cfg);
  await assert.rejects(probe.issueToken(cfg, ctx, { fetch: async () => Response.json(good) }), /differs/);
});

test("Q5: unknown expiry remains unknown, not hardcoded or decoded from token spelling", async () => {
  const cfg = config(); const ctx = probe.createContext(cfg);
  const minted = await probe.issueToken(cfg, ctx, { fetch: async () => Response.json({
    transport: "websocket", model: MODEL, ephemeral_token: "eyJ.not-proof-of-entra.jwt",
    websocket_url: probe.buildRealtimeUrl(ENDPOINT, MODEL), session: {},
  }) });
  assert.equal(minted.kind, "ephemeral");
  assert.equal(minted.expiry.unixSeconds, null);
  assert.equal(minted.expiry.remainingSecondsAtReceipt, null);
});

test("Q7: exact default customer session payload, optional explicit manual commit and transcription disable", () => {
  assert.deepEqual(probe.customerSession(MODEL), {
    type: "realtime", model: MODEL, output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription: { model: "gpt-4o-mini-transcribe", language: "ja" },
        turn_detection: { type: "server_vad", threshold: 0.75, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: false },
      },
      output: { voice: "coral", format: { type: "audio/pcm", rate: 24000 } },
    },
  });
  const manual = probe.customerSession(MODEL, { transcription: "disabled", manualCommit: true });
  assert.equal(manual.audio.input.turn_detection, null);
  assert.equal(manual.audio.input.transcription, null);
  const conventional = probe.customerSession(MODEL, { omitSessionModel: true });
  assert.equal(Object.hasOwn(conventional, "model"), false);
  assert.deepEqual(conventional.audio, probe.customerSession(MODEL).audio);
  const shared = require("./realtime-experiments.js");
  const sharedBaseline = shared.buildSessionUpdate({ ...shared.CUSTOMER_PRESET, instructions: "test instructions" }).session;
  assert.deepEqual(probe.customerSession(MODEL, { omitSessionModel: true, instructions: "test instructions" }), sharedBaseline);
  assert.equal(probe.loadConfig({ command: "inspect", transcription: "off" }, {}).transcription, "disabled");
});

test("Jetson mono PCM16 WAV 16k -> 24k resampling preserves duration and waveform; WAV output is valid", () => {
  const pcm = inputPcm(1600);
  const wav = probe.readWav(probe.makeWav(pcm, 16000));
  assert.equal(wav.rate, 16000);
  assert.equal(wav.durationMs, 100);
  const output = probe.resamplePcm16(wav.pcm, wav.rate);
  assert.equal(output.length, 4800);
  assert.equal(output.readInt16LE(0), pcm.readInt16LE(0));
  assert.equal(output.readInt16LE(6), pcm.readInt16LE(4));
  const roundtrip = probe.readWav(probe.makeWav(output));
  assert.equal(roundtrip.rate, 24000);
  assert.equal(roundtrip.durationMs, 100);
  assert.deepEqual(roundtrip.pcm, output);
  assert.deepEqual(probe.resamplePcm16(output, 24000), output);
});

test("WAV validation rejects stereo, float, compressed, wrong rate, truncated, empty, odd PCM and >30s", () => {
  const good = probe.makeWav(inputPcm());
  for (const change of [
    b => b.writeUInt16LE(2, 22), b => b.writeUInt16LE(3, 20), b => b.writeUInt16LE(7, 20),
    b => b.writeUInt32LE(44100, 24), b => b.writeUInt16LE(8, 34),
    b => b.writeUInt32LE(999999, 40), b => b.writeUInt16LE(4, 32),
  ]) { const bad = Buffer.from(good); change(bad); assert.throws(() => probe.readWav(bad)); }
  assert.throws(() => probe.readWav(good.subarray(0, good.length - 1)));
  assert.throws(() => probe.readWav(probe.makeWav(Buffer.alloc(0))));
  assert.throws(() => probe.makeWav(Buffer.alloc(3)));
  assert.throws(() => probe.readWav(probe.makeWav(Buffer.alloc(24000 * 2 * 31))));
  assert.throws(() => probe.resamplePcm16(Buffer.alloc(3), 16000));
});

test("Q9: structural contracts reject mere event-name presence and malformed nested/index/audio fields", () => {
  for (const type of [
    "session.created", "session.updated", "input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped",
    "input_audio_buffer.committed", "conversation.item.input_audio_transcription.delta",
    "conversation.item.input_audio_transcription.completed", "conversation.item.input_audio_transcription.failed",
    "response.created", "response.output_audio.delta", "response.output_audio.done", "response.output_audio_transcript.done", "response.done", "error",
  ]) assert.ok(probe.validateEvent({ type }).length > 0, type);
  for (const item of responseEvents()) assert.deepEqual(probe.validateEvent(item), []);
  assert.deepEqual(probe.validateEvent(transcript()), []);
  assert.deepEqual(probe.validateEvent(transcript("failed")), []);
  assert.ok(probe.validateEvent({ ...transcript(), content_index: -1 }).includes("content_index"));
  assert.ok(probe.validateEvent(event("response.done", { response: { id: "r", status: "completed", output: {} } })).includes("response.output"));
  assert.ok(probe.validateEvent(event("response.done", { response: { id: "r", status: "completed", output: [null] } })).length);
  assert.ok(probe.validateEvent(event("response.done", { response: { id: "r", status: "in_progress", output: [] } })).includes("response.done terminal status"));
  for (const delta of ["", "!", "AAA", "AQ==", "AB==", "AA==\n"]) assert.throws(() => probe.pcmDelta(delta));
  assert.deepEqual(probe.pcmDelta("AAE="), Buffer.from([0, 1]));
});

test("Q8: input transcripts key by item_id/content_index, separate assistant, latencies measured from append", () => {
  let now = 100;
  const collector = new probe.EventCollector({ now: () => now });
  collector.uploadStarted = now;
  now = 120;
  collector.accept(transcript("delta", "user-1", 0));
  now = 140;
  collector.accept(transcript("completed", "user-1", 0));
  collector.accept(transcript("completed", "user-1", 1));
  collector.accept(transcript("completed", "user-2", 0));
  for (const item of responseEvents()) collector.accept(item);
  assert.equal(collector.inputs.size, 3);
  assert.equal(collector.assistant.size, 1);
  const evidence = collector.evidence();
  assert.equal(evidence.inputTranscripts[0].firstLatencyMs, 20);
  assert.equal(evidence.inputTranscripts[0].finalLatencyMs, 40);
  assert.equal(evidence.assistantTranscripts[0].transcript, "お答えします。");
  assert.equal(evidence.audio.chunks, 1);
  assert.equal(evidence.audio.bytes, 4);
  assert.ok(!JSON.stringify(evidence.events).includes("AAECAw=="));
});

test("Q8/Q9: response.done alone is insufficient; all expected input items must terminate", () => {
  const collector = new probe.EventCollector();
  collector.accept(event("input_audio_buffer.committed", { item_id: "user-1", previous_item_id: null }));
  collector.accept(event("input_audio_buffer.committed", { item_id: "user-2", previous_item_id: "user-1" }));
  for (const item of responseEvents()) collector.accept(item);
  assert.equal(collector.complete(), false);
  collector.accept(transcript());
  assert.equal(collector.complete(), false);
  collector.accept(transcript("failed", "user-2"));
  assert.equal(collector.complete(), true);
  assert.equal(collector.failures.length, 1);
  const failedFirst = new probe.EventCollector();
  failedFirst.accept(transcript("failed"));
  assert.equal(failedFirst.complete(), false);
  for (const item of responseEvents()) failedFirst.accept(item);
  assert.equal(failedFirst.complete(), true);
  const inverse = new probe.EventCollector();
  inverse.accept(transcript());
  assert.equal(inverse.complete(), false);
  for (const item of responseEvents()) inverse.accept(item);
  assert.equal(inverse.complete(), true);
});

test("Q2/Q6: direct WebSocket Upgrade, bearer headers and awaited session readiness (no audio before update)", async t => {
  const server = await fakeServer(t);
  const cfg = config(); const ctx = probe.createContext(cfg);
  const result = await probe.runSession(credential(server.url), cfg, ctx);
  assert.equal(result.report.status, "passed");
  assert.equal(result.report.handshake.status, 101);
  assert.equal(result.report.handshake.upgraded, true);
  assert.equal(server.headers[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(server.headers[0]["x-functions-key"], undefined);
  assert.deepEqual(server.received.map(e => e.type), ["session.update"]);
  assert.equal(result.report.sessionUpdated.audio.output.voice, "coral");
  assert.deepEqual(result.report.configurationDifferences, []);
  assert.equal(result.report.modelFieldExperiment.mode, "exact-customer-update-model-included-experimental");
});

test("immutable model field baseline is explicitly opt-in, preserves WS deployment, and never silently changes payload", async t => {
  const server = await fakeServer(t);
  const cfg = probe.loadConfig(probe.parseArgs(["inspect", "--auth", "entra", "--omit-session-model"]), {
    AOAI_ENDPOINT: server.origin, AOAI_REALTIME_DEPLOYMENT: MODEL, PROBE_ENTRA_TOKEN: "separate-entra",
  });
  const report = await probe.execute(cfg, probe.createContext(cfg), { allowLocal: true });
  assert.equal(report.status, "completed");
  assert.equal(Object.hasOwn(server.received[0].session, "model"), false);
  assert.equal(report.probes[0].attempts[0].auth.model, MODEL);
  assert.equal(report.probes[0].attempts[0].modelFieldExperiment.mode, "conventional-update-model-omitted");
  assert.match(report.questions.Q7.evidence.modelFieldExperiment.note, /immutable/);
});
test("Q6: readiness is bounded; missing created/update or changed settings prevent sending audio", async t => {
  for (const behavior of ["no-created", "no-updated", "changed-setting"]) {
    const server = await fakeServer(t, { onConnection(ws) {
      if (behavior === "no-created") return;
      ws.send(JSON.stringify(event("session.created", { session: { id: "s", type: "realtime" } })));
      ws.on("message", raw => {
        const message = JSON.parse(raw.toString());
        if (behavior === "changed-setting") {
          message.session.audio.input.transcription.model = "silent-fallback-model";
          ws.send(JSON.stringify(event("session.updated", { session: { id: "s", ...message.session } })));
        }
      });
    } });
    const cfg = config({ pcm: inputPcm(), timeoutMs: 70 }); const ctx = probe.createContext(cfg);
    const result = await probe.runSession(credential(server.url), cfg, ctx);
    assert.equal(result.report.status, "failed");
    assert.equal(result.report.error.category, behavior === "changed-setting" ? "session-configuration" : "timeout");
    assert.equal(server.received.some(e => e.type === "input_audio_buffer.append"), false);
  }
});

test("Q8/Q9: paced VAD audio waits for late user transcription after response.done; no empty or duplicate commit", async t => {
  const server = await fakeServer(t, streamingServer({ delay: 90 }));
  const cfg = config({ pcm: inputPcm(480, 24000) }); const ctx = probe.createContext(cfg);
  const result = await probe.runSession(credential(server.url), cfg, ctx, { sleep: async () => {}, quietMs: 5, pollMs: 2 });
  assert.equal(result.report.status, "passed");
  assert.ok(result.report.observationMs >= 80);
  assert.equal(result.report.inputTranscripts[0].status, "completed");
  assert.equal(result.report.assistantTranscripts[0].transcript, "お答えします。");
  assert.equal(result.report.eventCounts["response.done"], 1);
  const appended = server.received.filter(e => e.type === "input_audio_buffer.append");
  const wire = Buffer.concat(appended.map(e => Buffer.from(e.audio, "base64")));
  assert.equal(wire.length, cfg.pcm.length + 14400 + 38400);
  assert.ok(wire.subarray(0, 14400).every(b => b === 0));
  assert.ok(wire.subarray(wire.length - 38400).every(b => b === 0));
  assert.ok(appended.every(e => Buffer.from(e.audio, "base64").length > 0));
  assert.ok(!server.received.some(e => e.type === "input_audio_buffer.commit"));
  assert.deepEqual(result.pcm, Buffer.from([0, 1, 2, 3]));
});

test("Q8/Q9: transcript-first and failed-transcript completion both wait for response.done", async t => {
  for (const failTranscript of [false, true]) {
    const server = await fakeServer(t, streamingServer({ transcriptFirst: true, failTranscript }));
    const cfg = config({ pcm: inputPcm() }); const ctx = probe.createContext(cfg);
    const result = await probe.runSession(credential(server.url), cfg, ctx, { sleep: async () => {}, quietMs: 2, pollMs: 2 });
    assert.equal(result.report.status, failTranscript ? "failed" : "passed");
    assert.equal(result.report.eventCounts["response.done"], 1);
    assert.equal(result.report.inputTranscripts[0].status, failTranscript ? "failed" : "completed");
    if (failTranscript) assert.equal(result.report.failures[0].error.code, "unsupported_model");
    assert.equal(result.report.outcomes.inputTranscription, failTranscript ? "failed" : "completed");
    assert.equal(result.report.outcomes.assistantResponse, "completed");
    assert.equal(result.report.outcomes.assistantVoice, "audio-and-completed-response-observed");
  }
});

test("full multi-utterance WAV waits every later committed transcript; DeploymentNotFound does not negate successful voice", async t => {
  let secondTranscriptDelivered = false;
  const server = await fakeServer(t, { onConnection(ws) {
    let appends = 0;
    const send = item => { if (ws.readyState === 1) ws.send(JSON.stringify(item)); };
    send(event("session.created", { session: { id: "session-1", type: "realtime", model: MODEL } }));
    ws.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "session.update") send(event("session.updated", { session: { id: "session-1", ...message.session } }));
      if (message.type !== "input_audio_buffer.append") return;
      appends++;
      if (appends === 1) {
        send(event("input_audio_buffer.committed", { item_id: "user-1", previous_item_id: null }));
        send(transcript());
        for (const item of responseEvents()) send(item);
      } else if (appends === 4) {
        send(event("input_audio_buffer.speech_started", { item_id: "user-2", audio_start_ms: 300 }));
        send(event("input_audio_buffer.speech_stopped", { item_id: "user-2", audio_end_ms: 500 }));
        send(event("input_audio_buffer.committed", { item_id: "user-2", previous_item_id: "user-1" }));
        for (const item of responseEvents()) send(JSON.parse(JSON.stringify(item).replaceAll("response-1", "response-2").replaceAll("assistant-1", "assistant-2")));
        setTimeout(() => {
          secondTranscriptDelivered = true;
          send(event("conversation.item.input_audio_transcription.failed", {
            item_id: "user-2", content_index: 0,
            error: { type: "transcription_error", code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." },
          }));
        }, 90);
      }
    });
  } });
  const cfg = config({ pcm: inputPcm(2400, 24000) });
  const result = await probe.runSession(credential(server.url), cfg, probe.createContext(cfg), {
    sleep: () => new Promise(resolve => setTimeout(resolve, 1)), quietMs: 2, pollMs: 2,
  });
  assert.equal(secondTranscriptDelivered, true);
  assert.equal(result.report.upload.finished, true);
  assert.equal(result.report.expectedInputItems.length, 2);
  assert.equal(result.report.inputTranscripts.length, 2);
  assert.equal(result.report.inputTranscripts[1].error.code, "DeploymentNotFound");
  assert.equal(result.report.eventCounts["response.done"], 2);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.outcomes.inputTranscription, "failed");
  assert.deepEqual(result.report.outcomes.pendingInputItems, []);
  assert.equal(result.report.outcomes.assistantResponse, "completed");
  assert.equal(result.report.outcomes.assistantVoice, "audio-and-completed-response-observed");
});

test("Q8: disabled transcription still requires assistant audio/response; absence is explicitly not proven", async t => {
  const server = await fakeServer(t, streamingServer({ noTranscript: true }));
  const cfg = config({ pcm: inputPcm(), transcription: "disabled" }); const ctx = probe.createContext(cfg);
  const result = await probe.runSession(credential(server.url), cfg, ctx, { sleep: async () => {}, quietMs: 2, pollMs: 2 });
  assert.equal(result.report.status, "passed");
  assert.equal(result.report.inputTranscripts.length, 0);
  assert.equal(result.report.responses[0].status, "completed");
  assert.match(result.report.transcriptionObservation, /absence is not proven/);
});

test("Q8: missing required input transcript times out even after assistant response.done", async t => {
  const server = await fakeServer(t, streamingServer({ noTranscript: true }));
  const cfg = config({ pcm: inputPcm(), timeoutMs: 90 }); const ctx = probe.createContext(cfg);
  const result = await probe.runSession(credential(server.url), cfg, ctx, { sleep: async () => {}, quietMs: 2, pollMs: 2 });
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.error.category, "timeout");
  assert.equal(result.report.eventCounts["response.done"], 1);
});

test("explicit manual mode sends nonempty audio before exactly one commit and response.create", async t => {
  const server = await fakeServer(t, streamingServer({ manual: true }));
  const cfg = config({ pcm: inputPcm(), manualCommit: true }); const ctx = probe.createContext(cfg);
  const result = await probe.runSession(credential(server.url), cfg, ctx, { sleep: async () => {}, quietMs: 2, pollMs: 2 });
  assert.equal(result.report.status, "passed");
  assert.deepEqual(server.received.map(e => e.type), ["session.update", "input_audio_buffer.append", "input_audio_buffer.commit", "response.create"]);
  assert.equal(server.received[0].session.audio.input.turn_detection, null);
  const emptyCfg = config({ pcm: Buffer.alloc(0), manualCommit: true });
  const empty = await probe.runSession(credential(server.url), emptyCfg, probe.createContext(emptyCfg));
  assert.equal(empty.report.status, "failed");
  assert.match(empty.report.error.message, /empty/);
  assert.equal(server.received.filter(e => e.type === "input_audio_buffer.commit").length, 1);
});

test("Q2/Q11: HTTP 401/403 Upgrade classified without leaking token; no silent auth fallback", async t => {
  for (const status of [401, 403, 404, 429]) {
    const server = await fakeServer(t, { rejectUpgrade: status });
    const cfg = config(); const ctx = probe.createContext(cfg); ctx.redactor.add(TOKEN);
    const result = await probe.runSession(credential(server.url), cfg, ctx);
    assert.equal(result.report.status, "failed");
    assert.equal(result.report.handshake.status, status);
    assert.equal(result.report.error.category, [401, 403].includes(status) ? "websocket-auth" : "http-upgrade");
    assert.ok(!JSON.stringify(result.report).includes(TOKEN));
  }
});

test("Q5: ephemeral auth rejection retries bounded with freshly minted tokens; 429 does not retry", async t => {
  for (const status of [401, 403, 429]) {
    const server = await fakeServer(t, { rejectUpgrade: status });
    let minted = 0;
    const cfg = config({ endpoint: undefined, authRetries: 2 }); const ctx = probe.createContext(cfg);
    const result = await probe.runWithAuth("ephemeral", cfg, ctx, { allowLocal: true, sleep: async () => {},
      fetch: async () => Response.json({ transport: "websocket", model: MODEL, websocket_url: server.url, ephemeral_token: `mint-${++minted}` }),
    });
    assert.equal(minted, status === 429 ? 1 : 3);
    assert.equal(result.attempts.length, minted);
    assert.equal(result.report.status, "failed");
  }
});

test("Q5: reconnect deliberately drops then mints fresh; same-token reuse is strictly opt-in", async t => {
  for (const reuse of [false, true]) {
    const server = await fakeServer(t);
    let minted = 0;
    const cfg = config({ command: "reconnect", endpoint: undefined, "reuse-token": reuse }); const ctx = probe.createContext(cfg);
    const report = await probe.execute(cfg, ctx, { allowLocal: true, fetch: async () => Response.json({
      transport: "websocket", model: MODEL, websocket_url: server.url, ephemeral_token: `fresh-mint-${++minted}`,
    }) });
    assert.equal(report.status, "completed");
    assert.equal(minted, 2);
    assert.equal(report.probes.length, reuse ? 3 : 2);
    assert.equal(report.freshReconnect.distinctTokenValueObserved, true);
    assert.equal(server.headers[0].authorization, "Bearer fresh-mint-1");
    if (reuse) assert.equal(server.headers[1].authorization, "Bearer fresh-mint-1");
    assert.equal(server.headers.at(-1).authorization, "Bearer fresh-mint-2");
    assert.ok(!JSON.stringify(report).includes("fresh-mint-1"));
    assert.equal(report.questions.Q3.evidence.modelRegion, "unknown; never inferred from Function region or hostname");
  }
});

test("Q2: auth matrix uses separate configured credential types and marks missing modes skipped", async t => {
  const server = await fakeServer(t);
  const cfg = config({ command: "auth-matrix", endpoint: undefined, entraToken: undefined }); const ctx = probe.createContext(cfg);
  const report = await probe.execute(cfg, ctx, { allowLocal: true, fetch: async () => Response.json({
    transport: "websocket", model: MODEL, websocket_url: server.url, ephemeral_token: TOKEN,
  }) });
  assert.equal(report.status, "completed");
  assert.deepEqual(report.probes.map(p => [p.label, p.status]), [["ephemeral", "passed"], ["entra", "skipped"], ["api-key", "passed"]]);
  assert.equal(server.headers[1]["api-key"], cfg.apiKey);
  assert.equal(server.headers[1].authorization, undefined);
});

test("Q2: explicit Entra mode uses supplied Bearer, never Function minting or API-key fallback", async t => {
  const server = await fakeServer(t);
  const cfg = probe.loadConfig({ command: "inspect", auth: "entra", "timeout-ms": "1000" }, {
    AOAI_ENDPOINT: server.origin, AOAI_REALTIME_DEPLOYMENT: MODEL, PROBE_ENTRA_TOKEN: "injected-entra-token",
  });
  const report = await probe.execute(cfg, probe.createContext(cfg), { allowLocal: true,
    fetch: async () => { throw new Error("Entra mode must not mint a Function ephemeral token."); },
  });
  assert.equal(report.status, "completed");
  assert.equal(report.tokenRequests.length, 0);
  assert.equal(server.headers[0].authorization, `Bearer ${cfg.entraToken}`);
  assert.equal(server.headers[0]["api-key"], undefined);
  assert.equal(report.probes[0].attempts[0].auth.kind, "entra");
  for (const key of ["Q1", "Q4", "Q10"]) assert.equal(report.questions[key].status, "skipped");
  assert.equal(report.questions.Q5.evidence.maxAuthRetries, 0);
  assert.equal(report.questions.Q6.evidence.tokenVoice, null);
  assert.match(report.questions.Q6.evidence.mintComparison, /skipped/);
});

test("Entra-only audio CLI needs just endpoint/deployment/token env, persists separate input/assistant transcripts", async t => {
  const server = await fakeServer(t, streamingServer());
  let report;
  const exit = await probe.main(["audio", "--auth", "entra", "--wav", "question.wav", "--report", "entra.json", "--timeout-ms", "1000"], {
    AOAI_ENDPOINT: server.origin, AOAI_REALTIME_DEPLOYMENT: MODEL, PROBE_ENTRA_TOKEN: "injected-entra-token",
  }, {
    allowLocal: true, sleep: async () => {}, quietMs: 5, pollMs: 2,
    fetch: async () => { throw new Error("Direct Entra audio must not access the Function."); },
    readFile: async () => probe.makeWav(inputPcm(), 16000),
    writeFile: async (_, text) => { report = JSON.parse(text); },
    stdout() {}, stderr(message) { assert.fail(message); },
  });
  assert.equal(exit, 0);
  assert.equal(report.tokenRequests.length, 0);
  assert.equal(report.input.wireRate, 24000);
  assert.equal(report.probes[0].attempts[0].inputTranscripts[0].status, "completed");
  assert.equal(report.probes[0].attempts[0].assistantTranscripts[0].transcript, "お答えします。");
  for (const key of ["Q1", "Q4", "Q10"]) assert.equal(report.questions[key].status, "skipped");
  assert.ok(!JSON.stringify(report).includes("injected-entra-token"));
});

test("Q8: same-WAV matrix exercises all models plus custom; unsupported model remains explicit failure", async t => {
  const server = await fakeServer(t, streamingServer({ rejectModel: "custom-ja-deployment" }));
  const wav = probe.makeWav(inputPcm(), 16000);
  const cfg = config({ command: "transcribe-matrix", auth: "api-key", endpoint: server.origin, wav: "in-memory.wav", "custom-transcription": "custom-ja-deployment" });
  const ctx = probe.createContext(cfg);
  let reads = 0;
  const report = await probe.execute(cfg, ctx, { allowLocal: true, readFile: async () => { reads++; return wav; }, sleep: async () => {}, quietMs: 40, pollMs: 2 });
  assert.equal(reads, 1);
  assert.deepEqual(report.probes.map(p => p.label), [...probe.TRANSCRIPTION_MODELS, "custom-ja-deployment"]);
  assert.equal(report.probes.at(-1).status, "failed");
  assert.equal(report.probes.at(-1).attempts[0].error.category, "realtime-error");
  assert.equal(report.probes.at(-1).attempts[0].failures[0].error.code, "unsupported_model");
  assert.equal(report.input.sourceRate, 16000);
  assert.equal(report.input.wireRate, 24000);
  assert.equal(report.questions.Q8.evidence.sameWav.sha256, report.input.sha256);
  const updates = server.received.filter(e => e.type === "session.update");
  assert.deepEqual(updates.map(e => e.session.audio.input.transcription?.model ?? "disabled"), [...probe.TRANSCRIPTION_MODELS, "custom-ja-deployment"]);
});

test("Q5: soak requires explicit small bounds; concurrent idle observations do not claim service limits", async t => {
  for (const args of [
    { command: "soak" }, { command: "soak", "allow-load": true, seconds: "1", concurrency: "5" },
    { command: "soak", "allow-load": true, seconds: "3601", concurrency: "1" },
    { command: "inspect", "allow-load": true }, { command: "inspect", seconds: "1" },
  ]) assert.throws(() => probe.loadConfig(args, {}));
  const server = await fakeServer(t);
  const cfg = config({ command: "soak", auth: "api-key", endpoint: server.origin, holdMs: 35, concurrency: 2 });
  const report = await probe.execute(cfg, probe.createContext(cfg), { allowLocal: true, pollMs: 2 });
  assert.equal(report.status, "completed");
  assert.equal(report.probes.length, 2);
  assert.ok(report.probes.every(p => p.attempts[0].observationMs >= 35));
  assert.equal(report.concurrency.peakObservedReadyConnections, 2);
  assert.match(report.concurrency.observation, /not proof of service concurrency limit/);
});

test("Q11: network probe targets one configured host on 443 with TLS certificate validation", async () => {
  let dnsCalls = 0, options;
  const result = await probe.networkProbe(config(), {
    lookup: async (host, opts) => { dnsCalls++; assert.equal(host, "example.openai.azure.com"); assert.deepEqual(opts, { all: true }); return [{ address: "192.0.2.1", family: 4 }]; },
    tlsConnect: opts => {
      options = opts;
      const connection = new EventEmitter();
      Object.assign(connection, { authorized: true, getProtocol: () => "TLSv1.3", destroy() {} });
      queueMicrotask(() => connection.emit("secureConnect"));
      return connection;
    },
  });
  assert.equal(dnsCalls, 1);
  assert.deepEqual(options, { host: "example.openai.azure.com", servername: "example.openai.azure.com", port: 443, rejectUnauthorized: true });
  assert.equal(result.tls.authorized, true);
  assert.match(result.websocket, /unverified/);
  for (const [error, category] of [
    [{ code: "ENOTFOUND" }, "dns"], [{ cause: { code: "EAI_AGAIN" } }, "dns"],
    [{ code: "CERT_HAS_EXPIRED" }, "tls"], [{ code: "ECONNREFUSED" }, "tcp"], [{ name: "TimeoutError" }, "timeout"],
  ]) assert.equal(probe.classifyError(error), category);
});

test("Q11: network failure is classified and never marked successful or treated as a limit", async () => {
  const cfg = config({ command: "network" });
  const report = await probe.execute(cfg, probe.createContext(cfg), {
    lookup: async () => { const error = new Error("Configured host lookup failed."); error.code = "ENOTFOUND"; throw error; },
    tlsConnect: () => { throw new Error("TLS must not run after failed lookup."); },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.error.category, "dns");
  assert.equal(report.questions.Q11.status, "failed");
});

test("Q12: TTS exact official preview request, separate auth, no implicit ephemeral fallback", () => {
  const cfg = config({ ttsEndpoint: ENDPOINT, ttsDeployment: "tts-custom", ttsApiKey: "tts-independent", "tts-auth": "api-key" });
  const request = probe.ttsRequest(cfg);
  assert.equal(request.url, `${ENDPOINT}/openai/v1/audio/speech?api-version=preview`);
  assert.equal(request.headers["api-key"], "tts-independent");
  assert.deepEqual(request.body, { model: "tts-custom", input: "こんにちは。音声の接続テストです。", voice: "coral", response_format: "mp3" });
  assert.throws(() => probe.ttsRequest({ ...cfg, ttsApiKey: undefined }), /separate/);
  assert.throws(() => probe.ttsRequest({ ...cfg, "tts-auth": undefined }), /explicit/);
  assert.throws(() => probe.ttsRequest({ ...cfg, ttsApiKey: TOKEN }, credential(probe.buildRealtimeUrl(ENDPOINT, MODEL))), /Refusing accidental/);
  assert.throws(() => probe.ttsRequest({ ...cfg, "negative-ephemeral": true }), /freshly minted/);
  const negative = probe.ttsRequest({ ...cfg, "negative-ephemeral": true }, credential(probe.buildRealtimeUrl(ENDPOINT, MODEL)));
  assert.equal(negative.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(negative.kind, "negative-realtime-ephemeral");
});

test("Q12: TTS MP3 response evidence/write and explicit negative ephemeral 401 evidence (fake HTTP only)", async () => {
  const cfg = config({ command: "tts", ttsEndpoint: ENDPOINT, ttsDeployment: "tts-custom", ttsApiKey: "tts-independent", "tts-auth": "api-key", "output-mp3": "memory.mp3" });
  let output;
  const report = await probe.execute(cfg, probe.createContext(cfg), {
    fetch: async (url, options) => {
      assert.match(url, /audio\/speech\?api-version=preview$/);
      assert.equal(options.headers["api-key"], "tts-independent");
      assert.equal(options.redirect, "error");
      return new Response(Buffer.from("ID3-test-audio"), { headers: { "Content-Type": "audio/mpeg" } });
    },
    writeFile: async (name, content, options) => { assert.equal(name, "memory.mp3"); assert.equal(options.flag, "wx"); output = content; },
  });
  assert.equal(report.status, "completed");
  assert.ok(output.length > 0);
  assert.equal(report.probes[0].audio.mp3HeaderObserved, true);
  assert.ok(!JSON.stringify(report).includes("tts-independent"));
  const negativeCfg = { ...cfg, "negative-ephemeral": true, "output-mp3": undefined };
  let calls = 0;
  const negative = await probe.execute(negativeCfg, probe.createContext(negativeCfg), { fetch: async (_, options) => {
    if (++calls === 1) return Response.json({ transport: "websocket", model: MODEL, websocket_url: probe.buildRealtimeUrl(ENDPOINT, MODEL), ephemeral_token: TOKEN });
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    return Response.json({ error: { code: "invalid_api_key", message: `Rejected ${TOKEN}` } }, { status: 401 });
  } });
  assert.equal(negative.probes[0].status, "observed-rejection");
  assert.equal(negative.probes[0].httpStatus, 401);
  assert.ok(!JSON.stringify(negative).includes(TOKEN));
});

test("OpenAI direct control remains configurable and uses its own Bearer API key", async () => {
  const cfg = probe.loadConfig({ command: "openai" }, { OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_MODEL: "gpt-realtime", OPENAI_API_KEY: "openai-independent" });
  const auth = await probe.acquireCredential("api-key", cfg, probe.createContext(cfg));
  assert.equal(auth.url, "wss://api.openai.com/v1/realtime?model=gpt-realtime");
  assert.equal(auth.headers.Authorization, "Bearer openai-independent");
  assert.equal(auth.headers["api-key"], undefined);
  assert.equal(auth.kind, "openai-api-key");
  assert.throws(() => probe.buildRealtimeUrl("https://example.azurewebsites.net", "gpt-realtime", "openai"));
});

test("CLI help is offline, secret flags are rejected safely, bounds enforced, reports persist redacted", async () => {
  let output = "", error = "", saved;
  const io = { stdout: text => { output = text; }, stderr: text => { error = text; },
    fetch: async () => { throw new Error("No live calls permitted in this test."); } };
  assert.equal(await probe.main(["--help"], {}, io), 0);
  assert.match(output, /transcribe-matrix/);
  assert.match(output, /PROBE_FUNCTION_KEY/);
  assert.equal(await probe.main(["--api-key", "secret-command-line-value"], {}, io), 1);
  assert.ok(!error.includes("secret-command-line-value"));
  for (const args of [
    { command: "inspect", "timeout-ms": "0" }, { command: "inspect", "auth-retries": "3" },
    { command: "audio" }, { command: "inspect", "reuse-token": true }, { command: "inspect", "negative-ephemeral": true },
    { command: "inspect", wav: "input.wav" }, { command: "openai", "output-wav": "output.wav" },
    { command: "inspect", "output-mp3": "output.mp3" },
    { command: "tts", "negative-ephemeral": true, "tts-auth": "api-key" },
  ]) assert.throws(() => probe.loadConfig(args, {}));
  const code = await probe.main(["inspect", "--report", "in-memory-report.json"], {
    PROBE_FUNCTION_URL: "https://function.azurewebsites.net/api/realtime-access?code=private-function-code",
  }, { ...io, fetch: async () => Response.json({ error: "private-function-code" }, { status: 400 }),
    writeFile: async (name, text, options) => { assert.equal(name, "in-memory-report.json"); assert.equal(options.flag, "wx"); saved = JSON.parse(text); },
  });
  assert.equal(code, 1);
  assert.equal(saved.status, "failed");
  assert.ok(!output.includes("private-function-code"));
  assert.ok(Object.keys(saved.questions).every(key => saved.questions[key].status));
  assert.equal(Object.keys(saved.questions).length, 13);
});
