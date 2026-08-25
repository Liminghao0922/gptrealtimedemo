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

    aoai_endpoint = _trim_end_slash(endpoint)
    token_response_url = f"{aoai_endpoint}/openai/v1/realtime/client_secrets"
    webrtc_url = f"{aoai_endpoint}/openai/v1/realtime/calls"

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
        "webrtc_url": webrtc_url,
        "model": deployment,
        "ephemeral_token": ephemeral_token,
        "expires_at": expires_at,
        "session": parsed,
    }

    return func.HttpResponse(
        json.dumps(body),
        status_code=status_code,
        mimetype="application/json",
    )
