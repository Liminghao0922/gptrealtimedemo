# Azure OpenAI Realtime: 開発者向けコードガイド

更新日: 2026年9月16日
関連資料: [README](../README.md)  
デモ入口: <https://app-realtime-f1-mh0922.azurewebsites.net/>

**切替状況（2026年9月16日）:** 既存 Python Function は**復旧し、トークン発行に利用可能**です。実 Function で不正キー401・不正 transport 400・WebRTC 200・WebSocket 200の4確認が合格し、両成功応答の残り期限は約7,199秒でした。Function CORS の F1 オリジン追加も既存値を保持して完了しています。**App Service 本番公開と、強化した公開後の3ページ音声受入試験が合格**しました。全ページで実入力の `input_audio_buffer.committed` 後に作成された応答の completed・音声受信、キー分離、Stop cleanup を確認しています。公開先の地図 / WebSocket は空でない入力 ASR 完了も確認しました。**livevoice は入力 ASR を有効にしていません**。

host / config / packaging は実装済みです。最新の試験結果は frontend 58件、統合 Node 109件 + Python 8件がすべて合格です。frontend の件数を統合結果に加算しません。過去の音声実測、今回の Function API・ローカルブラウザー実測、新しい公開後検証を区別します。復旧に関する運用上の前提は [README](../README.md) を参照してください。既存 ID・RBAC・SKU・モデルは変更していません。

## 1. 最初に読むコード

**Python などの非ブラウザークライアントから直接 WebSocket 接続する場合、最初に読むのは [customer-probe.cjs](../webapp/customer-probe.cjs) です。**

これは Node.js 製ですが、ブラウザー・WebRTC・relay を使わず、認証付き WebSocket、JSON イベント、PCM の変換・送信・受信を実装しています。Python へ移植する際は、言語の構文ではなく、この通信手順・状態遷移・エラー処理を参照してください。**完成した Python クライアントや、特定の端末・音声 SDK 向けの実装ではありません。**

| 開発したい部分 | 参照先 | 検索する関数・クラス |
| --- | --- | --- |
| Azure の接続先・認証ヘッダー | [customer-probe.cjs](../webapp/customer-probe.cjs) | `buildRealtimeUrl`、`validateRealtimeUrl`、`issueToken`、`acquireCredential` |
| 接続、設定確認、PCM 送受信 | [customer-probe.cjs](../webapp/customer-probe.cjs) | `runSession`、その内部の `sendAudio` |
| WAV 検証、16 → 24 kHz 変換 | [customer-probe.cjs](../webapp/customer-probe.cjs) | `readWav`、`resamplePcm16`、`pcmDelta`、`makeWav` |
| GA session 設定を作る | [realtime-experiments.js](../webapp/realtime-experiments.js) | `DEFAULT_PRESET`、`buildSessionUpdate` |
| 入力 ASR と AI 応答の完了判定 | [customer-probe.cjs](../webapp/customer-probe.cjs) | `validateEvent`、`EventCollector` |
| 接続し直す・認証を比較する | [customer-probe.cjs](../webapp/customer-probe.cjs) | `runWithAuth`、`execute`、`loadConfig` |
| Function で secret を発行 | [function_app.py](../api/function_app.py) | `realtime_access`、`_get_aoai_auth_headers`、`_get_realtime_urls` |
| Web ホストの公開設定・接続先検証 | [demo-config.cjs](../webapp/demo-config.cjs) | `readConfig`、`azureEndpoint`、`functionAccessUrl` |
| 公開設定 API・relay の認証・制限 | [server.cjs](../webapp/server.cjs) | `createDemoServer`、`validateConnection`、`keyMatches` |
| ブラウザーの転写表示・ログ | [realtime-experiments.js](../webapp/realtime-experiments.js) | `ExperimentRecorder`、`redact`、`createBrowserAccess` |
| マイク送信停止・再生完了待ち | [WebSocket ページ](../webapp/gpt-realtime-websocket-demo.html) | `startAudioCapture`、`playAudioChunk`、`handleEvent`、`stop` |
| ブラウザー WebRTC | [音声ページ](../webapp/gpt-realtime-livevoice-demo.html) | `start`、`stop` |
| Tool の実行結果を返す | [地図ページ](../webapp/gpt-realtime_function_call_map.html) | `updateSession`、`executeGeocoding` |
| Python のサーバー側 token 発行 | [function_app.py](../api/function_app.py) | `realtime_access`、`_get_aoai_auth_headers`、`_get_realtime_urls` |

リンク先のファイルで関数名を検索してください。行番号は編集で変わるため、以下も関数名を主な目印としています。

## 2. Python に移植する通信の順序

1. 認証方式を明示的に選択する。
2. トークン発行 API を利用する場合、POST で secret / WSS URL / expiry を取得する。
3. Azure OpenAI の WSS URL へ認証ヘッダー付きで接続する。
4. `session.created` を待つ。
5. `session.update` を送り、`session.updated` の実際の値を確認する。
6. PCM を変換・Base64 化し、`input_audio_buffer.append` で送信する。
7. VAD または明示的 commit でターンを確定する。
8. 入力転写、AI 応答、出力音声をそれぞれ受信・管理する。
9. 再生キューと残響待ちを含めてマイク再開を判断する。
10. 切断時は資源を解放し、必要に応じて新規接続・状態復元を行う。

既存の OpenAI 直接接続を残す場合も、Azure の設定を同じ変数へ暗黙に上書きせず、provider / endpoint / deployment / credential を組として選択してください。[CLI の `loadConfig` / `execute`](../webapp/customer-probe.cjs) は、Azure の各認証方式と、明示的な `openai` 比較コマンドを分離しています。自動で他 provider に音声を送る fallback はありません。

## 3. 認証と URL

### クライアント側

[customer-probe.cjs](../webapp/customer-probe.cjs) の以下を順に参照します。

- `normalizeFunctionAccess`: 既存 URL の `code` を取り除き、キーをヘッダーで扱う。キー競合は拒否。
- `issueToken`: 発行 API に `transport: "websocket"`、初期 voice / instructions を POST。戻り値を検証して接続用 credential を作る。
- `validateRealtimeUrl`: Function ホストへの誤接続、資格情報付き URL、GA / Preview の混在、デプロイ不一致等を拒否。
- `buildRealtimeUrl`: Azure HTTPS endpoint と deployment から `/openai/v1/realtime?model=...` の WSS URL を構成。
- `acquireCredential`: ephemeral / Entra / API key を明示的に分岐。ephemeral と Entra は Bearer、Azure API key は `api-key`。

**Function の HTTPS URL を WSS に置換しないでください。** 発行 API と Azure の音声 endpoint は別です。

CLI の既定は ephemeral です。`PROBE_FUNCTION_URL` は **Python Function の URL**、`PROBE_FUNCTION_KEY` はその **Function key** です。`issueToken` は `x-functions-key` を送信します。直接接続に Demo key や relay は不要です。App Service 更新後、旧 `/api/realtime-access` は **HTTP 410** で廃止し、Function へリダイレクトも代理転送もしません。URL とキーを明示的に切り替えてください。

Entra 直接接続では `PROBE_ENTRA_TOKEN`、API key 方式では `AOAI_API_KEY` を使います。**CLI は Entra token を自動取得・更新しません。** 本番の資格情報取得・更新は認証ライブラリ等を使って別途実装してください。

### 発行サーバー側：既存 Python Function のみ

[function_app.py](../api/function_app.py) の `realtime_access` が唯一の発行処理です。**端末用 Python 音声クライアントではなく、サーバー側の実装**です。

1. Function key は Azure Functions ホストが検証。
2. `_get_transport` で WebRTC / WebSocket を選択し、任意の voice / instructions を初期 session に反映。
3. `_get_aoai_auth_headers` は `AOAI_API_KEY` があればサーバー側で使用し、なければ `DefaultAzureCredential` で scope `https://cognitiveservices.azure.com/.default` の Entra token を取得。今回の既存 Function はシステム割り当てマネージド ID を使用。
4. `/openai/v1/realtime/client_secrets` に POST。
5. Azure 応答から `ephemeral_token` / `expires_at` を取り出し、選択した URL、model、transport、raw `session` とともに返す。`token_source` は返さない。

Function は取得値を返すため、**クライアントも secret が非空で期限が将来であることを検証**してください。サーバー用 Entra token は返しませんが、raw `session` 内にも ephemeral secret があるため、応答全体のログ保存は禁止してください。

| 条件 | 既存 Function の契約（今回変更なし） |
| --- | --- |
| 最小 WebSocket POST | `{"transport":"websocket"}`。`voice` / `instructions` は任意 |
| 空 body / 非 JSON / `{}` | WebRTC が既定。transport query も受け付けるが、WebSocket は JSON に明示する |
| 不正な transport | 400、`{"error":"transport must be either 'webrtc' or 'websocket'"}` |
| Azure 上流 HTTP エラー | 元の status を維持し、`{"error":"Azure OpenAI returned an error","details":...}` |
| 設定不足 / サーバー認証取得失敗 | 500 |
| Azure へのネットワーク失敗 | 502 |
| Function key の不足・不一致 | Functions ホストの認証エラー。handler と同じ JSON 形式とは限らない |

旧 Node issuer の毎分12回・同時発行2件・16 KiB body 検証・エラー変換を Function の仕様として扱いません。Function コードにアプリ独自の発行回数制御はありませんが、Azure のクォータと Function プラットフォーム制限は適用されます。契約の参照先は [test_function_app.py](../api/test_function_app.py) です。

### Web ホストの役割と公開設定

App Service はページと `/realtime-relay` を維持し、`GET /api/demo-config` で `{"function_url":"<Function URL>"}` を返します。[demo-config.cjs](../webapp/demo-config.cjs) の `readConfig`、`azureEndpoint`、`functionAccessUrl` が環境設定を検証します。`FUNCTION_ACCESS_URL` はキーなしの公開 URL で、3ページの編集可能な既定値になります。ページから Function へ直接 POST し、App Service は代理送信しません。Node の `realtime-access.cjs` と `@azure/identity` 依存は廃止します。

| 設定 | 承認済みの既存リソース |
| --- | --- |
| Function | `func-robotics-v2`、Japan East、Python 3.13、システム割り当てマネージド ID |
| `FUNCTION_ACCESS_URL` | `https://func-robotics-v2-e6ftfkgmhvb8c9b4.japaneast-01.azurewebsites.net/api/realtime-access` |
| RG / subscription | `rg-pec-robotics` / `a5095cf8-c1ec-4a7e-9ee7-22103870844b` |
| Azure OpenAI | `https://aoai-robotics.openai.azure.com/`、East US 2 |
| Realtime / ASR | `gpt-realtime-2.1-mini` / `gpt-4o-mini-transcribe`（変更なし） |

ブラウザーの Function POST は `x-functions-key` のみで認証し、Demo key は送信しません。WebRTC は Function key だけで利用し、WebSocket ページは relay 接続用に別途 Demo key を使用します。Function key を relay に渡してはいけません。

## 4. GA 設定と readiness

[realtime-experiments.js](../webapp/realtime-experiments.js) の `buildSessionUpdate` が、日文指示、voice、転写、VAD を GA の `audio.input` / `audio.output` 形式へまとめます。

- `DEFAULT_PRESET`: coral、mini-transcribe、ja、VAD threshold 0.75 / prefix 300 ms / silence 500 ms。
- `create_response: true`、`interrupt_response: false`。
- 転写を off にすると `audio.input.transcription: null`。
- 転写 prompt は AI の instructions とは別の設定。
- `session.model` はこの通常の更新には含めない。

[customer-probe.cjs](../webapp/customer-probe.cjs) のセッション構成処理は、`session.model` フィールドの受理を確認する互換実験用に **既定で model を追加**します。通常の移植・音声試験は `--omit-session-model` を指定してください。受理されても、接続中にモデルを変更できることを意味しません。

同じファイルの `runSession` は `session.created` 後に更新を1回送り、`configurationDifferences` で確認します。音声送信は `session.updated` 確認後です。WSS の Upgrade 101 や `relay.ready` だけでマイク送信を開始しない設計を参考にしてください。

比較時、`configurationDifferences` は deployment alias が base model 名に解決される場合を考慮し、session の model だけは完全一致比較から除外します。URL と要求した deployment の整合性確認とは別処理です。

## 5. 音声形式・VAD・送信

### PCM の変換

[customer-probe.cjs](../webapp/customer-probe.cjs) の `readWav` は RIFF chunk を解析して data 部分を取り出します。固定44バイトを無条件に切り落とす方式ではありません。mono / PCM16 little-endian / 16または24 kHz / 非空 / 最大30秒を検証します。

`resamplePcm16` は16 kHzから24 kHzへ線形補間します。テスト用の短いファイルには使えますが、**連続ストリーミング用の高品質・状態保持型リサンプラーではありません**。Python への移植時は、実装済みの変換処理や適切な音声ライブラリを使い、チャンク境界、サンプル数、クリッピング、品質を確認してください。各チャンクを独立に丸めて変換するだけでは境界ずれやノイズを招きます。

### append とターン確定

`runSession` 内の `sendAudio` は、24 kHz / 16-bit / mono の **4,800 bytes = 100 ms** を単位に Base64 化し、実時間に合わせて送ります。既定 VAD 試験では300 msの先頭無音と800 msの末尾無音を追加します。

- VAD 使用時: append を継続し、サーバーの speech stopped / commit / response を待つ。
- `--manual-commit`: `turn_detection: null` にし、全 PCM の送信後に1回 commit → `response.create`。
- 空音声は拒否。VAD と重複する手動 commit は送らない。
- WebSocket の送信 backlog、payload、試験時間、メモリーに上限を設ける。

この CLI は比較のためにファイル全体を送るので、**AI が話していてもアップロードを止めません**。実機の半二重マイク制御と同一の動作ではありません。

### 音声受信

`pcmDelta` は Base64 と PCM16 のサンプル境界を検証します。`makeWav` は受信 PCM を WAV として保存するための関数です。`--output-wav` は任意指定であり、CLI 自体は実スピーカーを鳴らしません。実再生キューは次節のブラウザー実装を動作例として参照してください。

## 6. transcribe と完了判定

最も重要な参照は [customer-probe.cjs](../webapp/customer-probe.cjs) の `EventCollector` と、[realtime-experiments.js](../webapp/realtime-experiments.js) の `ExperimentRecorder` です。

| 処理 | ID / 主なイベント | 参照メソッド |
| --- | --- | --- |
| 入力 ASR | `item_id` + `content_index`、input_audio_transcription delta / completed / failed | `EventCollector.accept`、`ExperimentRecorder.record` |
| AI の音声字幕 | `response_id` + `item_id` + `content_index`、output_audio_transcript delta / done | 同上。入力用 Map と出力用 Map を分離 |
| AI 応答の状態 | `response.id`、created / done の `response.status` | `EventCollector.complete`、`outcomes` |
| 出力音声 | output_audio delta / done、受信バイト数 | `EventCollector.accept`、`outcomes` |
| 保存・表示 | 入力、AI 字幕、失敗、実測設定を別々に出力 | `EventCollector.evidence`、`ExperimentRecorder.snapshot` |

入力 ASR は Realtime が音声を理解する処理とは別です。2026年9月16日の切替前の試験では、ASR が `DeploymentNotFound` でも AI 音声は成功し、ASR off でも対話は成功しました。

**`response.done` で全処理が終わったと判定しないでください。** `EventCollector.complete` は、観測した全入力 item の ASR 終端、進行中の speech / response の有無を追います。`runSession` はさらに upload 終了、出力音声 delta / done、最後の関連イベントから1,200 msの quiet period を確認します。この待機時間は試験終了のための実装値であり、サービスの最大遅延保証ではありません。常時対話アプリは1ターン完了ごとに socket を閉じる必要はありません。

ASR の `.failed` は記録しつつ AI 音声の受信を継続します。ただし転写も要件とする CLI 試験全体は failed にします。試験用の合否と、アプリで音声対話を続ける UX を分けてください。

`ExperimentRecorder` は確定 transcript で途中の delta を置き換えるので、部分文字列と最終文字列の二重表示を防ぎます。入力転写の有効化は、Azure の**実デプロイ名**を使ってください。今回の `gpt-4o-mini-transcribe` はモデル ID とデプロイ名が同じだったケースです。

遅延の定義にも注意してください。CLI の転写 latency は最初の音声 append 基準、ブラウザーの `firstAfterCommitMs` / `finalAfterCommitMs` は commit / speech-end イベントの受信基準です。両者をそのまま比較してモデル速度や SLA と解釈しないでください。

## 7. マイク停止・再生・切断

[WebSocket ページ](../webapp/gpt-realtime-websocket-demo.html) を参照します。

- `start`: secret を取得し、マイクと24 kHz AudioContext を新規作成。実 sample rate を検証。
- `encodePcm16` / `decodePcm16`: ブラウザーの Float32 と PCM16/Base64 を変換。端末ですでに PCM16 を取得しているなら同じ変換を重ねる必要はありません。
- `startAudioCapture`: `session.updated` 後に開始。手動 pause、AI 応答中、再生キュー、残響待ちを確認して append を抑制。
- `playAudioChunk`: `nextPlaybackTime` で音声チャンクを順に配置。再生 source の終了後に300 msの待ちを追加。
- `handleEvent`: `response.created` / `response.done` で応答状態を管理し、入力 ASR 失敗を独立表示。
- `stop`: processor、マイク全 track、socket、再生 source、AudioContext を解放して状態をリセット。

AI の `response.done` や `response.output_audio.done` は、実スピーカーの再生完了ではありません。**応答状態 + 再生キュー + 残響待ち**を分けて管理する点が移植対象です。

手動 pause はアプリの都合によるマイク送信停止のテストに使えますが、実機の状態検出・AEC を実装しているわけではありません。mute 判定後の `GainNode` の値0はローカルモニターを消すためのもので、入力 PCM をゼロにする設定ではありません。

ブラウザー実装はデモ用 `ScriptProcessor` を使います。ブラウザー製品化では AudioWorklet 等を検討し、非ブラウザークライアントでは使用する音声 SDK の capture/playback loop に状態管理を移植してください。Stop 後の media track は ended なので、再接続で使い回さず再取得します。

### reconnect の検証と本番設計の違い

[customer-probe.cjs](../webapp/customer-probe.cjs) の `execute` の `reconnect` 分岐は、設定確認後に意図的に切断し、新しい secret で再接続します。`--reuse-token` は同一 secret の追加比較を明示的に有効にするだけです。

`runWithAuth` の既定は ephemeral の認証エラーに対する再発行1回、`--auth-retries` の指定範囲は0～2です。401 / 403以外や Entra / API key に自動切替は行いません。発行 API 自体の401 / 403も試行対象になり得るため、エラー発生箇所を記録して切り分けます。429の汎用 retry、Entra の refresh、会話復元、業務操作の重複抑止まで完成した本番 reconnect manager ではありません。

## 8. ブラウザー固有の実装（直接 WebSocket 接続には不要）

### 同一ホストの relay

[server.cjs](../webapp/server.cjs) の `validateConnection` と `createDemoServer` が担当します。

- ブラウザー → `/realtime-relay` に WSS 接続。
- 最初の `connect` フレームで Azure URL、ephemeral token、Demo key を `access_key` として渡す。Function key は渡さない。
- Host / Origin / key / Azure リソース / deployment を検証。
- サーバー → Azure に Bearer ヘッダーを付け、イベントを双方向転送。
- 最大2 active relay、15分の独自上限、1 MiB の payload/buffer 上限、timeout、切断時の上流 cleanup。旧 Node issuer の発行制限とは別。

これはブラウザーのヘッダー制約を補う層です。Python から Azure へ直接接続する際に `connect` / `relay.ready` / `relay.error` を送受信する必要はありません。いずれも Azure の標準イベントではありません。

### WebRTC

[音声ページ](../webapp/gpt-realtime-livevoice-demo.html) の `start` はマイク track、RTCPeerConnection、DataChannel、SDP offer / answer を扱います。SDP POST `/openai/v1/realtime/calls` にも同じ発行元の ephemeral token を使用し、音声は WebRTC で直接 Azure と送受信します。

このページは入力 ASR を既定で有効化せず、アプリ側の半二重 gate もありません。今回の3ページ音声検証では、このページに限り試験側から mini-transcribe を明示的に有効化しました。入力 ASR の開発参考は WebSocket ページを優先してください。

### Tool 呼び出し

[地図ページ](../webapp/gpt-realtime_function_call_map.html) の `updateSession` は `map_geocoding` の schema を登録し、`executeGeocoding` は `call_id` に対応する `function_call_output` を返して `response.create` を送ります。

移植対象は「引数検証 → 許可された処理 → call_id 付き結果 → 次の応答」という契約です。DOM、地図、外部 geocoding サービスは別用途です。重要な外部操作には追加の認可・入力検証・重複抑止が必要です。今回のオンライン検証は地図ページの音声経路についてであり、全 tool 分岐の受入試験ではありません。

## 9. ログ・エラー・運用

- [CLI の `Redactor` / `createContext`](../webapp/customer-probe.cjs): 入力キー、取得 token、入れ子の secret、エラー本文等を脱敏してレポート化。
- [ブラウザーの `createBrowserAccess` / `redact`](../webapp/realtime-experiments.js): 共通の発行 API 呼び出し、資格情報の混同防止、URL 正規化、表示用 `safe` 処理。
- [CLI の `classifyError` / `networkProbe`](../webapp/customer-probe.cjs): DNS / TCP / TLS / timeout / Upgrade の区分。network は設定された Azure ホストの TCP443 / TLS を確認するだけで、認証付き Upgrade は `inspect` が担当。

接続 API の raw response は保存しないでください。`session.value` 等にも secret が存在します。脱敏したレポートにも発話、instructions、リソース名が含まれるため、共有前の確認が必要です。

`networkProbe` は社内 proxy の自動設定まで行いません。TLS 検証を無効にせず、実機ネットワークに合わせて認証付き proxy、DNS、接続維持を確認してください。

デモの [appservice.bicep](../infra/appservice.bicep) は Linux F1 / Node24 を維持します。既存 App Service の system-assigned identity と Azure OpenAI account に限定した RBAC は今回削除せず保持しますが、トークン発行には使用しません。[deploy-appservice.ps1](../scripts/deploy-appservice.ps1) は既存引数に加えて非秘密の `-FunctionAccessUrl` が必須です。対象を `ValidateSet` で固定しているため、**別環境へそのまま実行する汎用デプロイスクリプトではありません。** 旧 [azure.yaml](../azure.yaml) は別の Function / SWA 経路であり、今回のリソース再作成に使いません。

今回の App Service 切替は、他の既存設定・ID・RBAC を保持し、`FUNCTION_ACCESS_URL` の対象設定のみの更新と9ファイルの ZIP 公開で完了しました。full ARM apply は実施していません。上記スクリプトは引き続き検証付き AVM 再プロビジョニングを提供する**別の経路**で、設定のみの更新と同一ではありません。ARM テンプレートの変更範囲を確認して選択してください。公開後の3ページ受入試験も合格しています。

既存 Function への反映は [Azure Functions デプロイ手順](azure-functions-portal-ja.md) の Core Tools による**手順4/5**を参照し、リソース作成は省略します。同資料の手順7/8はブラウザー WebRTC の確認であり、直接 Python / WebSocket の手順ではありません。ブラウザー切替では Function の既存 CORS 値を残し、`https://app-realtime-f1-mh0922.azurewebsites.net` を追加します。ローカル Web ホストでも `FUNCTION_ACCESS_URL` を使えます。設定例は [README](../README.md) を参照してください。

## 10. 手元での確認手順

以下は Windows / PowerShell、リポジトリルートからの実行例です。Node.js 22以上と、[package.json](../webapp/package.json) の依存関係が必要です。未導入の環境では `npm --prefix .\webapp ci` を実行します。音声試験は Azure の使用料金が発生します。

### まずヘルプ（クラウド通信なし）

```powershell
node .\webapp\customer-probe.cjs --help
```

### 既存 Function から secret を取得し、Azure へ直接接続

`PROBE_FUNCTION_KEY` には対象 Function の Function key を安全な方法で設定しておいてください。**Demo key は使いません。** コマンドライン引数やファイルへの直書きは不要です。環境に `AOAI_ENDPOINT` / `AOAI_REALTIME_DEPLOYMENT` が残っている場合は発行 API の返す値と一致する必要があります。下記の切替後の実環境検証結果は未確定です。

```powershell
$env:PROBE_FUNCTION_URL = 'https://func-robotics-v2-e6ftfkgmhvb8c9b4.japaneast-01.azurewebsites.net/api/realtime-access'
node .\webapp\customer-probe.cjs inspect --omit-session-model
node .\webapp\customer-probe.cjs audio --omit-session-model --transcription gpt-4o-mini-transcribe --wav .\assets\transcription-ja-16k.wav
node .\webapp\customer-probe.cjs audio --omit-session-model --transcription off --wav .\assets\transcription-ja-16k.wav
```

`inspect` の成功は接続・設定確認です。入力転写の成功には `audio` の結果が必要です。この例は **relay ではなく Azure への直接接続**なので、端末から Azure ホストへの通信許可が必要です。実際に使用する端末とネットワークで、ephemeral 認証から音声送受信まで別途確認してください。

### Entra 直接方式

Azure OpenAI に使用できる Entra token を `PROBE_ENTRA_TOKEN` に安全に設定してから実行します。Function / Demo key はこの方式では使いません。

```powershell
$env:AOAI_ENDPOINT = 'https://<resource>.openai.azure.com'
$env:AOAI_REALTIME_DEPLOYMENT = '<actual-realtime-deployment>'
node .\webapp\customer-probe.cjs audio --auth entra --omit-session-model --transcription <actual-transcribe-deployment> --wav .\assets\transcription-ja-16k.wav
```

山括弧の値は実値に置き換えてから実行してください。CLI が確認するのは転写終端と音声・応答の完了であり、業務上期待する文字列との一致や音質までは自動合格条件ではありません。今回の固定文についてはレポートの transcript と照合しました。

### 追加の明示的な試験

| コマンド / オプション | 意味・注意 |
| --- | --- |
| `transcribe-matrix --omit-session-model --wav ...` | 同じ WAV で off / Whisper / mini / full を比較。未デプロイの候補は失敗する。`--custom-transcription` で実名を追加 |
| `audio --manual-commit --omit-session-model --wav ...` | VAD なしの手動 commit 比較 |
| `reconnect --omit-session-model` | 故意の切断後、新しい secret で設定確認。音声再送・会話復元の試験ではない |
| `reconnect --omit-session-model --reuse-token` | 同一 secret の再利用も追加確認。期限境界の耐久試験ではない |
| `auth-matrix --omit-session-model` | 独立した3種類の資格情報を比較。未設定方式は skipped |
| `network` | Azure host の DNS / TLS。`AOAI_ENDPOINT` を設定し、Upgrade は別途 `inspect` |
| `--report <new-json-path>` | 新しいパスに脱敏レポートを保存。既存ファイルは上書きしない |
| `--output-wav <new-wav-path>` | 単一音声試験の応答 PCM を WAV 保存 |
| `--timeout-ms` | 既定60,000、指定可能1,000～120,000 ms。`--timeout` ではない |
| `soak --allow-load --seconds N --concurrency N` | 明示的 opt-in の idle 試験。最大3,600秒・4接続。音声負荷やサービス上限の証明ではない |

本番デプロイの割当を確認せず、負荷試験を自動実行しないでください。

### TTS / MP3 は別試験

[customer-probe.cjs](../webapp/customer-probe.cjs) の `ttsRequest` / `runTts` を参照してください。TTS 用 endpoint、deployment、認証を別設定とし、`coral` / `mp3` を要求します。`--tts-auth entra` は `TTS_ENTRA_TOKEN`、`--tts-auth api-key` は `TTS_API_KEY`、共通で `TTS_AOAI_ENDPOINT` / `TTS_DEPLOYMENT` が必要です。

Realtime secret を暗黙に使い回しません。`tts --negative-ephemeral` は意図的な負の認証実験専用で、推奨接続方式ではありません。MP3 の header / bytes の確認はできますが、聴取品質や採用するバージョンの Azure TTS 検証は別途必要です。

## 11. テストの参照先と移植時の受入条件

| 検証対象 | テスト |
| --- | --- |
| Function 戻り値、expiry、URL、独立認証 | [customer-probe.test.cjs](../webapp/customer-probe.test.cjs)、[test_function_app.py](../api/test_function_app.py) |
| 公開 Function URL・Azure endpoint・起動設定 | [demo-config.test.cjs](../webapp/demo-config.test.cjs) |
| PCM / resample / VAD / manual commit / readiness | [customer-probe.test.cjs](../webapp/customer-probe.test.cjs)、[realtime-experiments.test.cjs](../webapp/realtime-experiments.test.cjs) |
| late ASR、全 item、failed と音声成功、イベント構造 | [customer-probe.test.cjs](../webapp/customer-probe.test.cjs)、[realtime-experiments.test.cjs](../webapp/realtime-experiments.test.cjs) |
| 応答中・再生中・300 ms tail・pause・再接続 | [websocket-ui.test.cjs](../webapp/websocket-ui.test.cjs) |
| 公開設定・旧 route の410・Demo key / Origin / Host / relay2接続 | [server.test.cjs](../webapp/server.test.cjs) |
| ブラウザー共通認証・WebRTC cleanup・map のイベント順序 | [browser-ui.test.cjs](../webapp/browser-ui.test.cjs) |
| key 正規化・network 分類・TTS の独立認証 | [customer-probe.test.cjs](../webapp/customer-probe.test.cjs) |
| 既存 Python Function の契約 | [test_function_app.py](../api/test_function_app.py) |

テスト名の一部である `paced VAD audio waits for late user transcription after response.done; no empty or duplicate commit` と、`transcription failure stays visible without stopping speech; manual reconnect mints fresh token` を検索すると、転写の遅延完了と、転写失敗時の音声継続・再接続の挙動を確認できます。

全オフラインテストは以下です。Python の例は既存の API 用仮想環境を使用します。どちらも実モデルへの呼び出しは行いません。

```powershell
npm --prefix .\webapp test
.\api\.venv\Scripts\python.exe -m unittest discover -s .\api -p test_function_app.py -v
```

**歴史的証跡（2026年9月16日、元の構成）:** Node 95件 + Python 8件が合格。Node / Entra 直接音声試験、旧 Node 発行元の relay 2セッション、実ブラウザー3ページの入力転写・AI 応答・Stop を確認しました。当時の livevoice には試験側から ASR を追加設定しており、既定動作でも今回の試験条件でもありません。

**今回の検証結果:** frontend 58件、統合 Node 109件 + Python 8件がすべて合格。実 Function のキー・transport・両方式の発行の4確認も合格しました。さらにローカルのネイティブ Edge で以下を確認しました。

| ページ | 今回のローカル実測 |
| --- | --- |
| livevoice / WebRTC | 受信音声、応答完了、cleanup が合格。**入力 ASR は有効化しておらず、ASR 成功は主張しない** |
| 地図 / WebRTC | 受信音声、応答完了、cleanup が合格。`gpt-4o-mini-transcribe` / `ja` を要求し、17文字の入力転写を観測 |
| WebSocket（独立試験） | mini-transcribe 入力 ASR、AI 音声、Function / relay のキー分離、cleanup が合格 |

これはローカルホストからの試験で、公開先 App Service の確認でも直接 Python / 実機の試験でもありません。

**本番公開・強化した公開後音声受入: 全3ページ合格（2026年9月16日）。** `FUNCTION_ACCESS_URL` の対象設定更新 + 9ファイルの ZIP 公開が完了し、<https://app-realtime-f1-mh0922.azurewebsites.net/> で実 Function トークンを使って確認しました。最新のゲートは全ページで、**実入力の `input_audio_buffer.committed` 後に作成された応答**の completed と音声受信を必須とし、挨拶だけでは合格しません。地図 / WebSocket は `gpt-4o-mini-transcribe` による空でない入力 ASR 完了も必須とし、両方合格しました。以前の地図 snapshot の証跡不足は、この新しい公開先試験で解消しています。全ページの資格情報分離・Stop cleanup も合格し、livevoice の入力 ASR は無効のままです。App Service の **F1 Free** と、Function ID の Azure OpenAI リソースに限定した **Cognitive Services OpenAI User** ロールも確認済みです。full ARM apply は実施せず、既存 ID・RBAC・SKU・モデルを保持しています。この公開後実測も、直接 Python / 実機や本番負荷の確認を代替しません。

Python への移植後も「接続できた」だけでなく、次を受入条件にしてください。

1. 認証付き Upgrade と設定確認後にのみ音声を送信する。
2. 同じ固定 WAV の入力 transcript を期待文と照合する。
3. 入力 ASR と AI 字幕を混同しない。late completed / failed を保持する。
4. 出力 PCM の形式と実スピーカー再生を確認する。
5. VAD / 手動 commit / ミュートに重複・欠落がない。
6. 切断時に capture / playback / socket / timer を解放し、必要な会話状態だけ復元する。
7. secret、キー、raw 音声を不用意にログ・URL・永続設定へ残さない。

F1 ホスティング、デモの制限、モデル利用料金、実機・負荷・期限・TTS の検証範囲は [README](../README.md) を参照してください。
