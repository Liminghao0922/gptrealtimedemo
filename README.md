# Azure OpenAI Realtime WebRTC and WebSocket Demos

This sample contains:

- A Node.js host for three browser demos, public runtime configuration, and a
  WebSocket relay. It supports local development and Azure App Service F1.
- The existing Python Azure Function as the **only Realtime token issuer**.
  App Service does not issue tokens or proxy token requests to the Function.

**Cutover status (2026-09-16):** the architecture below is approved.
Host/configuration/packaging changes are implemented. **58 frontend tests and the
integrated 109 Node + 8 Python tests passed** (separate suite results, not additive
totals). The retained Function is **restored and available
for token issuance**: live checks passed for bad key 401, invalid transport 400,
WebRTC 200, and WebSocket 200. Local native Edge audio checks passed for all three
pages, with input ASR checked only on map and WebSocket, **not livevoice**.
**Production deployment and fresh hosted acceptance passed for all three pages**.
The production host is <https://app-realtime-f1-mh0922.azurewebsites.net/>.
The strengthened hosted gate passed again on all three pages: a response created
**after actual `input_audio_buffer.committed`** completed and audio was received.
Map and WebSocket also had nonempty input-ASR completions. Credential isolation
and Stop cleanup passed. Livevoice input ASR remains disabled.
F1 Free and the Function identity's Azure OpenAI
resource-scoped **Cognitive Services OpenAI User** role were reconfirmed.

## Developer documentation (Japanese)

- [Developer code guide](docs/developer-code-guide-ja.md): which implementations
  and tests to reference when building a direct non-browser WebSocket client,
  and which parts are specific to the browser demo or unified App Service host.

## App Service pages and relay / Function token issuer

Deployed entry point: **https://app-realtime-f1-mh0922.azurewebsites.net/**

All three pages load an editable Function API URL from same-origin
`GET /api/demo-config`, which returns `{"function_url":"<Function URL>"}`.
The Node host reads this nonsecret URL from `FUNCTION_ACCESS_URL`; no key is
included. Pages POST **directly to the Function** using `x-functions-key`.

| Setting | Approved existing target |
| --- | --- |
| Function App | `func-robotics-v2` / Japan East / Python 3.13 / system-assigned managed identity |
| Function API URL / `FUNCTION_ACCESS_URL` | `https://func-robotics-v2-e6ftfkgmhvb8c9b4.japaneast-01.azurewebsites.net/api/realtime-access` |
| Resource group / subscription | `rg-pec-robotics` / `a5095cf8-c1ec-4a7e-9ee7-22103870844b` |
| App Service | `app-realtime-f1-mh0922` / Japan East / Linux F1 / Node 24 |
| Azure OpenAI endpoint | `https://aoai-robotics.openai.azure.com/` / East US 2 |
| Realtime / input transcription deployments | `gpt-realtime-2.1-mini` / `gpt-4o-mini-transcribe` |

The Azure OpenAI target is unchanged. After the App Service update, its former
`/api/realtime-access` returns **HTTP 410**, not a redirect. Update stored
client URLs explicitly; neither key is forwarded from that retired route.

### Which token does each transport use?

Both browser transports use the **ephemeral client secret returned by
`/openai/v1/realtime/client_secrets`**:

1. The browser authenticates to the Python Function with its Function key in
   `x-functions-key`.
2. The Function uses its managed identity (Entra access token) to call Azure's
   `client_secrets` endpoint. The Entra token stays on the server.
3. WebRTC sends the resulting ephemeral secret as a Bearer token with the SDP
   request to `/openai/v1/realtime/calls`. Media flows directly to Azure.
4. Browser WebSocket additionally sends the ephemeral secret and **Demo key**
   (`access_key`) in the first same-origin
   WSS `connect` frame. The relay validates the key and the configured resource/
   deployment, then adds `Authorization: Bearer <ephemeral secret>` upstream.

**WebRTC needs only the Function key; browser WebSocket needs both keys.**
The Function key never goes to the relay; the Demo key never goes to the
Function. The Demo key is **not** an Azure credential and authorizes only the
browser relay's `connect` frame. Direct non-browser clients use the Function
key and returned ephemeral secret, with **no Demo key or relay**.

`DEMO_ACCESS_KEY` remains in the App Service environment for relay access.
Authorized operators can retrieve or rotate it in **Settings > Environment
variables**. Obtain the Function key from the Function App's function keys.
Share keys privately, not in URLs, source, or browser persistent storage.
The direct CLI's `--auth entra` and
`--auth api-key` modes are separate authentication comparisons, not the browser
default. `expires_at` comes from Azure; the app does not assume a fixed lifetime.

### Free-tier boundaries

The web host uses **Linux F1 / Node 24 LTS**, one process, and HTTPS.
App Service hosting is free; the retained Function has its own hosting costs.
**Azure OpenAI Realtime, transcription and any separate TTS calls remain billable**.

- F1 supports five concurrent WebSockets, but this demo deliberately permits
  only **two active relays**, each for at most **15 minutes**, with a **1 MiB**
  payload/buffer limit.
- The Python Function has no application-level issuance rate/concurrency limiter.
  The former Node issuer's 12 requests/minute and two in-flight requests **do not
  apply to the Function**. Azure quotas and Function platform limits still apply.
  Quota errors are visible; there is no model/SKU fallback.
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

Use Node.js 22+ (the deployed runtime is Node 24). The Node host does not obtain
Azure credentials. Use either the retained deployed Function or a local Python
Function host for issuance; the Azure endpoint/deployment below pin relay targets.

```powershell
$env:FUNCTION_ACCESS_URL = "https://func-robotics-v2-e6ftfkgmhvb8c9b4.japaneast-01.azurewebsites.net/api/realtime-access"
$env:AOAI_ENDPOINT = "https://aoai-robotics.openai.azure.com"
$env:AOAI_REALTIME_DEPLOYMENT = "gpt-realtime-2.1-mini"
npm --prefix .\webapp ci
npm --prefix .\webapp start
```

Open `http://localhost:8000`, enter the Function key, and allow this exact local
origin in the deployed Function's CORS settings. Keep the relay endpoint/deployment
consistent with the Function's returned URL. Without a local
`DEMO_ACCESS_KEY`, the key field may be empty and the server is loopback-only.
To test key protection locally, set `DEMO_ACCESS_KEY` to a private 32–1024 character
printable non-space ASCII value before starting. The cloud host fails startup
if its required configuration/key is missing.

`PUBLIC_ORIGIN` can explicitly set the trusted HTTPS origin; App Service defaults
to `https://<WEBSITE_HOSTNAME>`. Forwarded headers never select trusted origins.
Only the allowlisted public HTML/JavaScript files are served. Source, dependencies,
tests, settings and CLI tools are not public routes. `/health` checks the process,
not model availability; full audio verification is a separate step.

For a local Function, set `FUNCTION_ACCESS_URL` to
`http://localhost:7071/api/realtime-access`. Local HTTP is permitted only for
loopback development. In production the setting must be a separate HTTPS
Function URL without credentials, query parameters, or a fragment. The default
is editable in each page; a static-only server has no `/api/demo-config`, so
enter the Function URL manually.

### Deployment options for the existing F1 app

For this cutover, a targeted `FUNCTION_ACCESS_URL` setting update plus ZIP
deployment is the selected path to preserve all other existing settings,
identities, and RBAC without ARM/Bicep template reprovisioning. The targeted
`FUNCTION_ACCESS_URL` update and **9-file ZIP deployment completed**, and fresh
hosted acceptance passed for all three pages. No full ARM apply was used.

The maintained script below is a separate **validated AVM reprovisioning and ZIP
deployment** path, not a settings-only update. It still requires
`-FunctionAccessUrl` along with the existing arguments. Review its full ARM
change scope before selecting that path.

The separate `infra/appservice.bicep` and `scripts/deploy-appservice.ps1` path
does not deploy the legacy `azure.yaml` Function/SWA configuration. The script
pins the existing demo environment with `ValidateSet` restrictions; review its
target settings before running it. It is not a general-purpose deployment script
for arbitrary subscriptions. The existing Azure OpenAI account is unchanged.

```powershell
# The script securely prompts for a 32-1024 character Demo key.
# Without -Deploy it validates only; no cloud resources are created or updated.
.\scripts\deploy-appservice.ps1 `
  -AoaiRealtimeDeployment "gpt-realtime-2.1-mini" `
  -FunctionAccessUrl "https://func-robotics-v2-e6ftfkgmhvb8c9b4.japaneast-01.azurewebsites.net/api/realtime-access" `
  -ValidateOnly

# After reviewing validation and the target, provision and ZIP-deploy:
.\scripts\deploy-appservice.ps1 `
  -AoaiRealtimeDeployment "gpt-realtime-2.1-mini" `
  -FunctionAccessUrl "https://func-robotics-v2-e6ftfkgmhvb8c9b4.japaneast-01.azurewebsites.net/api/realtime-access" `
  -Deploy
```

Use the same key when redeploying unless intentionally rotating it. A supplied
`-DemoAccessKey` SecureString takes precedence over process `DEMO_ACCESS_KEY`;
otherwise the script prompts without echo. Temporary parameter files are
access-restricted and removed after use. Never pass a real key as a command-line
string or store it in repository files.

`-FunctionAccessUrl` is required, nonsecret, and becomes `FUNCTION_ACCESS_URL`.
The script uses Linux **F1 only** and Node 24. Existing App Service
system-assigned identity and account-scoped **Cognitive Services OpenAI User**
RBAC are preserved for this cutover but **not used for token issuance**.
It never falls back to a paid SKU. Publishing basic authentication and FTP are
disabled. The ZIP contains only runtime files, including `demo-config.cjs`
instead of the removed `realtime-access.cjs`; Node no longer depends on
`@azure/identity`. Azure installs locked npm dependencies remotely.
Validation/provisioning requires ARM deployment permissions and permission to
create that role assignment at the Azure OpenAI account scope.

The existing Function is not recreated by this deployment. Append
`https://app-realtime-f1-mh0922.azurewebsites.net` to its CORS allowlist,
**preserving every existing origin**. Do not add a path, trailing slash, or wildcard.
For a Function code update, use the existing-app Core Tools procedure below.

### Restored Function token-API verification

Live checks against the retained Function passed on 2026-09-16:

| Check | Observed result |
| --- | --- |
| Invalid Function key | HTTP 401 |
| Invalid transport with valid key | HTTP 400 |
| WebRTC token request | HTTP 200, token present, correct `/openai/v1/realtime/calls` URL |
| WebSocket token request | HTTP 200, token present, correct Azure WSS URL and deployment |

Both successful responses had approximately **7,199 seconds** remaining.
Always use the returned `expires_at`; this is an observation, not a fixed TTL
guarantee. These are token-API tests, not new audio or browser success evidence.
The F1 CORS origin was appended **with every existing origin preserved**.

Resolved deployment prerequisite: disabled public network access on the
existing deployment/runtime storage caused startup failure and the Core Tools
Flex `StorageAccessibleCheck` storage 403. The explicitly approved fix restored
**only** `rgpecrobotics8a4a`'s `publicNetworkAccess=Enabled`, while retaining
`allowBlobPublicAccess=false` and `allowSharedKeyAccess=false`. Existing managed
identities, RBAC, SKUs, and models are unchanged. This is a network-reachability
fix for this environment, not permission to enable anonymous blob access,
shared-key authentication, or relax other environments' controls.

### Current local validation (2026-09-16)

- Frontend suite: **58 tests passed**.
- Integrated offline suite: **109 Node + 8 Python tests passed**. Do not add the
  frontend suite count to this total.
- Local native Edge WebRTC checks passed on livevoice and map: incoming audio,
  completed responses, and cleanup.
- **Livevoice does not enable input ASR**; no input-transcription success is
  claimed for that page in this run.
- Map requested `gpt-4o-mini-transcribe` with language `ja` and produced a
  **17-character input transcript**. This is a functional observation, not an
  accuracy benchmark.
- The separate local WebSocket page check passed mini-transcribe input ASR,
  AI output audio, Function/relay key isolation, and cleanup.

These checks used the local host, not the newly deployed App Service. They do
not replace hosted acceptance or direct Python/device verification.

### Production deployment and hosted acceptance — PASSED (2026-09-16)

The targeted `FUNCTION_ACCESS_URL` update and 9-file ZIP deployment completed
without a full ARM apply. Fresh acceptance at
<https://app-realtime-f1-mh0922.azurewebsites.net/> passed for **all three pages**:

- Real tokens were obtained directly from the retained Python Function.
- The strengthened full-audio gate passed again on every page: a response
  created **after actual `input_audio_buffer.committed`** reached completed
  status and audio was received. A greeting alone cannot satisfy this gate.
- Map and WebSocket both produced nonempty input-ASR completions with
  `gpt-4o-mini-transcribe`. This fresh run resolves the earlier hosted map
  snapshot's missing ASR evidence. **Livevoice input ASR remained disabled**.
- Stop cleanup passed on all three pages.
- Function/relay key isolation passed: the Function key went only to the
  Function; the relay Demo key was separate. WebRTC needed no Demo key.
- App Service **F1 Free** was reconfirmed, and the Function identity's
  **Cognitive Services OpenAI User** role at the Azure OpenAI resource scope
  was verified. Existing identities, RBAC, SKUs, and models were preserved.

This is fresh hosted evidence, not a reuse of the local or original-issuer
results. It does not certify direct Python/device behavior or production load.

### Historical deployed verification (2026-09-16, original Node issuer)

These checks preceded the Function-only cutover and describe the old deployment,
not the current post-cutover acceptance status.

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
- All three transcriptions matched the fixed synthesized Japanese WAV.
  The livevoice page does not enable input ASR
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
|   |-- demo-config.cjs
|   |-- package.json
|-- infra/
|   |-- ...
|-- azure.yaml
|-- README.md
```

## Python Function issuer: prerequisites

- Python 3.13 (matching the retained `func-robotics-v2` runtime)
- Azure Functions Core Tools v4
- Azure CLI
- Azure Developer CLI (`azd`) only for the separate legacy provisioning path
- An Azure OpenAI resource with a deployed Realtime model

For local authentication, sign in with an identity that can invoke the model:

```powershell
az login
```

The identity must have the **Cognitive Services OpenAI User** role on the Azure OpenAI resource.

## Python Function issuer: local settings

Update `api/local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "python",
    "AOAI_ENDPOINT": "https://<your-resource>.openai.azure.com/",
    "AOAI_REALTIME_DEPLOYMENT": "gpt-realtime-2.1-mini",
    "AOAI_API_KEY": "<optional-azure-openai-api-key>"
  }
}
```

`local.settings.json` is for local development only. Configure the same environment variables as Function App application settings after deployment.

## Python Function issuer: dependencies

From the project root:

```powershell
cd api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Python Function issuer: run locally

Open one PowerShell terminal and start the Function host with CORS enabled for the local web server:

```powershell
cd api
func start --cors http://localhost:8000
```

Open a second PowerShell terminal from the project root. Use Node.js 22 or later
to serve all demos, including the local WebSocket relay:

```powershell
cd webapp
$env:FUNCTION_ACCESS_URL = "http://localhost:7071/api/realtime-access"
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

All three pages use the Function URL published by `/api/demo-config` as an
editable default. For static-only WebRTC hosting, explicitly enter
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
the relay, and pins the configured Azure resource and deployment. Both local and
hosted pages get tokens directly from the selected Python Function. Its key is
never included in a relay frame, and the relay Demo key is never sent to the
Function. A static-only deployment cannot run the
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

## Audio and protocol verification

The WebSocket page includes a generic configurable preset and a transcription
experiment panel. Existing WebRTC demos and the default WebSocket voice settings
remain available. The browser relay is a convenient microphone test;
a server-to-server client does not require that relay or WebRTC.

### Try input transcription

1. Open the hosted WebSocket page, or start the unified local Node server and open
   `http://localhost:8000/gpt-realtime-websocket-demo.html`.
2. Apply the preset to use `coral`, 24 kHz mono PCM16,
   `gpt-4o-mini-transcribe`, language `ja`, Server VAD threshold `0.75`,
   prefix padding `300 ms`, silence `500 ms`, `create_response: true`, and
   `interrupt_response: false`. The preset disables the initial greeting and
   simulates microphone gating during model response, playback, and 300 ms of
   echo tail. The manual input-pause checkbox independently stops microphone sending.
   This is a simulation, not verification of device-specific audio SDKs or hardware.
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
The deployment is chosen by `AOAI_REALTIME_DEPLOYMENT` when the issuer mints the
secret and by `model=` in the returned WebSocket URL. Use the direct compatibility
probe to test a payload including its `model` field.

### Direct client: repeatable audio and protocol probes

[`webapp/customer-probe.cjs`](webapp/customer-probe.cjs) runs on Node.js 22+ with
the existing `ws` dependency. It connects directly, without a browser, WebRTC, or
the local relay. This exercises the wire protocol, not a device-specific SDK,
microphone driver, physical playback, or production network environment.

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
When no token issuer is used, issuer-only checks are marked skipped.
Direct Entra token acquisition/refresh belongs to the caller; this Node tool
does not install an Azure identity SDK or refresh Entra tokens automatically.

The default payload includes `session.model` **only as a field-compatibility
experiment**. Use `--omit-session-model` for the conventional update used by the
browser page. These are separate runs; rejection never triggers a silent retry
with a different payload. `--token-voice` / `--token-instructions` can differ from
`--voice` / `--instructions` to compare issuance settings with the later update.

Each run prints a redacted JSON report with protocol evidence, requested/observed
settings, HTTP/Upgrade status, structural event-contract checks, per-item
transcripts, and independent input-ASR/assistant-response/assistant-audio outcomes.
An ASR failure makes an audio probe fail even when assistant speech succeeds.
The client sends the full recording and waits for all observed input items,
including transcription that arrives after `response.done`.
The CLI's upload is not suppressed during assistant output, unlike the optional
microphone-gating simulation in the browser.

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
`inspect` performs the authenticated WebSocket Upgrade. Repeat from the target
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

| Area | Executable verification / evidence | Validation boundary |
| --- | --- | --- |
| Authentication and endpoints | Verify client-secret response shapes, independent Bearer/API-key modes, Azure WSS host/path and encoded deployment | WebRTC success alone does not prove WebSocket acceptance. Never turn a Function URL into an Azure URL or forward its key |
| Token API and access controls | Function contracts/key authentication, public runtime config, retired route, relay origin/key checks and redacted exports | Node no longer issues tokens. Function host authentication and CORS require deployed verification; old Node issuance limits do not apply |
| Session configuration | Initial voice/instructions, observed `session.updated`, GA audio/VAD settings and deployment selection | UI changes need a new session unless explicitly sent. Issuer location does not establish model location or inference residency |
| Audio transport and playback | Fixed WAV resampling from 16 to 24 kHz, paced upload, VAD/manual commit and microphone gating | Browser and file tests do not validate device drivers, acoustic echo handling or physical playback |
| Transcription and events | Off / Whisper / GPT / custom-deployment A/B, input/assistant correlation, late completion and event-shape checks | A greeting or accepted configuration is not a transcription test. One deployment's success is not a universal permission or quota rule |
| Lifecycle and capacity | Returned expiry, explicit reuse/reconnect/soak probes, bounded concurrency and playback-tail cleanup | No fixed TTL, token-reuse, maximum duration or service-capacity guarantee follows from these tests |
| Networking | Distinct issuer/model hosts, single-host DNS/TLS and authenticated Upgrade diagnostics | Browser CORS and device egress are different controls. Run checks from the target network |
| Separate TTS | Opt-in TTS/MP3 probe with explicit deployment and separate Azure auth | Realtime secrets must not be assumed to authorize `/audio/speech`; voice alone does not identify a TTS deployment/version |

For the Function POST, use `Content-Type: application/json` and, when deployed,
`x-functions-key: <Function key>`. A minimal WebSocket request is
`{"transport":"websocket"}`; `voice` and `instructions` are optional.
Successful responses normally use HTTP 200 and contain `transport`,
`realtime_url`, `websocket_url`, `model`, `ephemeral_token`, `expires_at` and the
upstream raw `session` object; there is no `token_source` field. Do not log the
raw response, as `session` can also contain secrets. Empty/non-JSON bodies and
`{}` currently select WebRTC unless transport is explicitly provided (the
Function also accepts a transport query parameter). Always send explicit JSON
`transport: "websocket"` for a WebSocket client.
Invalid transports return `{"error":"..."}` with 400; Azure errors retain their
status with `{"error":"Azure OpenAI returned an error","details":{...}}`;
missing configuration/server-identity authentication returns 500 and network
failure returns 502. Function-key authentication is performed by the Functions
host, whose error body need not match the handler's JSON.

The Function does not implement application-level request quotas. Azure resource
quotas, Function platform limits, concurrent-session limits, deployment region,
Function-key rotation, and the correct TTS model **deployment and version** require
resource/operations evidence; they are not established by a passing unit test.
For direct Azure server connections, allow the configured Function and Azure
OpenAI resource hosts over TCP 443, including WebSocket Upgrade to the latter.
Entra authentication can require additional identity-provider endpoints.
Validate any corporate proxy/DNS/TLS restrictions from the target network.

Run all offline tests from the repository root without contacting Azure:

```powershell
npm --prefix .\webapp test
.\api\.venv\Scripts\python.exe -m unittest discover -s .\api -p test_function_app.py -v
```

Historical offline totals are listed in **Historical deployed verification**
above. **Current local validation** records the passing frontend and integrated
suites and local browser checks. **Production deployment and hosted acceptance**
records the fresh three-page pass. The four live Function checks are recorded
separately above.
Browser lifecycle regressions also cover the 300 ms playback tail, manual input
pause, fresh token issuance on manual reconnect, and disabled-ASR display.

The optional VS Code task **realtime: local experiment server** serves the browser
experiments on port `8123` instead of `8000` to avoid colliding with another demo.
If using this task, include `http://localhost:8123` in the Function CORS allowlist.

### Historical observed live results (2026-09-16, before cutover)

These are observations on the locally configured **`gpt-realtime-2.1-mini`**
deployment, **not a certification of other deployments or model versions**:

| Experiment | Observed result |
| --- | --- |
| Client secret issuance | Existing Function handler called Azure successfully (200); the returned secret had about 7,199 seconds remaining at observation |
| Ephemeral WebSocket auth | The local relay connected to Azure using the ephemeral secret as Bearer authorization; no Function key was forwarded to the WebSocket URL |
| Configured VAD / `coral` | `session.updated` confirmed the requested settings; audio, assistant captions, VAD and response completion events arrived |
| `gpt-4o-mini-transcribe` before deployment | Configuration was accepted, but actual speech produced `conversation.item.input_audio_transcription.failed` with **`DeploymentNotFound`**; assistant speech still succeeded |
| `whisper-1` | Input transcription succeeded and matched the short Japanese fixture; one run measured first/final text at **361 / 1,190 ms** after client receipt of the commit/speech-end event |
| Transcription off | Observed configuration was `null`; assistant audio/captions still succeeded, with no input transcript events observed through that response's completion |
| Direct Node + Entra, mini-transcribe before deployment | Same fixed 16 kHz WAV was resampled and uploaded directly; Upgrade 101 and configuration checks passed, ASR failed while assistant response/audio completed; report correctly marked the probe failed |
| Direct Node + Entra, Whisper | Same fixed WAV succeeded: input ASR completed, assistant response/audio completed, CLI exited 0 |
| Explicit `session.model` field | A separate direct `inspect` run accepted the payload including the current deployment's model field; this configuration-only run did not test transcription or changing models |
| Mini-transcribe after deployment, 11:37 JST | Same direct Node + Entra probe and fixed WAV succeeded: `conversation.item.input_audio_transcription.completed` matched the fixture exactly, assistant response/audio completed, no event-contract issues, CLI exited 0 |

This is why receiving `session.updated` is **not** enough to mark transcription
as working. After a `gpt-4o-mini-transcribe` deployment was added with that exact
name to the test resource, the first retest at 11:34 JST still returned
`DeploymentNotFound`; the same test at 11:37 JST passed without changing the
client configuration or falling back to Whisper. This is consistent with
deployment propagation, but provisioning timestamps/control-plane diagnostics
were unavailable, so propagation is not a proven root cause or a fixed wait-time
guarantee. The successful retest used direct Entra authentication, not a new
browser/ephemeral-token run. The tests do not create deployments, change
permissions, or infer global deployment rules from this observation.

The fixed test fixture [`assets/transcription-ja-16k.wav`](assets/transcription-ja-16k.wav)
was generated locally with Windows speech synthesis, not recorded from a person.
It is a short Japanese utterance in 16 kHz, mono, PCM16 format.
Use it for repeatable resampling/transcription tests, then separately validate
representative device recordings and noise. The first mini-model probe used a longer Japanese
utterance; VAD plus half-duplex gating split it at a pause, so these runs are
functional checks, not an accuracy or latency benchmark.

The local Functions Core Tools host failed to start in the verification
environment. Live browser checks therefore used a temporary loopback adapter
calling the **existing Function handler in-process**, followed by the real local
relay and Azure WebSocket. This proves neither deployed Function-key enforcement
nor deployed CORS. Two-hour expiry/reuse behavior, long sessions, concurrent
limits, target-network access, custom Transcribe names, and TTS still require their
explicit probes and the appropriate environment.

Official references:

- [Realtime session and audio concepts](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/realtime-audio)
- [Realtime WebSocket API](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/realtime-audio-websockets)
- [Realtime WebRTC and client secrets](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/realtime-audio-webrtc)
- [Azure OpenAI audio API](https://learn.microsoft.com/azure/ai-foundry/openai/reference-preview)

## Update the retained Function (Core Tools)

Use [the Azure Functions deployment guide](docs/azure-functions-portal-ja.md),
especially **steps 4 and 5**, to publish the `api` project to the existing
`func-robotics-v2`. Skip resource creation; preserve its Python 3.13 runtime,
system-assigned identity, existing settings, and Azure OpenAI target. Steps 7/8
of that guide are **browser WebRTC** testing, not direct Python WebSocket testing.
Direct clients need neither browser CORS nor a local web server.

The retained Function uses managed identity, not a browser-supplied Azure key.
The exact F1 origin has been appended to its existing CORS allowlist, preserving
previous values. Function token issuance, the App Service production deployment,
and fresh hosted browser/audio acceptance for all three pages have passed.

## Separate legacy AZD provisioning path (not this cutover)

The included AZD/Bicep infrastructure deploys a Python 3.14 Flex Consumption Function App, storage, monitoring, and a user-assigned managed identity. It also grants that identity **Cognitive Services User** on the configured Azure OpenAI resource.

From the project root:

```powershell
az login
azd auth login
azd env select aoai-realtime-demo
azd up
```

This legacy configuration targets an existing Japan East demo environment.
Review the selected AZD environment and infrastructure parameters before deploying;
do not assume the stored subscription and resource-group settings match your environment.

After deployment, use the `SERVICE_API_URI` output followed by `/api/realtime-access` as the Function API URL in the demo page. Retrieve the `realtime-access` Function key from the Function App and enter it in the page.

## Azure permissions

The legacy AZD deployment above creates a user-assigned managed identity and
assigns **Cognitive Services User** at the Azure OpenAI resource scope. This is
not the identity model of the retained `func-robotics-v2`, which uses its existing
system-assigned identity. Do not recreate resources or replace identities to
perform the approved cutover. Preserve App Service identity/RBAC; it is unused
by the pages/relay for token issuance.

The person or deployment pipeline assigning that role also needs permission to create Azure role assignments, such as **Role Based Access Control Administrator** at the appropriate scope.

Do not place an Azure OpenAI API key in browser code. When `AOAI_API_KEY` is configured as a Function App application setting, the Function uses it only for server-side Azure OpenAI requests. Otherwise, it uses `DefaultAzureCredential`: Azure CLI credentials locally and managed identity in Azure.

When hosting the web application separately, configure the Function App CORS allowlist with the web application's exact origin.
