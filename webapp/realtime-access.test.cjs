const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AccessError, readConfig, normalizeRequest, createTokenIssuer } = require("./realtime-access.cjs");

const config = {
  endpoint: "https://example.openai.azure.com",
  deployment: "realtime demo",
  production: true
};
const expires = () => Math.floor(Date.now() / 1000) + 120;
const credential = { getToken: async () => ({ token: "server-entra-token" }) };
const reply = payload => new Response(JSON.stringify(payload), { status: 200 });

test("cloud configuration fails closed; local static-only mode remains usable", () => {
  assert.equal(readConfig({}).endpoint, null);
  assert.throws(() => readConfig({ NODE_ENV: "production" }), /Production requires/);
  const env = {
    WEBSITE_HOSTNAME: "test.azurewebsites.net",
    AOAI_ENDPOINT: `${config.endpoint}/`,
    AOAI_REALTIME_DEPLOYMENT: config.deployment,
    DEMO_ACCESS_KEY: "test-demo-access-key-with-32-characters"
  };
  assert.equal(readConfig(env).publicOrigin, "https://test.azurewebsites.net");
  assert.equal(readConfig(env).endpoint, config.endpoint);
  for (const AOAI_ENDPOINT of ["http://example.openai.azure.com", "https://evil.example",
    "https://example.openai.azure.com/path", "https://example.openai.azure.com?api-key=value",
    "https://user:pass@example.openai.azure.com"]) {
    assert.throws(() => readConfig({ ...env, AOAI_ENDPOINT }));
  }
  assert.throws(() => readConfig({ ...env, PUBLIC_ORIGIN: "http://test.azurewebsites.net" }));
  assert.throws(() => readConfig({ ...env, DEMO_ACCESS_KEY: "short" }));
});

test("request contract defaults to WebRTC and preserves explicit transport precedence", () => {
  assert.equal(normalizeRequest({}).transport, "webrtc");
  assert.equal(normalizeRequest({}, "websocket").transport, "websocket");
  assert.equal(normalizeRequest({ transport: " WeBRTC " }, "websocket").transport, "webrtc");
  for (const body of [null, [], "string", { transport: 42 }, { transport: "http" },
    { voice: false }, { instructions: "x".repeat(12001) }]) {
    assert.throws(() => normalizeRequest(body), error => error instanceof AccessError && error.status === 400);
  }
});

for (const transport of ["webrtc", "websocket"]) {
  for (const nested of [false, true]) {
    test(`issues ${transport} using Entra only server-side; nested=${nested}`, async () => {
      const expiry = expires();
      const issue = createTokenIssuer(config, {
        credential: {
          getToken: async (scope, options) => {
            assert.equal(scope, "https://cognitiveservices.azure.com/.default");
            assert.ok(options.abortSignal);
            return { token: "server-entra-token" };
          }
        },
        request: async (url, options) => {
          assert.equal(url, `${config.endpoint}/openai/v1/realtime/client_secrets`);
          assert.equal(options.headers.Authorization, "Bearer server-entra-token");
          assert.equal(options.redirect, "error");
          assert.deepEqual(JSON.parse(options.body), {
            session: {
              type: "realtime", model: config.deployment,
              audio: { output: { voice: "coral" } }, instructions: "Be brief."
            }
          });
          const secret = { value: "ephemeral-client-secret", expires_at: expiry };
          return reply(nested ? { client_secret: secret, session: { id: "session-test" } } : secret);
        }
      });
      const result = await issue({ transport, voice: "coral", instructions: "Be brief." });
      assert.equal(result.transport, transport);
      assert.equal(result.ephemeral_token, "ephemeral-client-secret");
      assert.equal(result.expires_at, expiry);
      assert.equal(result.token_source, "/openai/v1/realtime/client_secrets");
      assert.equal(result[`${transport}_url`], result.realtime_url);
      assert.equal(JSON.stringify(result).includes("server-entra-token"), false);
      const url = new URL(result.realtime_url);
      assert.equal(url.pathname, `/openai/v1/realtime${transport === "webrtc" ? "/calls" : ""}`);
      if (transport === "websocket") {
        assert.equal(url.protocol, "wss:");
        assert.equal(url.searchParams.get("model"), config.deployment);
      }
    });
  }
}

test("unconfigured and failed identity routes fail explicitly without contacting Azure", async () => {
  const request = () => assert.fail("Must not issue token");
  await assert.rejects(createTokenIssuer({}, { request })({}), { status: 503, code: "not_configured" });
  for (const failing of [
    { getToken: async () => { throw new Error("sensitive credential diagnostic"); } },
    { getToken: async () => null }
  ]) {
    await assert.rejects(createTokenIssuer(config, { credential: failing, request })({}), error => {
      assert.equal(error.code, "identity_failed");
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    });
  }
});

test("upstream failures do not echo response bodies or access tokens", async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const issue = createTokenIssuer(config, {
      credential,
      request: async () => new Response("upstream-secret-material", { status })
    });
    await assert.rejects(issue({}), error => {
      assert.equal(error.status, status === 429 ? 429 : 502);
      assert.equal(error.code, `azure_http_${status}`);
      assert.equal(error.message.includes("upstream-secret-material"), false);
      return true;
    });
  }
  await assert.rejects(createTokenIssuer(config, {
    credential, request: async () => { throw new Error("sensitive network info"); }
  })({}), { code: "upstream_unreachable" });
});

test("a success status without a usable unexpired client secret is not success", async () => {
  for (const payload of [null, {}, [], { value: "" }, { value: "token", expires_at: 1 },
    { value: "token", expires_at: "123" }, { value: "token\nheader", expires_at: expires() }]) {
    await assert.rejects(createTokenIssuer(config, { credential, request: async () => reply(payload) })({}),
      { status: 502, code: "invalid_upstream_response" });
  }
  await assert.rejects(createTokenIssuer(config, {
    credential, request: async () => new Response("<html>error</html>")
  })({}), { code: "invalid_upstream_response" });
});
