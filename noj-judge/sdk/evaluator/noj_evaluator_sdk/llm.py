"""
noj_evaluator_sdk.llm —— 通过 noj-llm-gateway 调用 OpenAI 兼容 LLM。

Evaluator 环境变量：
- NOJ_LLM_GATEWAY_URL：gateway 基址（如 http://noj-llm-gateway:8001）
- NOJ_LLM_TOKEN：短期 eval_token
- NOJ_LLM_PROVIDER_ID：provider ID（由 gateway 校验）
- NOJ_LLM_ALLOWED_MODELS：允许的模型列表（逗号分隔）

用法：
    from noj_evaluator_sdk import llm
    resp = llm.complete(model="qwen-plus", messages=[...], temperature=0)
"""

from __future__ import annotations

import http.client
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


class LLMError(Exception):
    """LLM 调用失败（配置缺失、token 失效、上游错误等）。"""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        error_code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code


def _enable_keepalive(sock: Any) -> None:
    """开启 TCP Keepalive 与 TCP_NODELAY，避免长推理期间被中间转发设备静默断开。"""
    if sock is None:
        return
    for level, optname, value in (
        (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1),
        (socket.IPPROTO_TCP, socket.TCP_NODELAY, 1),
    ):
        try:
            sock.setsockopt(level, optname, value)
        except OSError:
            pass
    for attr in ("TCP_KEEPIDLE", "TCP_KEEPALIVE"):
        opt = getattr(socket, attr, None)
        if opt is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, opt, 30)
            except OSError:
                pass
    for attr, val in (("TCP_KEEPINTVL", 10), ("TCP_KEEPCNT", 3)):
        opt = getattr(socket, attr, None)
        if opt is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, opt, val)
            except OSError:
                pass


class _KeepAliveHTTPConnection(http.client.HTTPConnection):
    """建立连接后自动开启 TCP Keepalive 的 HTTPConnection。"""

    def connect(self) -> None:
        super().connect()
        _enable_keepalive(self.sock)


class _KeepAliveHTTPSConnection(http.client.HTTPSConnection):
    """建立连接后自动开启 TCP Keepalive 的 HTTPSConnection。"""

    def connect(self) -> None:
        super().connect()
        _enable_keepalive(self.sock)


class _KeepAliveHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_KeepAliveHTTPConnection, req)


class _KeepAliveHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_KeepAliveHTTPSConnection, req, context=self._context)


_DEFAULT_URLOPEN = urllib.request.urlopen
_KEEPALIVE_OPENER = urllib.request.build_opener(
    _KeepAliveHTTPHandler,
    _KeepAliveHTTPSHandler,
)


def _open_request(request: urllib.request.Request, timeout: float) -> Any:
    """优先尊重测试对 `urlopen` 的替换以及调用方通过 `install_opener` 安装的网络配置；仅在未配置全局 opener 时使用 SDK 私有 Keepalive opener。"""
    if urllib.request.urlopen is not _DEFAULT_URLOPEN:
        return urllib.request.urlopen(request, timeout=timeout)
    installed = getattr(urllib.request, "_opener", None)
    if installed is not None:
        return installed.open(request, timeout=timeout)
    return _KEEPALIVE_OPENER.open(request, timeout=timeout)


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise LLMError(f"环境变量 {name} 未配置，无法调用 LLM gateway")
    return value


def _default_model() -> Optional[str]:
    models = os.environ.get("NOJ_LLM_ALLOWED_MODELS", "").strip()
    if models:
        return models.split(",")[0].strip()
    return None


# 本地验题（`noj-cli problem test --llm-mock`）使用的离线网关地址前缀。
# 生产网关地址只来自 noj-core 配置，恒为 http(s)，不会进入该分支。
MOCK_GATEWAY_PREFIX = "mock://"


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return str(content)


# mock 网关在本进程内累计的调用次数与 billed token（单次评测 = 单个 evaluator 进程）。
_mock_usage = {"calls": 0, "tokens": 0}


def _mock_budget(gateway_url: str) -> tuple[Optional[int], Optional[int]]:
    """从 `mock://echo?max_calls=N&max_tokens=M` 解析题目声明的单次评测预算。"""
    query = urllib.parse.urlsplit(gateway_url).query
    params = urllib.parse.parse_qs(query)

    def _int(name: str) -> Optional[int]:
        values = params.get(name)
        if not values:
            return None
        try:
            value = int(values[0])
        except ValueError:
            return None
        return value if value > 0 else None

    return _int("max_calls"), _int("max_tokens")


def _out_of_usage() -> LLMError:
    # 与网关超限响应一致：429 + code=out_of_usage，不重试。
    return LLMError(
        "LLM gateway 返回 429: Out of usage for this evaluation（本地 mock 预算）",
        status_code=429,
        error_code="out_of_usage",
    )


def _mock_completion(
    model: str, messages: list[dict[str, Any]], gateway_url: str = MOCK_GATEWAY_PREFIX
) -> dict[str, Any]:
    """离线回显：返回最后一条 user 消息原文，确定性、不联网、不计费。

    只用于验证预算、capability 封装与结果解析链路，**不代表真实模型效果**。
    与网关一致地拒绝不在 NOJ_LLM_ALLOWED_MODELS 内的别名，并按网关地址查询串
    中的 max_calls / max_tokens 执行单次评测预算（超出返回 429 out_of_usage）。
    """
    allowed = [
        m.strip()
        for m in os.environ.get("NOJ_LLM_ALLOWED_MODELS", "").split(",")
        if m.strip()
    ]
    if allowed and model not in allowed:
        raise LLMError(
            f"模型别名 {model} 不在允许列表内",
            status_code=403,
            error_code="model_not_allowed",
        )
    max_calls, max_tokens = _mock_budget(gateway_url)
    if max_calls is not None and _mock_usage["calls"] >= max_calls:
        raise _out_of_usage()
    if max_tokens is not None and _mock_usage["tokens"] >= max_tokens:
        raise _out_of_usage()
    user_texts = [_message_text(m) for m in messages if m.get("role") == "user"]
    content = user_texts[-1] if user_texts else ""
    prompt_tokens = sum(len(_message_text(m)) for m in messages) // 4 + 1
    completion_tokens = len(content) // 4 + 1
    _mock_usage["calls"] += 1
    _mock_usage["tokens"] += prompt_tokens + completion_tokens
    return {
        "id": "mock-completion",
        "object": "chat.completion",
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


def complete(
    model: Optional[str] = None,
    messages: Optional[list[dict[str, Any]]] = None,
    *,
    max_retries: int = 1,
    timeout: float = 185,
    **params: Any,
) -> dict[str, Any]:
    """
    调用 gateway 的 /v1/chat/completions。

    返回上游的标准 Chat Completions 响应字典。
    瞬时 5xx / 网络错误默认最多重试一次，每次请求均消耗平台调用预算。
    配额耗尽、鉴权失败不重试；timeout 含 Provider 排队和上游请求的时间。
    max_retries / timeout 是 SDK 控制参数，不会透传到模型。
    """
    if type(max_retries) is not int or not 0 <= max_retries <= 2:
        raise ValueError("max_retries 必须是 0..2 的整数")
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 300:
        raise ValueError("timeout 必须在 0..300 秒之间")
    gateway_url = _required_env("NOJ_LLM_GATEWAY_URL").rstrip("/")
    token = _required_env("NOJ_LLM_TOKEN")
    if not messages:
        raise LLMError("messages 不能为空")

    model = model or _default_model()
    if not model:
        raise LLMError("model 未指定且 NOJ_LLM_ALLOWED_MODELS 为空")

    if gateway_url.startswith(MOCK_GATEWAY_PREFIX):
        return _mock_completion(model, messages, gateway_url)

    body: dict[str, Any] = {"model": model, "messages": messages}
    body.update(params)

    url = f"{gateway_url}/v1/chat/completions"
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "Connection": "close",
        },
    )

    for attempt in range(max_retries + 1):
        retry_after = 0.25 * (attempt + 1)
        try:
            with _open_request(request, timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", errors="replace")
            finally:
                exc.close()
            error_code = None
            try:
                error = json.loads(detail).get("error")
                error_code = error.get("code") if isinstance(error, dict) else error
            except (ValueError, AttributeError):
                pass
            retryable = exc.code in (500, 502, 503, 504) or (
                exc.code == 429 and error_code in ("rate_limit_exceeded", "provider_queue_timeout")
            )
            failure = LLMError(
                f"LLM gateway 返回 {exc.code}: {detail}",
                status_code=exc.code, error_code=error_code,
            )
            try:
                retry_after = min(61.0, max(retry_after, float(exc.headers.get("Retry-After", "0"))))
            except (ValueError, TypeError):
                pass
            if not retryable or attempt == max_retries:
                raise failure from exc
        except (
            urllib.error.URLError,
            TimeoutError,
            ConnectionError,
            http.client.HTTPException,
        ) as exc:
            failure = LLMError(f"LLM gateway 连接失败: {getattr(exc, 'reason', exc)}")
            if attempt == max_retries:
                raise failure from exc
        time.sleep(retry_after)
    raise AssertionError("不可达的重试状态")
