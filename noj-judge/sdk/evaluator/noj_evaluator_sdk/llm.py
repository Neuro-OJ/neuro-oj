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
import urllib.error
import urllib.request
from typing import Any, Optional


class LLMError(Exception):
    """LLM 调用失败（配置缺失、token 失效、上游错误等）。"""


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
    **params: Any,
) -> dict[str, Any]:
    """
    调用 gateway 的 /v1/chat/completions。

    返回上游的标准 Chat Completions 响应字典。
    """
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

    try:
        with urllib.request.urlopen(request, timeout=120) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise LLMError(f"LLM gateway 返回 {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise LLMError(f"LLM gateway 连接失败: {e.reason}") from e

    return payload
