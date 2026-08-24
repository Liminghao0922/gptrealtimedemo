# Azure OpenAI Realtime WebRTC Demo

This sample contains:

- A Python Azure Function that uses Microsoft Entra ID to request an ephemeral Azure OpenAI Realtime token.
- Browser demo applications that use the token to establish a WebRTC connection for real-time voice conversations.

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
|-- infra/
|   |-- ...
|-- azure.yaml
|-- README.md
```

## Prerequisites

- Python 3.14 or another version supported by Azure Functions
- Azure Functions Core Tools v4
- Azure CLI
- Azure Developer CLI (`azd`)
- An Azure OpenAI resource with a deployed Realtime model

For local authentication, sign in with an identity that can invoke the model:

```powershell
az login
```

The identity must have the **Cognitive Services User** role on the Azure OpenAI resource.

## Configure local settings

Update `api/local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "python",
    "AOAI_ENDPOINT": "https://aoai-realtime-test01.openai.azure.com/",
    "AOAI_REALTIME_DEPLOYMENT": "gpt-realtime-2.1-mini"
  }
}
```

`local.settings.json` is for local development only. Configure the same environment variables as Function App application settings after deployment.

## Install dependencies

From the project root:

```powershell
cd api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Run locally

Open one PowerShell terminal and start the Function host with CORS enabled for the local web server:

```powershell
cd api
func start --cors http://localhost:8000
```

Open a second PowerShell terminal from the project root and serve the web application:

```powershell
cd webapp
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/gpt-realtime-livevoice-demo.html
```

You can also open the function-calling map demo:

```text
http://localhost:8000/gpt-realtime_function_call_map.html
```

Both pages default to `http://localhost:7071/api/realtime-access`.

- The Function key field can be left empty when using the local Functions host.
- After deployment, enter the deployed Function endpoint and its `realtime-access` Function key.
- The map demo now also retrieves `ephemeral_token` and `webrtc_url` from the Function instead of calling Azure OpenAI sessions directly from browser code.

The API endpoint is:

- `POST /api/realtime-access` - creates an ephemeral Realtime client secret and returns the WebRTC endpoint

Allow microphone access when prompted, then select the start button.

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

Do not place an Azure OpenAI API key in browser code or application settings. The Function uses `DefaultAzureCredential`: Azure CLI credentials locally and managed identity in Azure.

When hosting the web application separately, configure the Function App CORS allowlist with the web application's exact origin.
