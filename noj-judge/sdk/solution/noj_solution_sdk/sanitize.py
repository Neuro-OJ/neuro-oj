"""
noj_solution_sdk trace 路径清洗。

实现由 noj_sdk_common 共享，本模块仅做再导出以保持 SDK 公共 API。
"""

from noj_sdk_common.sanitize import sanitize_trace

__all__ = ["sanitize_trace"]
