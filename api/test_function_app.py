import json
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

import azure.functions as func

import function_app


class RealtimeAccessContractTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(
            "os.environ",
            {
                "AOAI_ENDPOINT": "https://example.openai.azure.com/",
                "AOAI_REALTIME_DEPLOYMENT": "custom-realtime-deployment",
                "AOAI_API_KEY": "unit-test-key",
            },
            clear=True,
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    @staticmethod
    def request(body=None, params=None):
        return func.HttpRequest(
            method="POST",
            url="https://example.azurewebsites.net/api/realtime-access",
            headers={"x-functions-key": "function-test-key"},
            params=params or {},
            body=json.dumps(body).encode() if body is not None else b"",
        )

    @staticmethod
    def upstream(payload, status=200):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps(payload).encode()
        response.getcode.return_value = status
        return response

    def test_q1_q2_q3_q4_q6_ephemeral_issuer_contract_and_customer_settings(self):
        with patch(
            "function_app.urllib.request.urlopen",
            return_value=self.upstream({"value": "ephemeral-test", "expires_at": 123456}),
        ) as send:
            response = function_app.realtime_access(
                self.request(
                    {"transport": "websocket", "voice": "coral", "instructions": "Test"}
                )
            )
        self.assertEqual(response.status_code, 200)
        result = json.loads(response.get_body())
        self.assertEqual(result["ephemeral_token"], "ephemeral-test")
        self.assertEqual(result["expires_at"], 123456)
        self.assertEqual(result["model"], "custom-realtime-deployment")
        self.assertEqual(
            result["websocket_url"],
            "wss://example.openai.azure.com/openai/v1/realtime?model=custom-realtime-deployment",
        )
        self.assertEqual(result["websocket_url"], result["realtime_url"])
        request = send.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://example.openai.azure.com/openai/v1/realtime/client_secrets",
        )
        self.assertEqual(
            json.loads(request.data),
            {
                "session": {
                    "type": "realtime",
                    "model": "custom-realtime-deployment",
                    "instructions": "Test",
                    "audio": {"output": {"voice": "coral"}},
                }
            },
        )
        self.assertNotIn("function-test-key", str(request.headers))
        self.assertNotIn("unit-test-key", response.get_body().decode())

    def test_q4_existing_empty_body_keeps_webrtc_and_nested_token_shape(self):
        with patch(
            "function_app.urllib.request.urlopen",
            return_value=self.upstream(
                {"client_secret": {"value": "nested-test", "expires_at": 789}}
            ),
        ):
            result = json.loads(
                function_app.realtime_access(self.request()).get_body()
            )
        self.assertEqual(result["transport"], "webrtc")
        self.assertTrue(result["webrtc_url"].endswith("/openai/v1/realtime/calls"))
        self.assertEqual(result["ephemeral_token"], "nested-test")
        self.assertEqual(result["expires_at"], 789)

    def test_q4_invalid_transport_is_400_without_upstream_call(self):
        for transport in ["udp", 42, [], {}]:
            with self.subTest(transport=transport), patch(
                "function_app.urllib.request.urlopen"
            ) as send:
                response = function_app.realtime_access(
                    self.request({"transport": transport})
                )
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", json.loads(response.get_body()))
                send.assert_not_called()

    def test_q1_entra_credential_is_used_only_upstream_not_returned_to_client(self):
        with patch.dict("os.environ", {"AOAI_API_KEY": ""}), patch.object(
            function_app.credential, "get_token"
        ) as get_token, patch(
            "function_app.urllib.request.urlopen",
            return_value=self.upstream({"value": "separate-ephemeral-test"}),
        ) as send:
            get_token.return_value.token = "entra-test-only"
            response = function_app.realtime_access(self.request({"transport": "websocket"}))
        get_token.assert_called_once_with(function_app.COGNITIVE_SCOPE)
        headers = {key.lower(): value for key, value in send.call_args.args[0].headers.items()}
        self.assertEqual(headers["authorization"], "Bearer entra-test-only")
        self.assertNotIn("api-key", headers)
        self.assertNotIn("entra-test-only", response.get_body().decode())
        result = json.loads(response.get_body())
        self.assertEqual(result["ephemeral_token"], "separate-ephemeral-test")
        self.assertIsNone(result["expires_at"])

    def test_q4_authentication_failure_returns_error_without_upstream_request(self):
        with patch.dict("os.environ", {"AOAI_API_KEY": ""}), patch.object(
            function_app.credential, "get_token", side_effect=RuntimeError("Test credential failure")
        ), patch("function_app.urllib.request.urlopen") as send:
            response = function_app.realtime_access(self.request())
        self.assertEqual(response.status_code, 500)
        self.assertIn("Failed to authenticate", json.loads(response.get_body())["error"])
        send.assert_not_called()

    def test_q4_q5_azure_auth_and_quota_errors_keep_status_and_details(self):
        from io import BytesIO

        for status in [401, 403, 429]:
            with self.subTest(status=status), patch(
                "function_app.urllib.request.urlopen",
                side_effect=urllib.error.HTTPError(
                    "https://example.openai.azure.com",
                    status,
                    "Test failure",
                    {},
                    BytesIO(b'{"error":{"code":"test_error","message":"Test failure"}}'),
                ),
            ):
                response = function_app.realtime_access(self.request())
                self.assertEqual(response.status_code, status)
                self.assertEqual(
                    json.loads(response.get_body())["details"]["error"]["code"],
                    "test_error",
                )

    def test_q4_network_failure_is_502_and_missing_config_is_500(self):
        with patch(
            "function_app.urllib.request.urlopen",
            side_effect=urllib.error.URLError("network unavailable"),
        ):
            self.assertEqual(
                function_app.realtime_access(self.request()).status_code, 502
            )
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(
                function_app.realtime_access(self.request()).status_code, 500
            )

    def test_q2_1_deployment_is_url_encoded_never_function_url_or_key(self):
        webrtc, websocket = function_app._get_realtime_urls(
            "https://example.openai.azure.com/", "deployment with+symbols"
        )
        self.assertEqual(
            websocket,
            "wss://example.openai.azure.com/openai/v1/realtime?model=deployment+with%2Bsymbols",
        )
        self.assertEqual(
            webrtc, "https://example.openai.azure.com/openai/v1/realtime/calls"
        )
        self.assertNotIn("api-version", websocket)
        self.assertNotIn("code=", websocket)


if __name__ == "__main__":
    unittest.main()
