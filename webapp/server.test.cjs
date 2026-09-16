const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once, EventEmitter } = require("node:events");
const http = require("node:http");
const { WebSocket } = require("ws");
const { createDemoServer, validateConnection, DEMO_LIMITS } = require("./server.cjs");

const connection = {
  type: "connect",
  url: "wss://example.openai.azure.com/openai/v1/realtime?model=gpt-realtime",
  token: "ephemeral-test-token"
};

async function start(t, connect, options = {}) {
  const server = createDemoServer(connect, { config: {}, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const port = server.address().port;
  return {
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://localhost:${port}/realtime-relay`,
    origin: `http://localhost:${port}`
  };
}

test("relay validates destination and never allows credentials in the URL", () => {
  assert.equal(validateConnection(JSON.stringify(connection)).target.hostname, "example.openai.azure.com");
  for (const url of [
    "ws://example.openai.azure.com/openai/v1/realtime?model=gpt-realtime",
    "wss://127.0.0.1/openai/v1/realtime?model=gpt-realtime",
    "wss://example.openai.azure.com.evil.example/openai/v1/realtime?model=gpt-realtime",
    `${connection.url}&api-key=secret`,
    `${connection.url}&model=another`,
    `${connection.url}#secret`,
    "wss://user:password@example.openai.azure.com/openai/v1/realtime?model=test",
    "wss://example.openai.azure.com:8080/openai/v1/realtime?model=test",
    "wss://example.openai.azure.com/not-realtime?model=test"
  ]) assert.throws(() => validateConnection(JSON.stringify({ ...connection, url })));
  for (const token of ["", "\r\ninjected-header", 42, null]) {
    assert.throws(() => validateConnection(JSON.stringify({ ...connection, token })));
  }
});

const demoKey = "test-demo-key-with-at-least-32-characters";

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const content = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode,
          headers: new Headers(res.headers),
          text: async () => content,
          json: async () => JSON.parse(content)
        });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("protects cloud token issuance by key, exact origin and host, not query strings", async t => {
  const publicOrigin = "https://demo.azurewebsites.net";
  let calls = 0;
  const { httpUrl } = await start(t, undefined, {
    config: { publicOrigin, accessKey: demoKey, production: true },
    issueToken: async (body, transport) => {
      calls++;
      assert.equal(body.transport, "websocket");
      assert.equal(transport, null);
      return { ephemeral_token: "ephemeral-test-token" };
    }
  });
  const headers = { "content-type": "application/json", host: "demo.azurewebsites.net", origin: publicOrigin };
  const post = (extra = {}, query = "") => httpPost(`${httpUrl}/api/realtime-access${query}`,
    { ...headers, ...extra }, '{"transport":"websocket"}');
  assert.equal((await post()).status, 401);
  assert.equal((await post({}, `?code=${demoKey}`)).status, 401);
  assert.equal((await post({ "x-demo-key": "bad" })).status, 401);
  assert.equal((await post({ "x-demo-key": demoKey, origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ "x-demo-key": demoKey, host: "evil.example" })).status, 403);
  assert.equal(calls, 0);
  const result = await post({ "x-demo-key": demoKey });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await result.json(), { ephemeral_token: "ephemeral-test-token" });
  assert.equal((await post({ "x-functions-key": demoKey })).status, 200);
  assert.equal((await fetch(`${httpUrl}/api/realtime-access`)).status, 405);
  assert.equal(calls, 2);
});

test("token request errors and rate limits are explicit without leaking secrets", async t => {
  const logs = [];
  let clock = 60000;
  let calls = 0;
  const { httpUrl, origin } = await start(t, undefined, {
    now: () => clock,
    limits: { tokenRequests: 3 },
    logger: { error: (...args) => logs.push(args) },
    issueToken: async () => {
      calls++;
      throw new Error(`private detail ${demoKey}`);
    }
  });
  const headers = { "content-type": "application/json", host: new URL(origin).host };
  const post = body => httpPost(`${httpUrl}/api/realtime-access`, headers, body);
  assert.equal((await post("invalid JSON")).status, 400);
  assert.equal((await post(JSON.stringify({ text: "x".repeat(17000) }))).status, 413);
  const error = await post("{}");
  assert.equal(error.status, 500);
  assert.equal((await error.text()).includes(demoKey), false);
  const limited = await post("{}");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(calls, 1);
  clock += 60000;
  assert.equal((await post("{}")).status, 500);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(logs).includes(demoKey), false);
});

test("cloud relay authenticates the first frame and pins the resource and deployment", async t => {
  const config = {
    publicOrigin: "https://demo.azurewebsites.net", accessKey: demoKey,
    endpoint: "https://example.openai.azure.com", deployment: "gpt-realtime"
  };
  const { wsUrl } = await start(t, () => assert.fail("Must not contact Azure"), { config });
  for (const frame of [
    connection,
    { ...connection, access_key: "wrong" },
    { ...connection, access_key: demoKey, url: connection.url.replace("example.", "another.") },
    { ...connection, access_key: demoKey, url: connection.url.replace("model=gpt-realtime", "model=other") }
  ]) {
    const client = new WebSocket(wsUrl, { origin: config.publicOrigin, headers: { host: "demo.azurewebsites.net" } });
    t.after(() => client.terminate());
    await once(client, "open");
    const message = once(client, "message");
    const closed = once(client, "close");
    client.send(JSON.stringify(frame));
    const result = (await message)[0].toString();
    assert.equal(JSON.parse(result).type, "relay.error");
    assert.equal(result.includes(demoKey), false);
    await closed;
  }
});

test("relay enforces active session limit and releases slots on disconnect", async t => {
  const { wsUrl, origin } = await start(t, () => {
    const upstream = new EventEmitter();
    upstream.readyState = WebSocket.OPEN;
    upstream.close = () => { upstream.readyState = WebSocket.CLOSED; upstream.emit("close"); };
    process.nextTick(() => upstream.emit("open"));
    return upstream;
  }, { config: { accessKey: demoKey }, limits: { relays: 1, sessionMs: 300 } });
  const client = new WebSocket(wsUrl, { origin });
  t.after(() => client.terminate());
  await once(client, "open");
  const ready = once(client, "message");
  client.send(JSON.stringify({ ...connection, access_key: demoKey }));
  assert.equal(JSON.parse((await ready)[0]).type, "relay.ready");
  const expired = once(client, "message");
  const closed = once(client, "close");
  const extra = new WebSocket(wsUrl, { origin });
  t.after(() => extra.terminate());
  assert.match((await once(extra, "error"))[0].message, /429/);
  assert.match(JSON.parse((await expired)[0]).error.message, /time limit/);
  await closed;
  const next = new WebSocket(wsUrl, { origin });
  t.after(() => next.terminate());
  await once(next, "open");
  const nextClosed = once(next, "close");
  next.close();
  await nextClosed;
});

test("default issuance limit is exactly twelve requests per minute", async t => {
  assert.deepEqual(DEMO_LIMITS, { relays: 2, pending: 4, tokenRequests: 12, sessionMs: 900000 });
  let count = 0;
  const { httpUrl, origin } = await start(t, undefined, {
    issueToken: async () => ({ sequence: ++count })
  });
  const post = () => httpPost(`${httpUrl}/api/realtime-access`,
    { "content-type": "application/json", host: new URL(origin).host }, "{}");
  for (let n = 0; n < 12; n++) assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 429);
  assert.equal(count, 12);
});

test("token issuer admits two simultaneous requests and refuses the third", async t => {
  const releases = [];
  let bothStarted;
  const started = new Promise(resolve => { bothStarted = resolve; });
  const { httpUrl, origin } = await start(t, undefined, {
    issueToken: () => new Promise(resolve => {
      releases.push(resolve);
      if (releases.length === 2) bothStarted();
    })
  });
  const post = () => httpPost(`${httpUrl}/api/realtime-access`,
    { "content-type": "application/json", host: new URL(origin).host }, "{}");
  const first = post();
  const second = post();
  await started;
  try {
    assert.equal((await post()).status, 429);
    assert.equal(releases.length, 2);
  } finally {
    for (const release of releases) release({ ephemeral_token: "test-token" });
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  }
});

test("default relay allows exactly two active connections", async t => {
  const { wsUrl, origin } = await start(t, () => {
    const upstream = new EventEmitter();
    upstream.readyState = WebSocket.OPEN;
    upstream.close = () => { upstream.readyState = WebSocket.CLOSED; upstream.emit("close"); };
    process.nextTick(() => upstream.emit("open"));
    return upstream;
  });
  const active = [];
  try {
    for (let i = 0; i < 2; i++) {
      const client = new WebSocket(wsUrl, { origin });
      active.push(client);
      await once(client, "open");
      const ready = once(client, "message");
      client.send(JSON.stringify(connection));
      assert.equal(JSON.parse((await ready)[0]).type, "relay.ready");
    }
    const third = new WebSocket(wsUrl, { origin });
    t.after(() => third.terminate());
    assert.match((await once(third, "error"))[0].message, /429/);
  } finally {
    await Promise.all(active.map(client => new Promise(resolve => {
      client.once("close", resolve);
      client.close();
    })));
  }
});

test("serves demo HTML but not settings, node_modules, or source", async t => {
  const { httpUrl } = await start(t);
  assert.equal((await fetch(httpUrl)).status, 200);
  assert.equal((await fetch(`${httpUrl}/gpt-realtime-websocket-demo.html`)).status, 200);
  const script = await fetch(`${httpUrl}/realtime-experiments.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /text\/javascript/);
  assert.match(await script.text(), /ExperimentRecorder/);
  for (const name of ["server.cjs", "customer-probe.cjs", "realtime-experiments.test.cjs", "package.json", "../api/local.settings.json", "node_modules/ws/index.js"]) {
    assert.equal((await fetch(`${httpUrl}/${name}`)).status, 404);
  }
});

test("rejects WebSocket upgrades from another origin", async t => {
  const { wsUrl } = await start(t);
  const client = new WebSocket(wsUrl, { origin: "https://untrusted.example" });
  t.after(() => client.terminate());
  const [error] = await once(client, "error");
  assert.match(error.message, /403/);
});

test("adds Bearer header, relays events bidirectionally, closes upstream", async t => {
  let upstream;
  const { wsUrl, origin } = await start(t, (url, options) => {
    assert.equal(url.href, connection.url);
    assert.equal(options.headers.Authorization, `Bearer ${connection.token}`);
    upstream = new EventEmitter();
    upstream.readyState = WebSocket.CONNECTING;
    upstream.bufferedAmount = 0;
    upstream.send = data => {
      assert.equal(JSON.parse(data).type, "response.create");
      upstream.emit("message", Buffer.from('{"type":"response.done"}'), false);
    };
    upstream.close = () => {
      upstream.readyState = WebSocket.CLOSED;
      upstream.emit("close");
    };
    process.nextTick(() => {
      upstream.readyState = WebSocket.OPEN;
      upstream.emit("open");
    });
    return upstream;
  });
  const client = new WebSocket(wsUrl, { origin });
  t.after(() => client.terminate());
  await once(client, "open");
  let nextMessage = once(client, "message");
  client.send(JSON.stringify(connection));
  assert.equal(JSON.parse((await nextMessage)[0]).type, "relay.ready");
  nextMessage = once(client, "message");
  client.send('{"type":"response.create"}');
  assert.equal(JSON.parse((await nextMessage)[0]).type, "response.done");
  const closed = once(client, "close");
  const upstreamClosed = once(upstream, "close");
  client.close();
  await closed;
  await upstreamClosed;
  assert.equal(upstream.readyState, WebSocket.CLOSED);
});

test("invalid connect message is surfaced without contacting upstream", async t => {
  const { wsUrl, origin } = await start(t, () => assert.fail("Must not connect upstream"));
  const client = new WebSocket(wsUrl, { origin });
  t.after(() => client.terminate());
  await once(client, "open");
  const message = once(client, "message");
  const closed = once(client, "close");
  client.send("invalid JSON");
  assert.equal(JSON.parse((await message)[0]).type, "relay.error");
  await closed;
});
