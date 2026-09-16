import json
import os
import urllib.error
import urllib.parse
import urllib.request

import azure.functions as func
from azure.identity import DefaultAzureCredential

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)
credential = DefaultAzureCredential()
COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default"


def _trim_end_slash(url: str) -> str:
    return url[:-1] if url.endswith("/") else url


def _get_aoai_auth_headers() -> dict[str, str] | None:
    api_key = os.getenv("AOAI_API_KEY")
    if api_key:
        return {"api-key": api_key}

    try:
        aad_token = credential.get_token(COGNITIVE_SCOPE).token
    except Exception:
        return None

    return {"Authorization": f"Bearer {aad_token}"}


def _get_transport(request_body: dict, req: func.HttpRequest) -> str:
    requested_transport = request_body.get("transport")
    if requested_transport is None:
        requested_transport = req.params.get("transport", "webrtc")

    if not isinstance(requested_transport, str):
        raise ValueError("transport must be either 'webrtc' or 'websocket'")

    transport = requested_transport.strip().lower()
    if transport not in {"webrtc", "websocket"}:
        raise ValueError("transport must be either 'webrtc' or 'websocket'")

    return transport


def _get_realtime_urls(endpoint: str, deployment: str) -> tuple[str, str]:
    parsed_endpoint = urllib.parse.urlsplit(_trim_end_slash(endpoint))
    base_path = parsed_endpoint.path.rstrip("/")
    api_path = f"{base_path}/openai/v1/realtime"
    webrtc_url = urllib.parse.urlunsplit(
        (parsed_endpoint.scheme, parsed_endpoint.netloc, f"{api_path}/calls", "", "")
    )
    websocket_scheme = "wss" if parsed_endpoint.scheme == "https" else "ws"
    websocket_url = urllib.parse.urlunsplit(
        (
            websocket_scheme,
            parsed_endpoint.netloc,
            api_path,
            urllib.parse.urlencode({"model": deployment}),
            "",
        )
    )
    return webrtc_url, websocket_url


@app.route(route="realtime-access", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
def realtime_access(req: func.HttpRequest) -> func.HttpResponse:
    endpoint = os.getenv("AOAI_ENDPOINT")
    deployment = os.getenv("AOAI_REALTIME_DEPLOYMENT")

    if not endpoint or not deployment:
        return func.HttpResponse(
            json.dumps(
                {
                    "error": "Missing required environment variables: AOAI_ENDPOINT, AOAI_REALTIME_DEPLOYMENT"
                }
            ),
            status_code=500,
            mimetype="application/json",
        )

    try:
        request_body = req.get_json()
    except ValueError:
        request_body = {}
    if not isinstance(request_body, dict):
        request_body = {}

    try:
        transport = _get_transport(request_body, req)
    except ValueError as error:
        return func.HttpResponse(
            json.dumps({"error": str(error)}),
            status_code=400,
            mimetype="application/json",
        )

    aoai_endpoint = _trim_end_slash(endpoint)
    token_response_url = f"{aoai_endpoint}/openai/v1/realtime/client_secrets"
    webrtc_url, websocket_url = _get_realtime_urls(endpoint, deployment)

    session_config = {"type": "realtime", "model": deployment}

    voice = request_body.get("voice")
    instructions = request_body.get("instructions")
    if isinstance(voice, str) and voice.strip():
        session_config["audio"] = {"output": {"voice": voice}}
    if isinstance(instructions, str) and instructions.strip():
        session_config["instructions"] = instructions

    auth_headers = _get_aoai_auth_headers()
    if auth_headers is None:
        return func.HttpResponse(
            json.dumps(
                {
                    "error": "Failed to authenticate with Azure OpenAI. Configure AOAI_API_KEY or managed identity."
                }
            ),
            status_code=500,
            mimetype="application/json",
        )

    payload = json.dumps({"session": session_config}).encode("utf-8")
    request_obj = urllib.request.Request(
        token_response_url,
        data=payload,
        method="POST",
        headers={
            **auth_headers,
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request_obj) as response:
            response_body_bytes = response.read()
            status_code = response.getcode()
    except urllib.error.HTTPError as http_error:
        error_body = http_error.read().decode("utf-8", errors="replace")
        try:
            details = json.loads(error_body)
        except json.JSONDecodeError:
            details = {"raw": error_body}

        return func.HttpResponse(
            json.dumps(
                {
                    "error": "Azure OpenAI returned an error",
                    "details": details,
                }
            ),
            status_code=http_error.code,
            mimetype="application/json",
        )
    except urllib.error.URLError:
        return func.HttpResponse(
            json.dumps({"error": "Failed to call Azure OpenAI realtime token endpoint"}),
            status_code=502,
            mimetype="application/json",
        )

    response_text = response_body_bytes.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(response_text) if response_text else {}
    except json.JSONDecodeError:
        parsed = {"raw": response_text}

    ephemeral_token = (
        parsed.get("client_secret", {}).get("value") or parsed.get("value") or None
    )
    expires_at = (
        parsed.get("client_secret", {}).get("expires_at") or parsed.get("expires_at") or None
    )

    body = {
        "transport": transport,
        "realtime_url": websocket_url if transport == "websocket" else webrtc_url,
        "model": deployment,
        "ephemeral_token": ephemeral_token,
        "expires_at": expires_at,
        "session": parsed,
    }
    body["websocket_url" if transport == "websocket" else "webrtc_url"] = (
        websocket_url if transport == "websocket" else webrtc_url
    )

    return func.HttpResponse(
        json.dumps(body),
        status_code=status_code,
        mimetype="application/json",
    )
