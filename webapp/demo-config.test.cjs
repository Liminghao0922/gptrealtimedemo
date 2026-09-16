const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readConfig, functionAccessUrl } = require("./demo-config.cjs");

const env = {
  WEBSITE_HOSTNAME: "test.azurewebsites.net",
  AOAI_ENDPOINT: "https://example.openai.azure.com/",
  AOAI_REALTIME_DEPLOYMENT: "realtime demo",
  DEMO_ACCESS_KEY: "test-demo-access-key-with-32-characters",
  FUNCTION_ACCESS_URL: "https://function.azurewebsites.net/api/realtime-access"
};

test("cloud configuration requires a separate Function and protected relay; local static mode remains usable", () => {
  const local = readConfig({});
  assert.equal(local.endpoint, null);
  assert.equal(local.functionUrl, null);
  assert.throws(() => readConfig({ NODE_ENV: "production" }), /Production requires/);
  const config = readConfig(env);
  assert.equal(config.publicOrigin, "https://test.azurewebsites.net");
  assert.equal(config.endpoint, "https://example.openai.azure.com");
  assert.equal(config.functionUrl, env.FUNCTION_ACCESS_URL);
  for (const field of ["AOAI_ENDPOINT", "AOAI_REALTIME_DEPLOYMENT", "DEMO_ACCESS_KEY", "FUNCTION_ACCESS_URL"]) {
    assert.throws(() => readConfig({ ...env, [field]: "" }), /Production requires/);
  }
  assert.throws(() => readConfig({
    ...env, FUNCTION_ACCESS_URL: "https://test.azurewebsites.net/api/realtime-access"
  }), /separate Function host/);
});

test("relay resource, origin and key validation remain strict", () => {
  for (const AOAI_ENDPOINT of ["http://example.openai.azure.com", "https://evil.example",
    "https://example.openai.azure.com/path", "https://example.openai.azure.com?api-key=value",
    "https://user:password@example.openai.azure.com"]) {
    assert.throws(() => readConfig({ ...env, AOAI_ENDPOINT }));
  }
  assert.throws(() => readConfig({ ...env, PUBLIC_ORIGIN: "http://test.azurewebsites.net" }));
  for (const DEMO_ACCESS_KEY of ["short", "x".repeat(1025), "x".repeat(32) + "\n"]) {
    assert.throws(() => readConfig({ ...env, DEMO_ACCESS_KEY }));
  }
});

test("published Function configuration cannot contain secrets or insecure remote URLs", () => {
  for (const value of [
    "/api/realtime-access", "not a URL", "https://function.azurewebsites.net",
    `${env.FUNCTION_ACCESS_URL}?code=secret`, `${env.FUNCTION_ACCESS_URL}#secret`,
    "https://user:password@function.azurewebsites.net/api/realtime-access",
    "http://function.azurewebsites.net/api/realtime-access",
    "http://localhost.evil.example/api/realtime-access",
    "javascript:alert(1)"
  ]) {
    assert.throws(() => functionAccessUrl(value), /FUNCTION_ACCESS_URL must/);
  }
  assert.equal(functionAccessUrl(env.FUNCTION_ACCESS_URL, true), env.FUNCTION_ACCESS_URL);
  for (const host of ["localhost", "127.0.0.1"]) {
    const url = `http://${host}:7071/api/realtime-access`;
    assert.equal(functionAccessUrl(url), url);
    assert.throws(() => functionAccessUrl(url, true), /FUNCTION_ACCESS_URL must/);
  }
});
