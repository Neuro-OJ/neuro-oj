"""从统一工程元数据选择现有 Core 域任务；新模块同时由完整分片任务覆盖。"""
import json
import os
from pathlib import Path


def select_domains(metadata, env):
    aliases = metadata["legacyDomainToModule"]
    if not aliases:
        raise ValueError("Core CI 元数据没有域别名，拒绝零测试选择")
    if env.get("CORE_SHARED") == "true":
        return sorted(aliases) + ["shared"]
    return sorted(name for name in aliases
                  if env.get("CORE_" + name.upper().replace("-", "_")) == "true")


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    metadata = json.loads((root / "dev-docs/engineering/module-boundaries.json").read_text())
    domains = select_domains(metadata, os.environ)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write("core-domains=" + json.dumps(domains) + "\n")
