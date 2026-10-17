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

import json
import os
import time
import urllib.error
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
        },
    )

    for attempt in range(max_retries + 1):
        retry_after = 0.25 * (attempt + 1)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as resp:
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
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            failure = LLMError(f"LLM gateway 连接失败: {getattr(exc, 'reason', exc)}")
            if attempt == max_retries:
                raise failure from exc
        time.sleep(retry_after)
    raise AssertionError("不可达的重试状态")
