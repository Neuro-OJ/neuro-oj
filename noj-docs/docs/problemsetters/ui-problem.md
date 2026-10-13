# 界面题

界面题（`submission_mode: "ui"`）让出题人**随题包提供一个 HTML 界面**：选手在界面里填写参数
（提示词、温度、开关、下拉……），平台把这些参数注入出题人的脚本模板，生成 Python 脚本交给
judge 运行并评测。**后端评测机制不变**，变的只是"脚本从哪来"——不再是选手手写，而是由界面驱动。

适合：Prompt 工程、超参数调节、配置类题目——选手只需关心几个可调参数，不必写代码。
想让选手"只编辑一段提示词"？写一个只含一个 `<textarea>` 的 `ui.html` 即可（见下文示例）。

## 工作原理

```text
选手操作 ui.html ──postMessage──▶ 做题页（宿主）
                                   │  收集参数 JSON，如 {"prompt": "...", "temperature": 0.2}
                                   ▼  提交：language = "ui"，submissions.code 保存参数 JSON
                                noj-core
                                   │  构造评测任务时把参数注入脚本模板 template.py
                                   ▼
                      Solution 容器：运行「注入参数 + template.py」生成的脚本
                                   ▲
                                   │ runner.call(...)（与代码题完全一致）
                      Evaluator 容器：evaluate.py
```

注入后的脚本形如：

```python
PARAMS = {...}                  # 界面传来的全部参数
prompt = PARAMS["prompt"]       # 每个字段同时展开为同名模块级变量
temperature = PARAMS["temperature"]
# ── 以下为题目脚本模板（template.py） ──
...
```

参数以 Base64 嵌入，字段值里的引号、反斜杠、三引号都不会破坏脚本源码。Python 关键字
（如 `class`）作为字段名时只出现在 `PARAMS` 里，不展开成变量。

## 题包结构

在题包根目录放：

| 文件 | 说明 |
|---|---|
| `ui.html` | **必须**。题目界面，固定文件名、根级，≤ 512 KiB |
| `template.py` | 脚本模板：可直接使用上面注入的 `PARAMS` 与同名变量，定义 evaluator 要调用的函数 |
| `evaluate.py` | 评测脚本，与代码题一致 |
| `problem.json` | 声明 `"submission_mode": "ui"` |

```json
{
  "format_version": 1,
  "title": "情感分类调参",
  "type": "P",
  "submission_mode": "ui",
  "runtime_config": {
    "evaluator": { "image": "noj-evaluator-python", "time_limit_ms": 120000, "memory_limit_mb": 256 },
    "solution": { "image": "noj-solution-python", "call_timeout_ms": 5000, "memory_limit_mb": 128 }
  }
}
```

导入时缺少 `ui.html` 会直接 400。`ui.html` 随题包按版本管理：做题页永远加载**实际判卷版本**的界面，
不会出现"界面是新版、脚本是旧版"的错配。界面题不下发 `template.py`（它是出题人的评测逻辑），
选手只能通过界面填参数；OI 题与客观题不支持界面模式。

## 编写 ui.html

`ui.html` 可以是完整文档，也可以只是片段；它运行在**沙箱 iframe** 里，平台在其前注入了
`window.NOJ`：

```html
<label>提示词</label>
<textarea id="p" rows="8" style="width:100%"></textarea>
<label>温度 <input id="t" type="range" min="0" max="1" step="0.1"></label>
<button id="run">自测</button> <button id="go">提交</button>
<div id="status"></div>

<script>
  var p = document.getElementById('p'), t = document.getElementById('t');

  // 1. 初始化 / 被回滚时：用 values 刷新控件
  function render(v) { p.value = v.prompt || ''; t.value = v.temperature ?? 0.2; }
  NOJ.onInit(render);
  NOJ.onSet(render);

  // 2. 控件变化时：把整份参数同步给宿主
  function sync() { NOJ.setValues({ prompt: p.value, temperature: Number(t.value) }); }
  p.oninput = t.oninput = sync;

  // 3. 按钮触发自测 / 提交；状态变化时展示
  document.getElementById('run').onclick = NOJ.selfTest;
  document.getElementById('go').onclick = NOJ.submit;
  NOJ.onResult(function (r) {
    document.getElementById('status').textContent =
      r ? r.label + (r.score != null ? '（' + r.score + ' 分）' : '') : '';
  });
</script>
```

对应的 `template.py` 可以直接用 `prompt` 与 `temperature`：

```python
def solve(text: str) -> str:
    # 这里是出题人的逻辑；prompt / temperature 由界面注入
    return f"{prompt}\n{text}"
```

### `window.NOJ` 接口

| 成员 | 说明 |
|---|---|
| `NOJ.values` | 当前参数（只读快照） |
| `NOJ.onInit(fn)` | 界面就绪时回调 `fn(values)`；已就绪则立即回调 |
| `NOJ.onSet(fn)` | 参数被外部修改（回滚到历史版本、恢复草稿）时回调——**必须据此刷新控件** |
| `NOJ.setValues(obj)` / `NOJ.update(patch)` | 整份替换 / 合并更新参数，并通知宿主 |
| `NOJ.submit()` / `NOJ.selfTest()` | 请求提交评测 / 运行自测 |
| `NOJ.onResult(fn)` / `NOJ.result` | 最近一次运行状态：`{kind, status, label, score, output}` |
| `NOJ.disabled` / `NOJ.onDisabled(fn)` | 只读状态（未登录、比赛未开始等）：此时应禁用控件 |
| `NOJ.title` | 题目标题 |

### 参数约束

- 必须是 JSON 对象；字段名只能是**字母开头**的字母、数字、下划线（它们会变成 Python 变量名），
  至多 100 个字段；值的类型不限，由脚本模板自行校验。
- 整份参数 JSON 受 100KB 提交上限约束。

### 沙箱限制

界面运行在 `sandbox="allow-scripts"` 的 iframe 中，并带有 `default-src 'none'` 的 CSP：

- **不能发起任何网络请求**（fetch / XHR / 表单 / 子框架 / 外链脚本与样式都会被拦截），
  所有脚本、样式、图片请内联（图片用 `data:` URI）；
- 读不到站点 cookie / localStorage，也无法调用平台 API；
- 与平台的唯一通道是 `window.NOJ`（底层是 `postMessage`）。

## 选手侧体验

界面题有专用的做题工作区：草稿自动保存在浏览器本地；下方「运行历史」合并每轮自测与提交，
**每轮的整份参数都随记录保存在服务端**，可与当前参数逐行对比（JSON）、一键回滚——回滚后会通过
`NOJ.onSet` 通知界面刷新控件。
