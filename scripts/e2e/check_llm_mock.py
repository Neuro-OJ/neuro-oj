"""使用临时端口核对标准 E2E Mock 契约，不接触任何运行栈。"""

import json
import threading
import unittest
from urllib.request import Request, urlopen

from llm_mock import LlmMockServer


class LlmMockContract(unittest.TestCase):
    def test_echo_usage_and_safe_read_only_records(self):
        server = LlmMockServer(("127.0.0.1", 0))
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(f"{base}/health") as response:
                self.assertEqual(json.load(response), {"ok": True})
            with urlopen(f"{base}/") as response:
                self.assertEqual(json.load(response), {"ok": True, "requests": []})
            request = Request(
                f"{base}/v1/chat/completions?key=private-query",
                data=json.dumps({
                    "model": "school-a-actual-model",
                    "messages": [{"role": "user", "content": "private-prompt"}],
                }).encode(),
                headers={"Authorization": "Bearer private-key", "Content-Type": "application/json"},
            )
            with urlopen(request) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.load(response), {
                    "ok": True,
                    "model": "school-a-actual-model",
                    "choices": [],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
                })
            expected = {"ok": True, "requests": [{"path": "/v1/chat/completions", "model": "school-a-actual-model"}]}
            for _ in range(2):
                with urlopen(f"{base}/") as response:
                    payload = json.load(response)
                    self.assertEqual(payload, expected)
                    self.assertNotIn("private", json.dumps(payload))
            with urlopen(f"{base}/health") as response:
                self.assertEqual(json.load(response), {"ok": True})
        finally:
            server.shutdown()
            worker.join()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
