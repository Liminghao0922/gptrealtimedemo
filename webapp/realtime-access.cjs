const { DefaultAzureCredential, ManagedIdentityCredential } = require("@azure/identity");

const COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default";

class AccessError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function azureEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".openai.azure.com") ||
      url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
    throw new Error("AOAI_ENDPOINT must be an Azure OpenAI resource HTTPS origin.");
  }
  return url.origin;
}

function readConfig(env = process.env) {
  const production = env.NODE_ENV === "production" || Boolean(env.WEBSITE_HOSTNAME);
  const endpoint = env.AOAI_ENDPOINT ? azureEndpoint(env.AOAI_ENDPOINT) : null;
  const deployment = env.AOAI_REALTIME_DEPLOYMENT?.trim() || null;
  const accessKey = env.DEMO_ACCESS_KEY || "";
  const publicOrigin = env.PUBLIC_ORIGIN ||
    (env.WEBSITE_HOSTNAME ? `https://${env.WEBSITE_HOSTNAME}` : null);
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== "https:" || url.origin !== publicOrigin) {
      throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash.");
    }
  }
  if (production && (!endpoint || !deployment || !publicOrigin || accessKey.length < 32)) {
    throw new Error("Production requires AOAI_ENDPOINT, AOAI_REALTIME_DEPLOYMENT, PUBLIC_ORIGIN and a DEMO_ACCESS_KEY of at least 32 characters.");
  }
  if (accessKey && (!/^[!-~]{32,1024}$/.test(accessKey))) {
    throw new Error("DEMO_ACCESS_KEY must contain 32 to 1024 printable non-space ASCII characters.");
  }
  return { production, endpoint, deployment, accessKey, publicOrigin };
}

function normalizeRequest(body, transportQuery) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AccessError(400, "invalid_body", "Request body must be a JSON object.");
  }
  const requested = body.transport ?? transportQuery ?? "webrtc";
  const transport = typeof requested === "string" ? requested.trim().toLowerCase() : "";
  if (transport !== "webrtc" && transport !== "websocket") {
    throw new AccessError(400, "invalid_transport", "transport must be either 'webrtc' or 'websocket'.");
  }
  for (const [name, max] of [["voice", 64], ["instructions", 12000]]) {
    if (body[name] !== undefined && (typeof body[name] !== "string" || body[name].length > max)) {
      throw new AccessError(400, "invalid_session", `${name} must be a string of at most ${max} characters.`);
    }
  }
  return { transport, voice: body.voice?.trim(), instructions: body.instructions?.trim() };
}

function createTokenIssuer(config, { credential, request = fetch } = {}) {
  let identity = credential;
  return async (body, transportQuery) => {
    const { transport, voice, instructions } = normalizeRequest(body, transportQuery);
    if (!config.endpoint || !config.deployment) {
      throw new AccessError(503, "not_configured", "Configure AOAI_ENDPOINT and AOAI_REALTIME_DEPLOYMENT on the server, or select an external Function API.");
    }
    identity ??= config.production ? new ManagedIdentityCredential() : new DefaultAzureCredential();
    const signal = AbortSignal.timeout(15000);
    let access;
    try {
      access = await identity.getToken(COGNITIVE_SCOPE, { abortSignal: signal });
    } catch {
      throw new AccessError(502, "identity_failed", "Server Azure authentication failed. Check managed identity and the Cognitive Services OpenAI User role.");
    }
    if (!access?.token) {
      throw new AccessError(502, "identity_failed", "Azure authentication returned no server access token.");
    }
    const session = { type: "realtime", model: config.deployment };
    if (voice) session.audio = { output: { voice } };
    if (instructions) session.instructions = instructions;
    let response;
    try {
      response = await request(`${config.endpoint}/openai/v1/realtime/client_secrets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session }),
        signal,
        redirect: "error"
      });
    } catch {
      throw new AccessError(502, "upstream_unreachable", "Failed to reach the Azure Realtime client-secret endpoint.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AccessError(response.status === 429 ? 429 : 502, `azure_http_${response.status}`,
        `Azure client-secret issuance failed (HTTP ${response.status}). Check deployment availability and server permissions.`);
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw new AccessError(502, "invalid_upstream_response", "Azure returned an invalid client-secret response.");
    }
    const secret = parsed?.client_secret ?? parsed;
    if (!secret || typeof secret.value !== "string" || !/^[!-~]+$/.test(secret.value) ||
        !Number.isFinite(secret.expires_at) || secret.expires_at <= Date.now() / 1000) {
      throw new AccessError(502, "invalid_upstream_response", "Azure returned no usable, unexpired client secret.");
    }
    const url = new URL(`${config.endpoint}/openai/v1/realtime${transport === "webrtc" ? "/calls" : ""}`);
    if (transport === "websocket") {
      url.protocol = "wss:";
      url.searchParams.set("model", config.deployment);
    }
    return {
      transport,
      realtime_url: url.href,
      [transport === "webrtc" ? "webrtc_url" : "websocket_url"]: url.href,
      model: config.deployment,
      ephemeral_token: secret.value,
      expires_at: secret.expires_at,
      session: parsed,
      token_source: "/openai/v1/realtime/client_secrets"
    };
  };
}

module.exports = { AccessError, azureEndpoint, readConfig, normalizeRequest, createTokenIssuer };
