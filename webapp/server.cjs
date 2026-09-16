const http = require("node:http");
const path = require("node:path");
const { readFile } = require("node:fs/promises");
const { createHash, timingSafeEqual } = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");
const { readConfig } = require("./demo-config.cjs");

const MAX_BUFFERED_BYTES = 1024 * 1024;
const PUBLIC_FILES = new Set([
  "index.html", "gpt-realtime-livevoice-demo.html", "gpt-realtime_function_call_map.html",
  "gpt-realtime-websocket-demo.html", "realtime-experiments.js"
]);
const DEMO_LIMITS = { relays: 2, pending: 4, sessionMs: 15 * 60 * 1000 };

function validateConnection(message, config = {}) {
  const { type, url, token, access_key: accessKey } = JSON.parse(message);
  if (type !== "connect" || typeof url !== "string" ||
      typeof token !== "string" || token.length > 8192 || !/^[!-~]+$/.test(token)) {
    throw new Error("Expected a connect message with an Azure URL and ephemeral token.");
  }
  const target = new URL(url);
  if (target.protocol !== "wss:" || !target.hostname.endsWith(".openai.azure.com") ||
      target.port || target.username || target.password || target.hash ||
      target.pathname !== "/openai/v1/realtime" || target.searchParams.getAll("model").length !== 1 ||
      !target.searchParams.get("model") ||
      [...target.searchParams.keys()].some(key => key !== "model")) {
    throw new Error("Only Azure OpenAI Realtime wss endpoints with a model are allowed.");
  }
  if (config.endpoint && target.hostname !== new URL(config.endpoint).hostname ||
      config.deployment && target.searchParams.get("model") !== config.deployment) {
    throw new Error("The relay accepts only the configured Azure resource and deployment.");
  }
  return { target, token, accessKey };
}

function keyMatches(actual, expected) {
  if (!expected) return true;
  if (typeof actual !== "string" || actual.length > 1024) return false;
  const hash = value => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(actual), hash(expected));
}

function createDemoServer(connect = (url, options) => new WebSocket(url, options), options = {}) {
  const config = options.config ?? readConfig();
  const limits = { ...DEMO_LIMITS, ...options.limits };
  const logger = options.logger ?? console;
  let activeRelays = 0;
  const origin = () => config.publicOrigin ?? `http://localhost:${server.address().port}`;
  const trusted = req => req.headers.host === new URL(origin()).host &&
    (!req.headers.origin || req.headers.origin === origin());
  const json = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }).end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (config.production) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      json(res, 400, { error: "Invalid request URL." });
      return;
    }
    if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) {
      json(res, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/api/realtime-access") {
      json(res, 410, {
        error: "Token issuance has moved to Azure Functions. Use the Function URL with x-functions-key; this endpoint does not redirect credentials.",
        code: "function_issuer_required"
      });
      return;
    }
    if (url.pathname === "/api/demo-config") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        json(res, 405, { error: "Use GET for public demo configuration." });
        return;
      }
      if (!config.functionUrl) {
        json(res, 503, { error: "No default Function URL is configured. Set FUNCTION_ACCESS_URL on the host or enter a Function URL in the page." });
        return;
      }
      json(res, 200, { function_url: config.functionUrl });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("Method not allowed");
      return;
    }
    const pathname = url.pathname;
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!PUBLIC_FILES.has(name)) {
      res.writeHead(404).end("Not found");
      return;
    }
    try {
      const content = await readFile(path.join(__dirname, name));
      res.writeHead(200, {
        "Content-Type": name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (error.code === "ENOENT") {
        res.writeHead(404).end("Not found");
      } else {
        logger.error("Failed to serve demo:", error.code);
        res.writeHead(500).end("Failed to serve demo");
      }
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  const relay = new WebSocketServer({ noServer: true, maxPayload: MAX_BUFFERED_BYTES });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/realtime-relay" || !req.headers.origin || !trusted(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (relay.clients.size >= limits.pending || activeRelays >= limits.relays) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    relay.handleUpgrade(req, socket, head, client => relay.emit("connection", client));
  });
  relay.on("connection", client => {
    let upstream;
    let initialized = false;
    let failed = false;
    let counted = false;
    let lifetime;
    let termination;
    const fail = message => {
      if (failed) return;
      failed = true;
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "relay.error", error: { message } }));
        client.close(1011, "Realtime relay failed");
        termination ??= setTimeout(() => client.terminate(), 1000);
        termination.unref();
      }
      if (upstream) upstream.close();
    };
    let timeout = setTimeout(() => fail("Send an authenticated connect message within five seconds."), 5000);
    client.on("message", (data, isBinary) => {
      if (isBinary) {
        fail("Realtime events must be JSON text.");
        return;
      }
      if (!initialized) {
        initialized = true;
        let connection;
        try {
          connection = validateConnection(data.toString(), config);
        } catch {
          fail("Invalid connect message or unapproved Azure resource/deployment.");
          return;
        }
        if (!keyMatches(connection.accessKey, config.accessKey)) {
          fail("A valid Demo access key is required for the relay.");
          return;
        }
        if (activeRelays >= limits.relays) {
          fail("Demo relay concurrency limit reached. Try again after another session ends.");
          return;
        }
        activeRelays++;
        counted = true;
        clearTimeout(timeout);
        timeout = setTimeout(() => fail("Timed out connecting to Azure Realtime."), 20000);
        lifetime = setTimeout(() => fail("Demo relay session time limit reached. Start a new session."), limits.sessionMs);
        try {
          upstream = connect(connection.target, {
            headers: { Authorization: `Bearer ${connection.token}` },
            handshakeTimeout: 15000,
            maxPayload: MAX_BUFFERED_BYTES
          });
        } catch {
          fail("Azure WebSocket connection could not be started.");
          return;
        }
        upstream.on("open", () => {
          clearTimeout(timeout);
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "relay.ready" }));
          } else {
            upstream.close();
          }
        });
        upstream.on("message", (event, binary) => {
          if (client.readyState !== WebSocket.OPEN) return;
          if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
            fail("Browser playback connection is too slow.");
          } else {
            client.send(event, { binary });
          }
        });
        upstream.on("unexpected-response", (_, response) => {
          response.resume();
          fail(`Azure WebSocket handshake failed (HTTP ${response.statusCode}).`);
        });
        upstream.on("error", () => fail("Azure WebSocket connection failed."));
        upstream.on("close", () => {
          clearTimeout(timeout);
          if (client.readyState === WebSocket.OPEN) client.close(1000, "Azure connection closed");
        });
      } else if (upstream?.readyState !== WebSocket.OPEN) {
        fail("Wait for relay.ready before sending Realtime events.");
      } else if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) {
        fail("Azure connection is too slow to accept audio.");
      } else {
        upstream.send(data, { binary: false });
      }
    });
    client.on("error", () => {
      logger.error("Browser WebSocket client connection failed.");
      if (upstream) upstream.close();
    });
    client.on("close", () => {
      clearTimeout(timeout);
      clearTimeout(lifetime);
      clearTimeout(termination);
      if (counted) activeRelays--;
      if (upstream) upstream.close();
    });
  });
  server.on("close", () => relay.close());
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  const server = createDemoServer();
  server.listen(port, process.env.WEBSITE_HOSTNAME ? "0.0.0.0" : "127.0.0.1", () => {
    console.log(`Realtime demos listening on port ${port}.`);
    console.log("Pages and WebSocket relay enabled; Azure Functions issues tokens. Credentials are not logged or stored.");
  });
}

module.exports = { createDemoServer, validateConnection, keyMatches, DEMO_LIMITS };
