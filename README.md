# Azure OpenAI Realtime WebRTC and WebSocket Demos

This sample contains:

- A unified Node.js host for three browser demos, a Realtime client-secret API,
  and a WebSocket relay. It supports local development and Azure App Service F1.
- The existing standalone Python Azure Function, retained as an optional
  alternative token issuer. Existing Function and Static Web App deployments are
  not removed by the unified deployment.

## Unified App Service demo

Deployed entry point: **https://app-realtime-f1-mh0922.azurewebsites.net/**

All pages default to the same-origin `/api/realtime-access`. On App Service,
enter the shared **Demo access key** configured in `DEMO_ACCESS_KEY`. It is not
embedded in the pages or saved to browser persistent storage. Authorized Azure
operators can retrieve or rotate it in the app's **Settings > Environment
variables**; distribute it through a private channel, not a URL.

### Which token does each transport use?

Both browser transports use the **ephemeral client secret returned by
`/openai/v1/realtime/client_secrets`**:

1. The browser authenticates to the demo API with the Demo key in `x-demo-key`.
2. The server uses its managed identity (Entra access token) to call Azure's
   `client_secrets` endpoint. The Entra token stays on the server.
3. WebRTC sends the resulting ephemeral secret as a Bearer token with the SDP
   request to `/openai/v1/realtime/calls`. Media flows directly to Azure.
4. WebSocket sends the ephemeral secret and Demo key in the first same-origin
   WSS `connect` frame. The relay validates the key and the configured resource/
   deployment, then adds `Authorization: Bearer <ephemeral secret>` upstream.

The Demo key is **not** an Azure credential. The optional standalone Function key
only authorizes calls to that Function. The direct CLI's `--auth entra` and
`--auth api-key` modes are separate authentication comparisons, not the browser
default. `expires_at` comes from Azure; the app does not assume a fixed lifetime.

### Free-tier boundaries

The unified deployment uses **Linux F1 / Node 24 LTS**, one process, HTTPS, and no
paid supporting services. App Service hosting is free; **Azure OpenAI Realtime,
transcription and any separate TTS calls remain billable**.

- F1 supports five concurrent WebSockets, but this demo deliberately permits
  only **two active relays**, each for at most **15 minutes**.
- Authorized token issuance is limited to **12 requests/minute globally** and
  two in-flight requests. Quota errors are visible; there is no model/SKU fallback.
- F1 has no Always On or SLA, 60 CPU minutes/day, three CPU minutes per five-minute
  interval, and a published 165 MB/day outgoing bandwidth limit. CPU time is not
  connection duration. Audio relay traffic can exhaust the bandwidth allowance.
- Idle unloading, restarts and quota exhaustion can disconnect sessions.
  Start again to request a fresh ephemeral secret.
- These in-process safeguards reset on restart. They are not a production
  authentication system, an exact Azure billing cap, or a WebRTC duration limit.

Official limits: [Linux WebSocket support](https://learn.microsoft.com/azure/app-service/faq-app-service-linux#are-websockets-supported),
[App Service quotas](https://learn.microsoft.com/azure/azure-resource-manager/management/azure-subscription-service-limits#azure-app-service-limits).

### Run the unified host locally

Use Node.js 22+ (the deployed runtime is Node 24), Azure CLI authentication, and
an identity with **Cognitive Services OpenAI User** on the selected Azure OpenAI
resource. No Python Function host is required for this path.

```powershell
az login
$env:AOAI_ENDPOINT = "https://<your-resource>.openai.azure.com"
$env:AOAI_REALTIME_DEPLOYMENT = "<your-realtime-deployment>"
npm --prefix .\webapp ci
npm --prefix .\webapp start
```

Open `http://localhost:8000`. Local development uses `DefaultAzureCredential`;
App Service uses `ManagedIdentityCredential` deterministically. Without a local
`DEMO_ACCESS_KEY`, the key field may be empty and the server is loopback-only.
To test key protection locally, set `DEMO_ACCESS_KEY` to a private 32–1024 character
printable non-space ASCII value before starting. The cloud host fails startup
if its required configuration/key is missing.

`PUBLIC_ORIGIN` can explicitly set the trusted HTTPS origin; App Service defaults
to `https://<WEBSITE_HOSTNAME>`. Forwarded headers never select trusted origins.
Only the allowlisted public HTML/JavaScript files are served. Source, dependencies,
tests, settings and CLI tools are not public routes. `/health` checks the process,
not model availability; full audio verification is a separate step.

### Deploy the unified F1 app

The separate `infra/appservice.bicep` and `scripts/deploy-appservice.ps1` path
does not deploy the legacy `azure.yaml` Function/SWA configuration. Its defaults
target subscription `a5095cf8-c1ec-4a7e-9ee7-22103870844b`, resource group
`rg-pec-robotics`, Japan East, app `app-realtime-f1-mh0922` and plan
`asp-realtime-f1-mh0922`. The existing Azure OpenAI account is unchanged.

```powershell
# The script securely prompts for a 32-1024 character Demo key.
# Without -Deploy it validates only; no cloud resources are created or updated.
.\scripts\deploy-appservice.ps1 `
  -AoaiRealtimeDeployment "gpt-realtime-2.1-mini" -ValidateOnly

# After reviewing validation and the target, provision and ZIP-deploy:
.\scripts\deploy-appservice.ps1 `
  -AoaiRealtimeDeployment "gpt-realtime-2.1-mini" -Deploy
```

Use the same key when redeploying unless intentionally rotating it. A supplied
`-DemoAccessKey` SecureString takes precedence over process `DEMO_ACCESS_KEY`;
otherwise the script prompts without echo. Temporary parameter files are
access-restricted and removed after use. Never pass a real key as a command-line
string or store it in repository files.

The script uses Linux **F1 only**, Node 24, system-assigned managed identity and
account-scoped **Cognitive Services OpenAI User**. It never falls back to a paid
SKU. Publishing basic authentication and FTP are disabled. The nine-file ZIP
contains only runtime files; Azure installs locked npm dependencies remotely.
Validation/provisioning requires ARM deployment permissions and permission to
create that role assignment at the Azure OpenAI account scope.

### Deployed verification (2026-09-16)

- Verified the actual plan is **F1 / Free**, Japan East, capacity 1; the app runs
  `NODE|24-lts`, Always On is disabled, FTP is disabled, and minimum TLS is 1.2.
- Verified the app's managed identity has Cognitive Services OpenAI User only at
  the existing Azure OpenAI account scope. No permanent Azure key is configured
  for the unified backend.
- Four public pages and `/health` returned 200. Runtime source, package metadata
  and the CLI returned 404; an unauthenticated token POST returned 401.
- Two successive hosted relay sessions minted new ephemeral secrets and
  completed real Azure input transcription, assistant responses and output audio.
- All three actual Edge browser pages passed using a synthetic microphone:
  input transcription completed, the model completed its reply, and Stop ended
  microphone tracks. WebRTC inbound RTP increased by 33,538 and 28,736 bytes
  after the utterance; WebSocket received 890,400 bytes of output PCM audio.
- All three transcribed the fixed Japanese WAV as
  `ロボットの動作を確認してください。`. The livevoice page does not enable input ASR
  by default; its test explicitly enabled `gpt-4o-mini-transcribe`. Map and
  WebSocket transcription settings remain available in their normal flows.
- Offline regressions: **95 Node tests and 8 legacy Function tests passed**.

These are live functional checks, not a five-socket load test, endurance test,
or a guarantee against F1 quota exhaustion. The map page's speech transport was
verified; this run did not exercise every geocoding/tool branch. Existing
Function/SWA resources were not deleted or updated by this deployment.

## Project structure

```text
.
|-- api/
|   |-- function_app.py
|   |-- host.json
|   |-- local.settings.json
|   |-- local.settings.json.example
|   |-- requirements.txt
|-- webapp/
|   |-- gpt-realtime-livevoice-demo.html
|   |-- gpt-realtime_function_call_map.html
|   |-- gpt-realtime-websocket-demo.html
|   |-- server.cjs
|   |-- realtime-access.cjs
|   |-- package.json
|-- infra/
|   |-- ...
|-- azure.yaml
|-- README.md
```

## Optional standalone Function: prerequisites

- Python 3.14 or another version supported by Azure Functions
- Azure Functions Core Tools v4
- Azure CLI
- Azure Developer CLI (`azd`)
- An Azure OpenAI resource with a deployed Realtime model

For local authentication, sign in with an identity that can invoke the model:

```powershell
az login
```

The identity must have the **Cognitive Services OpenAI User** role on the Azure OpenAI resource.

## Optional standalone Function: local settings

Update `api/local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "python",
    "AOAI_ENDPOINT": "https://aoai-realtime-test01.openai.azure.com/",
    "AOAI_REALTIME_DEPLOYMENT": "gpt-realtime-2.1-mini",
    "AOAI_API_KEY": "<optional-azure-openai-api-key>"
  }
}
```

`local.settings.json` is for local development only. Configure the same environment variables as Function App application settings after deployment.

## Optional standalone Function: dependencies

From the project root:

```powershell
cd api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Optional standalone Function: run locally

Open one PowerShell terminal and start the Function host with CORS enabled for the local web server:

```powershell
cd api
func start --cors http://localhost:8000
```

Open a second PowerShell terminal from the project root. Use Node.js 22 or later
to serve all demos, including the local WebSocket relay:

```powershell
cd webapp
npm install
npm start
```

For WebRTC-only testing, `python -m http.server 8000` still works. It does not
provide the relay required by the WebSocket page.

Then open:

```text
http://localhost:8000/gpt-realtime-livevoice-demo.html
```

You can also open the function-calling map demo:

```text
http://localhost:8000/gpt-realtime_function_call_map.html
```

The WebSocket test demo is available at:

```text
http://localhost:8000/gpt-realtime-websocket-demo.html
```

All pages now default to the unified same-origin API. To use the standalone
Function instead, explicitly select its API URL, for example
`http://localhost:7071/api/realtime-access`.

- The Function key field can be left empty when using the local Functions host.
- After deployment, enter the deployed Function endpoint and its `realtime-access` Function key.
- The map demo now also retrieves `ephemeral_token` and `webrtc_url` from the Function instead of calling Azure OpenAI sessions directly from browser code.

The API endpoint is:

- `POST /api/realtime-access` - creates an ephemeral Realtime client secret and returns the selected transport endpoint

Send `{"transport":"webrtc"}` or `{"transport":"websocket"}` in the request body. Omitting
`transport` keeps the existing WebRTC behavior. The response includes:

- `transport` - the selected transport
- `realtime_url` - the endpoint for the selected transport
- `webrtc_url` when `transport` is `webrtc`
- `websocket_url` when `transport` is `websocket`
- `ephemeral_token` - the short-lived client secret

The WebSocket demo sends and receives 24 kHz PCM audio over the same-origin Node relay.
Azure accepts the ephemeral token in an `Authorization: Bearer ...` header, which
the browser's native WebSocket API cannot set. The browser sends the ephemeral
token to the relay in its initial message; the relay adds the header for the
Azure connection. Tokens are not placed in URLs, stored, or logged by the relay.
Local mode binds to loopback and accepts the matching localhost origin.
App Service mode accepts the configured HTTPS origin, requires the Demo key on
the relay, and pins the configured Azure resource and deployment. An external
Function can still serve the loopback workflow; the hosted demo uses its own
issuer/key to avoid mixing credentials. A static-only deployment cannot run the
relay. This remains a non-production test tool.

Non-browser WebSocket clients can connect directly to `websocket_url` using the
`Authorization: Bearer <ephemeral_token>` header; they do not need the relay.
For production browser applications, WebRTC is still the recommended low-latency transport;
the WebSocket page is included as a connectivity and protocol test demo.

Allow microphone access when prompted, then select the start button.

To test against a deployed Function instead of the local Functions host, enter its
actual Function API URL and Function key in the page. Allow `http://localhost:8000`
in that Function's CORS settings. Do not place the Function key in source code.

Run the offline relay, browser lifecycle, experiment-recording, and direct-client
regression tests with `npm test` from `webapp`.

## Customer verification: K1 Pro / Q1-Q12

The WebSocket page includes a generic configurable preset and a transcription
experiment panel. Existing WebRTC demos and the default WebSocket voice settings
remain available. The browser relay is a convenient microphone test;
the robot's server-to-server client does not require that relay or WebRTC.

### Try input transcription

1. Open the hosted WebSocket page, or start the unified local Node server and open
   `http://localhost:8000/gpt-realtime-websocket-demo.html`.
2. Apply the preset to use `coral`, 24 kHz mono PCM16,
   `gpt-4o-mini-transcribe`, language `ja`, Server VAD threshold `0.75`,
   prefix padding `300 ms`, silence `500 ms`, `create_response: true`, and
   `interrupt_response: false`. The preset disables the initial greeting and
   simulates microphone gating during model response, playback, and 300 ms of
   echo tail. The manual input-pause checkbox independently stops microphone sending.
   This is a simulation, not verification of the Booster audio SDK/hardware.
3. Speak a short Japanese sentence. Inspect **user input transcription** and
   **assistant speech captions** separately. Expand the configuration panel to
   compare the requested settings with the actual `session.updated` response.
4. Stop, select transcription **off**, and repeat. Audio conversation does not
   require input transcription. Then compare `whisper-1`,
   `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, or a custom deployment name.
   Unsupported configurations remain visible as errors; there is no fallback.
   Availability depends on the actual resource, deployment and API support.
5. Try a language hint and transcription prompt separately from the assistant's
   system instructions. Use the same recording with the direct CLI below for a
   more controlled A/B comparison; repeated microphone utterances are not identical.
6. Save the experiment JSON before starting the next run. It contains correlated
   transcripts, counts, errors, requested/observed settings, endpoint and returned
   expiry, but no keys, tokens, or Base64 audio. Transcripts and resource hostnames
   can still be sensitive: review the file before sharing it.

**What "transcribe" means here:** the Realtime model consumes audio directly.
Optional `audio.input.transcription` produces a separate ASR transcript for logs
or display; it is not the assistant's answer and is not guaranteed to be an exact
representation of what the audio model understood. The assistant's
`response.output_audio_transcript.*` events are captions of its generated speech.
Input transcription can finish **after** `response.done`. The experiment keeps
each input `item_id` / `content_index` separate, replaces partial text with the
final transcript, and displays transcription failures even when speech succeeded.
Latency is measured at the client from speech-end/commit event receipt, not pure
model execution time or an Azure SLA.

The normal UI `session.update` does not attempt to change the Realtime model.
The deployment is chosen by `AOAI_REALTIME_DEPLOYMENT` when the Function mints the
secret and by `model=` in the returned WebSocket URL. Use the direct compatibility
probe to test the customer's exact payload including its `model` field.

### Direct client: repeatable recording and customer probes

[`webapp/customer-probe.cjs`](webapp/customer-probe.cjs) runs on Node.js 22+ with
the existing `ws` dependency. It connects directly, without a browser, WebRTC, or
the local relay. This exercises the robot's wire protocol, not its Python SDK,
Jetson microphone driver, physical playback, or actual network environment.

Run these commands from the repository root. Supply credentials securely through
environment variables, never command-line arguments or committed files:

```powershell
npm --prefix .\webapp run probe -- --help

# Function-issued ephemeral token mode (default).
$env:PROBE_FUNCTION_URL = 'https://<function-host>/api/realtime-access'
# Supply PROBE_FUNCTION_KEY securely for a deployed Function.
node .\webapp\customer-probe.cjs inspect

# Independent Entra mode: no Function or Function key required.
$env:AOAI_ENDPOINT = 'https://<resource-name>.openai.azure.com'
$env:AOAI_REALTIME_DEPLOYMENT = '<actual-realtime-deployment>'
# Supply PROBE_ENTRA_TOKEN with an Azure OpenAI-audience Entra access token.
node .\webapp\customer-probe.cjs audio --auth entra --omit-session-model --transcription whisper-1 --wav .\assets\transcription-ja-16k.wav

# The SAME recording: disabled, Whisper, mini-transcribe, transcribe.
# Optional --custom-transcription adds a real deployment name to the matrix.
node .\webapp\customer-probe.cjs transcribe-matrix --auth entra --omit-session-model --wav .\assets\transcription-ja-16k.wav
```

`--auth api-key` instead uses `AOAI_API_KEY` with the same Azure endpoint and
deployment. `auth-matrix` compares the separately supplied ephemeral, Entra, and
API-key configurations; missing credentials are explicitly skipped, not substituted.
When no Function is used, Function-only questions are marked skipped.
Direct Entra token acquisition/refresh belongs to the caller; this Node tool
does not install an Azure identity SDK or refresh Entra tokens automatically.

The default payload includes `session.model` **only as an exact Q7 compatibility
experiment**. Use `--omit-session-model` for the conventional update used by the
browser page. These are separate runs; rejection never triggers a silent retry
with a different payload. `--token-voice` / `--token-instructions` can differ from
`--voice` / `--instructions` to compare issuance settings with the later update.

Each run prints a redacted JSON report with Q1-Q12 evidence, requested/observed
settings, HTTP/Upgrade status, structural event-contract checks, per-item
transcripts, and independent input-ASR/assistant-response/assistant-audio outcomes.
An ASR failure makes an audio probe fail even when assistant speech succeeds.
The client sends the full recording and waits for all observed input items,
including transcription that arrives after `response.done`.
The CLI's upload is not suppressed during assistant output, unlike the optional
K1 microphone-gating simulation in the browser.

Add `--report <new-json-path>` to persist a report. Existing files are never
overwritten. Reports contain spoken text, instructions and resource hostnames:
keep them outside published/committed content and review before sharing.
`--output-wav <new-wav-path>` optionally saves assistant audio for a single audio
run. Inputs must be little-endian PCM16, mono, 16 or 24 kHz, at most 30 seconds.
Reports include a recording hash; 16 kHz audio is resampled to 24 kHz. Default VAD
adds 300 ms leading and 800 ms trailing silence. `--manual-commit` is a separate
control that disables VAD and sends one nonempty commit plus `response.create`.

Additional explicit experiments:

```powershell
node .\webapp\customer-probe.cjs auth-matrix
node .\webapp\customer-probe.cjs reconnect --reuse-token
node .\webapp\customer-probe.cjs network

# Optional load/cost experiment, NOT run automatically.
node .\webapp\customer-probe.cjs soak --allow-load --seconds 60 --concurrency 2

# Separately configured TTS deployment and credentials; never implicit reuse.
# Set TTS_AOAI_ENDPOINT, TTS_DEPLOYMENT and TTS_API_KEY securely first.
node .\webapp\customer-probe.cjs tts --tts-auth api-key --output-mp3 .\speech.mp3
```

`reconnect` deliberately drops the first socket and remints a fresh secret;
`--reuse-token` adds an explicitly separate reuse attempt. Only ephemeral
HTTP 401/403 can trigger bounded remint retries (`--auth-retries`, 0-2); this is
not a generic retry of 429 or a proof of what happens at expiry.
`soak` opens idle sessions with mandatory opt-in, at most 3,600 seconds and four
connections. It measures observed overlap, not the service's maximum.
`network` checks only the configured Azure OpenAI host's DNS and TLS on port 443;
`inspect` performs the authenticated WebSocket Upgrade. Repeat from the robot's
network to validate its egress path.

For TTS Entra auth, use `TTS_ENTRA_TOKEN` and `--tts-auth entra` instead.
`tts --negative-ephemeral` is a deliberately negative authentication experiment,
not a supported Realtime-to-TTS credential recommendation. The opt-in `openai`
control uses only `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, and `OPENAI_MODEL`;
it sends the selected recording to that separately authorized provider.
None of the load, TTS, or OpenAI controls run as part of `npm test`.
Live commands incur usage and should use authorized endpoints and nonsensitive
recordings.

### Coverage and interpretation

| Customer question | Executable verification / evidence | Do not infer |
| --- | --- | --- |
| Q1 token kind | API contract test verifies `/openai/v1/realtime/client_secrets` and both token response shapes | The returned ephemeral secret is not the Function's Entra credential or an Azure API key |
| Q2 WebSocket auth | Direct probe can test ephemeral Bearer, Entra Bearer, and API-key paths independently | WebRTC success alone does not prove ephemeral WebSocket acceptance |
| Q2-1 URL conversion | Tests verify the resource WSS host, `/openai/v1/realtime`, URL-encoded `model`, and no Function `code` | Never replace `https` on the Function URL to manufacture an Azure OpenAI URL |
| Q3 deployment / region | Record actual returned URL and deployment | Function location does not establish model location; a global deployment also does not promise inference residency |
| Q4 POST contract / errors | Offline tests cover empty body (WebRTC default), WebSocket body, voice/instructions, 400/401/403/429/500/502 | Offline tests do not validate the deployed Function host's key enforcement or rate limits |
| Q5 expiry / reconnect | Record returned expiry; direct reuse/reconnect/soak/concurrency probes are explicit experiments | No hard-coded two-hour TTL, token-reuse promise, maximum session time, or quota assertion |
| Q6 issuance vs update | Test issuance voice/instructions; capture post-connect `session.updated` | Changing a control in the UI does not change an already-connected session; stop/reconnect |
| Q7 audio / VAD / voice | Customer preset and exact GA configuration tests; direct 16-to-24 kHz WAV test | Browser audio does not validate Jetson drivers or acoustic echo handling |
| Q8 transcribe | Off / Whisper / GPT / custom-deployment A/B; input delta/completed/failed and client timings | One accepted model ID does not establish deployment, permission, or quota rules for all resources |
| Q9 events | Separate input/assistant correlation, late completion regression, event counts and direct event-shape checks | A greeting-only test does not test microphone input transcription or Server VAD |
| Q10 Function key | Normalize pasted `?code=` into `x-functions-key`; reject conflicting keys; redacted exports | Local Functions host generally does not enforce deployed Function keys; rotation policy requires an operations decision |
| Q11 network | Record distinct Function and Azure OpenAI hosts; direct network/Upgrade diagnostics | Browser CORS and robot egress are different controls; no broad network scans |
| Q12 TTS | Separate opt-in direct TTS/MP3 probe with an explicit TTS deployment and separate Azure auth | Realtime ephemeral secrets must not be assumed to authorize `/audio/speech`; voice name alone does not identify a TTS deployment/version |

For the Function POST, use `Content-Type: application/json` and, when deployed,
`x-functions-key: <Function key>`. A minimal WebSocket request is
`{"transport":"websocket","voice":"coral","instructions":"Respond in Japanese."}`.
Successful responses normally use HTTP 200 and contain `transport`,
`realtime_url`, `websocket_url`, `model`, `ephemeral_token`, `expires_at` and the
upstream `session` object. Existing empty-body calls continue to select WebRTC.
Invalid transports return `{"error":"..."}` with 400; Azure errors retain their
status with `{"error":"Azure OpenAI returned an error","details":{...}}`;
missing configuration/authentication returns 500 and network failure returns 502.

The Function does not implement application-level request quotas. Azure resource
quotas, Function platform limits, concurrent-session limits, deployment region,
Function-key rotation, and the correct TTS model **deployment and version** require
resource/operations evidence; they are not established by a passing unit test.
For direct Azure server connections, allow the configured Function and Azure
OpenAI resource hosts over TCP 443, including WebSocket Upgrade to the latter.
Entra authentication can require additional identity-provider endpoints.
Validate any corporate proxy/DNS/TLS restrictions from the robot's actual network.

Run all offline tests from the repository root without contacting Azure:

```powershell
npm --prefix .\webapp test
.\api\.venv\Scripts\python.exe -m unittest discover -s .\api -p test_function_app.py -v
```

Verification completed with **50 Node tests and 8 Function contract tests passing**.
Browser lifecycle regressions also cover the 300 ms playback tail, robot-motion
gating, fresh token issuance on manual reconnect, and disabled-ASR display.

The optional VS Code task **realtime: local experiment server** serves the browser
experiments on port `8123` instead of `8000` to avoid colliding with another demo.
If using this task, include `http://localhost:8123` in the Function CORS allowlist.

### Observed live results (2026-09-16)

These are observations on the locally configured **`gpt-realtime-2.1-mini`**
deployment, **not a certification of the customer's `gpt-realtime-2` deployment**:

| Experiment | Observed result |
| --- | --- |
| Client secret issuance | Existing Function handler called Azure successfully (200); the returned secret had about 7,199 seconds remaining at observation |
| Ephemeral WebSocket auth | The local relay connected to Azure using the ephemeral secret as Bearer authorization; no Function key was forwarded to the WebSocket URL |
| Customer VAD / `coral` | `session.updated` confirmed the requested settings; audio, assistant captions, VAD and response completion events arrived |
| `gpt-4o-mini-transcribe` before deployment | Configuration was accepted, but actual speech produced `conversation.item.input_audio_transcription.failed` with **`DeploymentNotFound`**; assistant speech still succeeded |
| `whisper-1` | Input transcription succeeded and matched the short Japanese fixture; one run measured first/final text at **361 / 1,190 ms** after client receipt of the commit/speech-end event |
| Transcription off | Observed configuration was `null`; assistant audio/captions still succeeded, with no input transcript events observed through that response's completion |
| Direct Node + Entra, mini-transcribe before deployment | Same fixed 16 kHz WAV was resampled and uploaded directly; Upgrade 101 and configuration checks passed, ASR failed while assistant response/audio completed; report correctly marked the probe failed |
| Direct Node + Entra, Whisper | Same fixed WAV succeeded: input ASR completed, assistant response/audio completed, CLI exited 0 |
| Exact Q7 `session.model` field | A separate direct `inspect` run accepted the payload including the current deployment's model field; this configuration-only run did not test transcription or changing models |
| Mini-transcribe after deployment, 11:37 JST | Same direct Node + Entra probe and fixed WAV succeeded: `conversation.item.input_audio_transcription.completed` matched the fixture exactly, assistant response/audio completed, no event-contract issues, CLI exited 0 |

This is why receiving `session.updated` is **not** enough to mark transcription
as working. After the user deployed `gpt-4o-mini-transcribe` with that exact name
in `aoai-robotics`, the first retest at 11:34 JST still returned
`DeploymentNotFound`; the same test at 11:37 JST passed without changing the
client configuration or falling back to Whisper. This is consistent with
deployment propagation, but provisioning timestamps/control-plane diagnostics
were unavailable, so propagation is not a proven root cause or a fixed wait-time
guarantee. The successful retest used direct Entra authentication, not a new
browser/ephemeral-token run. The tests do not create deployments, change
permissions, or infer global deployment rules from this observation.

The fixed test fixture [`assets/transcription-ja-16k.wav`](assets/transcription-ja-16k.wav)
was generated locally with Windows speech synthesis, not recorded from a person.
It is 16 kHz, mono, PCM16 and says **ロボットの動作を確認してください。**
Use it for repeatable resampling/transcription tests, then separately validate
real robot recordings/noise. The first mini-model probe used a longer Japanese
utterance; VAD plus half-duplex gating split it at a pause, so these runs are
functional checks, not an accuracy or latency benchmark.

The local Functions Core Tools host failed to start in the verification
environment. Live browser checks therefore used a temporary loopback adapter
calling the **existing Function handler in-process**, followed by the real local
relay and Azure WebSocket. This proves neither deployed Function-key enforcement
nor deployed CORS. Two-hour expiry/reuse behavior, long sessions, concurrent
limits, robot-network access, custom Transcribe names, and TTS still require their
explicit probes and the appropriate environment.

Official references:

- [Realtime session and audio concepts](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/realtime-audio)
- [Realtime WebSocket API](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/realtime-audio-websockets)
- [Realtime WebRTC and client secrets](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/realtime-audio-webrtc)
- [Azure OpenAI audio API](https://learn.microsoft.com/azure/ai-foundry/openai/reference-preview)

## Deploy the Function to Azure

The included AZD/Bicep infrastructure deploys a Python 3.14 Flex Consumption Function App, storage, monitoring, and a user-assigned managed identity. It also grants that identity **Cognitive Services User** on `aoai-realtime-test01`.

From the project root:

```powershell
az login
azd auth login
azd env select aoai-realtime-demo
azd up
```

The configured deployment target is:

- Subscription: `ME-M365CPI16988021-minghaoli-1`
- Region: Japan East
- Resource group: `rg-aoai-realtime-demo-jpe`

After deployment, use the `SERVICE_API_URI` output followed by `/api/realtime-access` as the Function API URL in the demo page. Retrieve the `realtime-access` Function key from the Function App and enter it in the page.

## Azure permissions

The deployment creates a user-assigned managed identity and assigns it the **Cognitive Services User** role scoped to the Azure OpenAI resource. This is the minimum Azure OpenAI runtime role required by this sample.

The person or deployment pipeline assigning that role also needs permission to create Azure role assignments, such as **Role Based Access Control Administrator** at the appropriate scope.

Do not place an Azure OpenAI API key in browser code. When `AOAI_API_KEY` is configured as a Function App application setting, the Function uses it only for server-side Azure OpenAI requests. Otherwise, it uses `DefaultAzureCredential`: Azure CLI credentials locally and managed identity in Azure.

When hosting the web application separately, configure the Function App CORS allowlist with the web application's exact origin.
