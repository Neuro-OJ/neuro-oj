"""本地验题夹具 evaluator：逐个调用 solve(a, b) 并按通过比例给分。"""

from noj_evaluator_sdk import SolutionRunner, configure_logging, result

configure_logging()

CASES = [(1, 2), (3, 4), (10, -5), (0, 0)]

runner = SolutionRunner()
passed = 0
for a, b in CASES:
    try:
        if runner.call("solve", a, b) == a + b:
            passed += 1
    except Exception as exc:  # noqa: BLE001 —— 选手异常计为该点不通过
        print(f"case ({a}, {b}) error: {exc}")
result.accept(100.0 * passed / len(CASES), details={"passed": passed})
