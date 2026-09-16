function azureEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".openai.azure.com") ||
      url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
    throw new Error("AOAI_ENDPOINT must be an Azure OpenAI resource HTTPS origin.");
  }
  return url.origin;
}

function functionAccessUrl(value, production = false) {
  const message = "FUNCTION_ACCESS_URL must be an absolute HTTPS Function URL without credentials, query parameters or fragment (local HTTP is allowed only in development).";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  const localHttp = !production && url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password ||
      url.search || url.hash || url.pathname === "/") {
    throw new Error(message);
  }
  return url.href;
}

function readConfig(env = process.env) {
  const production = env.NODE_ENV === "production" || Boolean(env.WEBSITE_HOSTNAME);
  const endpoint = env.AOAI_ENDPOINT ? azureEndpoint(env.AOAI_ENDPOINT) : null;
  const deployment = env.AOAI_REALTIME_DEPLOYMENT?.trim() || null;
  const accessKey = env.DEMO_ACCESS_KEY || "";
  const publicOrigin = env.PUBLIC_ORIGIN ||
    (env.WEBSITE_HOSTNAME ? `https://${env.WEBSITE_HOSTNAME}` : null);
  const functionUrl = env.FUNCTION_ACCESS_URL ? functionAccessUrl(env.FUNCTION_ACCESS_URL, production) : null;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== "https:" || url.origin !== publicOrigin) {
      throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash.");
    }
    if (functionUrl && new URL(functionUrl).origin === publicOrigin) {
      throw new Error("FUNCTION_ACCESS_URL must point to the separate Function host, not this App Service.");
    }
  }
  if (production && (!endpoint || !deployment || !publicOrigin || !functionUrl || accessKey.length < 32)) {
    throw new Error("Production requires AOAI_ENDPOINT, AOAI_REALTIME_DEPLOYMENT, PUBLIC_ORIGIN, FUNCTION_ACCESS_URL and a DEMO_ACCESS_KEY of at least 32 characters.");
  }
  if (accessKey && !/^[!-~]{32,1024}$/.test(accessKey)) {
    throw new Error("DEMO_ACCESS_KEY must contain 32 to 1024 printable non-space ASCII characters.");
  }
  return { production, endpoint, deployment, accessKey, publicOrigin, functionUrl };
}

module.exports = { azureEndpoint, functionAccessUrl, readConfig };
