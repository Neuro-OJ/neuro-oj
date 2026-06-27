//! 标准题原生执行器。
//!
//! 复刻 problem 1003 evaluate.py 的"内容分 8 + 格式分 2"评分算法：
//! - 解析支持包内的 `visible.jsonl` / `hidden.jsonl`
//! - 在 Docker 容器内逐 case 跑用户代码（`python3 /tmp/main.py < /tmp/case.in.N`）
//! - 比对实际 stdout 末行与 `expected`，计算内容通过率与整数格式命中率
//! - 总分 = 8.0 × total_passed/total_cases + 2.0（格式全中）
//! - 状态：`total_score == 10.0` → `"Accepted"`，否则 `"WrongAnswer"`
//!   （即使内容全对但格式扣分也是 WrongAnswer，对齐 evaluate.py:149）
//!
//! 通过 `pool::exec::execute_in_container` 复用沙箱隔离和 cgroup 资源限制。

use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;
use tracing::{info, warn};

use crate::pool::copy::copy_to_container;
use crate::pool::exec::{execute_in_container, read_memory_peak_kb};
use crate::pool::PoolManager;
use crate::types::JudgeTask;

// ── 评分常量（与 problem 1003 evaluate.py 完全对齐） ──

/// 内容分满分
const CONTENT_SCORE_FULL: f64 = 8.0;
/// 格式分满分
const FORMAT_SCORE_FULL: f64 = 2.0;
/// 总分满分
const FULL_SCORE: f64 = CONTENT_SCORE_FULL + FORMAT_SCORE_FULL;

// ── 数据结构 ──

/// 测试用例（解析自 JSONL）
#[derive(Debug, Clone)]
pub struct TestCase {
    pub id: String,
    pub input: String,
    /// expected 是 JSON number，转字符串并 strip 后再匹配
    pub expected: String,
}

/// 单 case 容器内运行结果
#[derive(Debug, Clone)]
pub struct RunnerOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
    pub time_ms: u64,
    pub memory_kb: u64,
}

/// 单 case 评分结果（details.cases[] 元素）
#[derive(Debug, Clone, Serialize)]
pub struct CaseResult {
    pub id: String,
    pub input: String,
    pub expected: String,
    pub actual: String,
    pub content_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
}

/// 一组用例的统计（visible 或 hidden）
#[derive(Debug, Clone, Serialize)]
pub struct SplitReport {
    pub passed: u32,
    pub total: u32,
    pub all_valid_int: bool,
    pub cases: Vec<CaseResult>,
}

/// 最终评分报告（details 整体）
#[derive(Debug, Clone, Serialize)]
pub struct ScoreReport {
    pub visible: SplitReport,
    pub hidden: SplitReport,
    pub hidden_provided: bool,
}

// ── Pure 评分函数（无 I/O，100% 可单元测试） ──

/// 从 stdout 中提取"最后非空行"作为用户输出。
///
/// 对齐 Python 行为：`stdout.strip().splitlines()[-1]`，但额外过滤空行，
/// 保证 `print("debug") + print("42")` 的输出能被正确解析为 `"42"`。
fn extract_output_line(stdout: &str) -> String {
    stdout
        .lines()
        .rfind(|l| !l.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

/// 测试 output_line 是否能被解析为整数。
///
/// 对齐 Python `int(output_line)`：解析成功返回 true，否则 false。
fn is_valid_integer(s: &str) -> bool {
    !s.is_empty() && s.parse::<i64>().is_ok()
}

/// 纯评分函数：根据 RunnerOutput 列表和用例列表计算 SplitReport。
///
/// 输入 `outputs.len()` 必须等于 `cases.len()`，调用方负责保证。
/// `outputs[i]` 对应 `cases[i]` 的运行结果。
///
/// 返回 SplitReport（不是 ScoreReport）—— 编排器需要分别对 visible /
/// hidden 调用本函数得到两个 SplitReport，再由 `build_final_score_report` 合并。
pub fn score_cases(cases: &[TestCase], outputs: &[RunnerOutput]) -> SplitReport {
    debug_assert_eq!(cases.len(), outputs.len(), "cases 与 outputs 长度不一致");

    let mut passed: u32 = 0;
    let mut all_valid_int = true;
    let mut case_results: Vec<CaseResult> = Vec::with_capacity(cases.len());

    for (case, output) in cases.iter().zip(outputs.iter()) {
        let output_line = extract_output_line(&output.stdout);
        let expected = case.expected.trim().to_string();

        // 整数格式检查
        let valid_int = is_valid_integer(&output_line);
        if !valid_int {
            all_valid_int = false;
        }

        // 内容匹配
        let content_ok = output_line == expected;
        if content_ok {
            passed += 1;
        }

        let stderr = if output.stderr.is_empty() {
            None
        } else {
            Some(output.stderr.clone())
        };

        case_results.push(CaseResult {
            id: case.id.clone(),
            input: case.input.clone(),
            expected,
            actual: output_line,
            content_ok,
            stderr,
        });
    }

    SplitReport {
        passed,
        total: cases.len() as u32,
        all_valid_int,
        cases: case_results,
    }
}

/// 合并 visible / hidden 两个 SplitReport 为最终 ScoreReport，并计算总分。
///
/// 总分算法（对照 evaluate.py:134-149）：
/// - score_content = 8.0 × total_passed / total_cases（total_cases==0 时取 0）
/// - score_format = 2.0 if (visible.all_valid_int && hidden.all_valid_int) else 0
/// - total_score = score_content + score_format
/// - status = "Accepted" if total_score == 10.0 else "WrongAnswer"
/// - score = round(total_score * 100)（存为 i32）
pub fn build_final_score_report(
    visible: SplitReport,
    hidden: SplitReport,
    hidden_provided: bool,
) -> (ScoreReport, String, i32) {
    let total_passed = visible.passed + hidden.passed;
    let total_cases = visible.total + hidden.total;

    // 注意：total_cases == 0 时 score_content 视为 0（不应评满分）
    let score_content = if total_cases == 0 {
        0.0
    } else {
        CONTENT_SCORE_FULL * (total_passed as f64) / (total_cases as f64)
    };

    let format_ok = visible.all_valid_int && hidden.all_valid_int;
    let score_format = if format_ok { FORMAT_SCORE_FULL } else { 0.0 };

    let total_score = score_content + score_format;
    let status = if total_score == FULL_SCORE {
        "Accepted".to_string()
    } else {
        "WrongAnswer".to_string()
    };
    let score = (total_score * 100.0).round() as i32;

    let report = ScoreReport {
        visible,
        hidden,
        hidden_provided,
    };
    (report, status, score)
}

// ── JSONL 解析 ──

/// 解析 JSONL 文件为 TestCase 列表。
///
/// 每行格式：`{"id":"v001","input":"0 0\n","expected":0}`
/// 期望字段：id (string)、input (string)、expected (number/string)
pub fn parse_jsonl_cases(content: &str) -> Result<Vec<TestCase>> {
    let mut cases = Vec::new();
    for (line_num, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(line)
            .with_context(|| format!("JSONL 第 {} 行解析失败: {}", line_num + 1, line))?;

        let id = v
            .get("id")
            .and_then(|x| x.as_str())
            .ok_or_else(|| anyhow::anyhow!("JSONL 第 {} 行缺少 id 字段", line_num + 1))?
            .to_string();

        let input = v
            .get("input")
            .and_then(|x| x.as_str())
            .ok_or_else(|| anyhow::anyhow!("JSONL 第 {} 行缺少 input 字段", line_num + 1))?
            .to_string();

        // expected 可能是 JSON number 或 string，统一转为字符串
        let expected = match v.get("expected") {
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
            None => {
                return Err(anyhow::anyhow!(
                    "JSONL 第 {} 行缺少 expected 字段",
                    line_num + 1
                ))
            }
        };

        cases.push(TestCase {
            id,
            input,
            expected,
        });
    }
    Ok(cases)
}

// ── Orchestrator ──

/// 标准题评测 orchestrator。
///
/// 返回 `(stdout, stderr, exit_code, total_time_ms, max_memory_kb)`：
/// - stdout 包含人类可读日志 + `---RESULT---` + JSON，由 `runner::process_output` 解析
/// - exit_code 始终为 0（除非整个流程异常）
/// - total_time_ms = 所有 case time_ms 之和
/// - max_memory_kb = 所有 case memory_kb 的最大值
///
/// 错误情况：
/// - visible.jsonl 缺失或为空 → SystemError（题目配置错误，不评 0 分）
/// - 单 case TLE → 终止剩余 case，全局 status="TimeLimitExceeded"
/// - 单 case OOM → 该 case 标记 MLE 但**不**终止其他 case
pub async fn run_standard_evaluate(
    pool: &PoolManager,
    container_id: &str,
    work_dir: &Path,
    task: &JudgeTask,
) -> Result<(String, String, i64, u64, u64)> {
    let submission_id = &task.submission_id;

    // 1. 读取 visible.jsonl / hidden.jsonl
    let visible_path = work_dir.join("visible.jsonl");
    let hidden_path = work_dir.join("hidden.jsonl");

    let visible_content = tokio::fs::read_to_string(&visible_path).await.ok();
    let hidden_content = tokio::fs::read_to_string(&hidden_path).await.ok();

    let visible_cases = match visible_content {
        Some(content) => parse_jsonl_cases(&content)?,
        None => Vec::new(),
    };

    let hidden_cases = match hidden_content {
        Some(content) if !content.trim().is_empty() => parse_jsonl_cases(&content)?,
        _ => Vec::new(),
    };

    let hidden_provided = !hidden_cases.is_empty();

    // 2. 校验：visible 必须有至少一个 case
    if visible_cases.is_empty() {
        // empty visible → SystemError（题目配置错误，不评 0 分）
        return Ok((
            "---RESULT---\n".to_string()
                + &json!({
                    "status": "SystemError",
                    "score": 0,
                    "details": {
                        "error": "no test cases",
                        "message": "visible.jsonl 为空或缺失，请检查题目配置"
                    }
                })
                .to_string()
                + "\n",
            String::new(),
            0,
            0,
            0,
        ));
    }

    let docker = pool.docker();
    let kill_grace = pool.config().kill_grace_secs;

    // 3. 执行 visible cases
    let visible_outputs = run_cases(
        docker,
        container_id,
        work_dir,
        &visible_cases,
        task.time_limit_ms,
        kill_grace,
        "VISIBLE",
        submission_id,
    )
    .await?;

    // 4. 如果 visible 任一 case TLE，终止剩余 hidden（与 evaluate.py 行为一致）
    let visible_has_tle = visible_outputs.iter().any(|o| o.exit_code == -1);
    let hidden_outputs = if visible_has_tle || hidden_cases.is_empty() {
        // 不继续跑 hidden：要么已经 TLE，要么没有 hidden 数据
        Vec::new()
    } else {
        run_cases(
            docker,
            container_id,
            work_dir,
            &hidden_cases,
            task.time_limit_ms,
            kill_grace,
            "HIDDEN",
            submission_id,
        )
        .await?
    };

    // 5. 聚合评分（调用纯函数）
    let visible_report = score_cases(&visible_cases, &visible_outputs);
    let hidden_report = if hidden_cases.is_empty() {
        SplitReport {
            passed: 0,
            total: 0,
            all_valid_int: true,
            cases: vec![],
        }
    } else {
        score_cases(&hidden_cases, &hidden_outputs)
    };

    let (report, status, score) = build_final_score_report(
        visible_report.clone(),
        hidden_report.clone(),
        hidden_provided,
    );

    // 6. 累计 time_ms 和 max memory_kb
    let total_time_ms: u64 = visible_outputs
        .iter()
        .chain(hidden_outputs.iter())
        .map(|o| o.time_ms)
        .sum();
    let max_memory_kb: u64 = visible_outputs
        .iter()
        .chain(hidden_outputs.iter())
        .map(|o| o.memory_kb)
        .max()
        .unwrap_or(0);

    // 7. 拼装人类可读日志（对照 evaluate.py:138-143）
    let mut stdout = String::new();
    stdout.push_str("================================================\n");
    stdout.push_str(&format!("T0-LMCC 标准评测开始: {}\n", submission_id));
    stdout.push_str("================================================\n");

    for (i, (_case, output)) in visible_cases.iter().zip(visible_outputs.iter()).enumerate() {
        let pass_label = if output.exit_code == -1 {
            "TLE"
        } else if output.exit_code == 137 {
            "OOM"
        } else {
            "PASS/FAIL"
        };
        let actual_line = extract_output_line(&output.stdout);
        stdout.push_str(&format!(
            "[VISIBLE] {}: {} (input: {:?}, expected: {}, actual: {})\n",
            visible_report.cases[i].id,
            pass_label,
            visible_report.cases[i].input,
            visible_report.cases[i].expected,
            actual_line
        ));
    }

    if hidden_provided {
        stdout.push('\n');
        for (i, (_case, output)) in hidden_cases.iter().zip(hidden_outputs.iter()).enumerate() {
            let pass_label = if output.exit_code == -1 {
                "TLE"
            } else if output.exit_code == 137 {
                "OOM"
            } else {
                "PASS/FAIL"
            };
            let actual_line = extract_output_line(&output.stdout);
            stdout.push_str(&format!(
                "[HIDDEN] {}: {} (expected: {}, actual: {})\n",
                hidden_report.cases[i].id, pass_label, hidden_report.cases[i].expected, actual_line
            ));
        }
    } else {
        stdout.push_str("\n⚠️ 隐藏数据未提供\n");
    }

    let total_passed = report.visible.passed + report.hidden.passed;
    let total_cases = report.visible.total + report.hidden.total;
    let score_content = if total_cases == 0 {
        0.0
    } else {
        CONTENT_SCORE_FULL * (total_passed as f64) / (total_cases as f64)
    };
    let format_ok = report.visible.all_valid_int && report.hidden.all_valid_int;
    let score_format = if format_ok { FORMAT_SCORE_FULL } else { 0.0 };

    stdout.push_str("\n------------------------------------------------\n");
    stdout.push_str(&format!(
        "可见: {}/{}\n",
        report.visible.passed, report.visible.total
    ));
    stdout.push_str(&format!(
        "隐藏: {}/{}\n",
        report.hidden.passed, report.hidden.total
    ));
    stdout.push_str(&format!(
        "总计: {}/{} -> {:.2}/{}\n",
        total_passed, total_cases, score_content, CONTENT_SCORE_FULL
    ));
    stdout.push_str(&format!(
        "格式: {} -> {:.2}/{}\n",
        if format_ok { "✅" } else { "❌" },
        score_format,
        FORMAT_SCORE_FULL
    ));
    stdout.push_str(&format!(
        "总分: {:.2}/{}\n",
        score_content + score_format,
        FULL_SCORE
    ));

    if !hidden_provided {
        stdout.push_str("说明: 当前分数仅基于公开数据\n");
    }

    // 8. 构造 details JSON（嵌套 ScoreReport 但加上 score_content / score_format 字段）
    let details = json!({
        "score_content": round2(score_content),
        "score_format": round2(score_format),
        "visible": report.visible,
        "hidden": report.hidden,
        "hidden_provided": report.hidden_provided,
    });

    let result = json!({
        "status": status,
        "score": score,
        "details": details,
    });

    stdout.push_str("---RESULT---\n");
    stdout.push_str(&result.to_string());
    stdout.push('\n');

    info!(
        "标准评测完成: {} -> {} (score: {})",
        submission_id, status, score
    );

    Ok((stdout, String::new(), 0, total_time_ms, max_memory_kb))
}

/// 在容器内执行一组 case，返回对应的 RunnerOutput 列表。
///
/// 每个 case：
/// 1. 将 `case.input` 写入 `work_dir/case.in.N`（N 为索引，纯数字防路径穿越）
/// 2. docker exec `sh -c "python3 /tmp/main.py < /tmp/case.in.N"`
/// 3. 读 cgroup 内存峰值
/// 4. 若某 case TLE（exit_code=-1）→ 后续 case 标记为 TLE，不再执行
///
/// 返回的 `stdout` 字段保留每次 exec 的完整输出（用于日志）；输出行提取由 `score_cases` 完成。
/// 跑一组测试用例（visible 或 hidden）。
///
/// `work_dir` 与 `cases` 共同决定 case.in.N 的位置与内容。
/// 拆成 struct 会损失可读性，allow clippy::too_many_arguments。
#[allow(clippy::too_many_arguments)]
async fn run_cases(
    docker: &bollard::Docker,
    container_id: &str,
    work_dir: &Path,
    cases: &[TestCase],
    timeout_ms: u64,
    kill_grace: u64,
    split_name: &str,
    submission_id: &str,
) -> Result<Vec<RunnerOutput>> {
    let mut outputs = Vec::with_capacity(cases.len());

    for (idx, case) in cases.iter().enumerate() {
        // 单 case 文件名用索引（纯数字），不用 case.id，防 author-controlled 路径穿越
        let case_input_filename = format!("case.in.{}", idx);
        let case_input_path = work_dir.join(&case_input_filename);

        // 把 case.input 写到 work_dir/case.in.N
        tokio::fs::write(&case_input_path, &case.input)
            .await
            .with_context(|| format!("{} case {} 写输入文件失败", split_name, case.id))?;

        // 同步注入到容器 /tmp/（容器是预热的，宿主机 work_dir 与容器 /tmp
        // 并不共享；prepare 阶段的 archive_and_copy 只覆盖准备时的快照，
        // 后续动态写入的 case.in.N 必须再单独 tar 注入一次）
        let tar_bytes = {
            let mut buf = Vec::new();
            {
                let mut builder = tar::Builder::new(&mut buf);
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Regular);
                header.set_size(case.input.len() as u64);
                header.set_mode(0o644);
                header.set_uid(0);
                header.set_gid(0);
                header.set_mtime(0);
                header.set_cksum();
                builder
                    .append_data(&mut header, &case_input_filename, case.input.as_bytes())
                    .context("tar 打包 case.in 失败")?;
                builder.finish().context("tar finish 失败")?;
            }
            buf
        };
        copy_to_container(docker, container_id, tar_bytes)
            .await
            .with_context(|| format!("{} case {} 注入到容器失败", split_name, case.id))?;

        // 执行命令：sh -c "python3 /tmp/main.py < /tmp/case.in.N"
        // bollard exec 不支持 stdin pipe，shell 重定向等价
        let cmd = vec![
            "sh".to_string(),
            "-c".to_string(),
            format!("python3 /tmp/main.py < /tmp/{}", case_input_filename),
        ];

        let (stdout, stderr, exit_code, time_ms) =
            execute_in_container(docker, container_id, &cmd, timeout_ms, kill_grace)
                .await
                .with_context(|| format!("{} case {} exec 失败", split_name, case.id))?;

        let memory_kb = read_memory_peak_kb(docker, container_id).await.unwrap_or(0);

        if exit_code == -1 {
            warn!(
                "{} case {} TLE ({}ms) — 后续 case 终止",
                split_name, case.id, time_ms
            );
            outputs.push(RunnerOutput {
                stdout,
                stderr,
                exit_code: -1,
                time_ms,
                memory_kb,
            });
            // TLE 即全局终止：剩余 case 标记为 TLE
            for remaining in cases.iter().skip(idx + 1) {
                let _ = remaining; // 仅占位
                outputs.push(RunnerOutput {
                    stdout: String::new(),
                    stderr: "TLE: skipped (earlier case timed out)".to_string(),
                    exit_code: -1,
                    time_ms: 0,
                    memory_kb: 0,
                });
            }
            return Ok(outputs);
        }

        if exit_code == 137 {
            warn!("{} case {} OOM ({}kb)", split_name, case.id, memory_kb);
            // OOM 不中断其他 case，继续
        }

        outputs.push(RunnerOutput {
            stdout,
            stderr,
            exit_code,
            time_ms,
            memory_kb,
        });
    }

    info!(
        "{}: {} cases executed for submission {}",
        split_name,
        outputs.len(),
        submission_id
    );

    Ok(outputs)
}

/// 保留两位小数（对齐 evaluate.py 的 round(..., 2)）
fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

// ── 单元测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    // ── extract_output_line ──

    #[test]
    fn test_extract_output_line_simple() {
        assert_eq!(extract_output_line("42\n"), "42");
        assert_eq!(extract_output_line("42"), "42");
    }

    #[test]
    fn test_extract_output_line_with_debug() {
        // 用户代码 print("debug") + print(42) → 应取 "42"
        assert_eq!(extract_output_line("debug\n42\n"), "42");
        assert_eq!(extract_output_line("debug\n\n42\n"), "42");
    }

    #[test]
    fn test_extract_output_line_empty() {
        assert_eq!(extract_output_line(""), "");
        assert_eq!(extract_output_line("\n\n\n"), "");
    }

    // ── is_valid_integer ──

    #[test]
    fn test_is_valid_integer() {
        assert!(is_valid_integer("42"));
        assert!(is_valid_integer("-100"));
        assert!(is_valid_integer("0"));
        assert!(!is_valid_integer("3.0")); // Python int("3.0") 也失败
        assert!(!is_valid_integer(""));
        assert!(!is_valid_integer("abc"));
        assert!(!is_valid_integer("42 ")); // trailing space
    }

    // ── parse_jsonl_cases ──

    #[test]
    fn test_parse_jsonl_cases_standard() {
        let content = r#"{"id":"v001","input":"0 0\n","expected":0}
{"id":"v002","input":"1 2\n","expected":3}
"#;
        let cases = parse_jsonl_cases(content).unwrap();
        assert_eq!(cases.len(), 2);
        assert_eq!(cases[0].id, "v001");
        assert_eq!(cases[0].input, "0 0\n");
        assert_eq!(cases[0].expected, "0");
        assert_eq!(cases[1].expected, "3");
    }

    #[test]
    fn test_parse_jsonl_cases_with_blank_lines() {
        let content = r#"{"id":"v001","input":"0 0\n","expected":0}

{"id":"v002","input":"1 2\n","expected":3}
"#;
        let cases = parse_jsonl_cases(content).unwrap();
        assert_eq!(cases.len(), 2);
    }

    #[test]
    fn test_parse_jsonl_cases_string_expected() {
        // expected 也可以是字符串（用于非数值场景）
        let content = r#"{"id":"v001","input":"foo\n","expected":"bar"}"#;
        let cases = parse_jsonl_cases(content).unwrap();
        assert_eq!(cases[0].expected, "bar");
    }

    #[test]
    fn test_parse_jsonl_cases_missing_field() {
        let content = r#"{"id":"v001","input":"0 0\n"}"#;
        let result = parse_jsonl_cases(content);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_jsonl_cases_invalid_json() {
        let content = r#"not json"#;
        let result = parse_jsonl_cases(content);
        assert!(result.is_err());
    }

    // ── build_final_score_report ──

    fn make_split(passed: u32, total: u32, all_valid: bool) -> SplitReport {
        SplitReport {
            passed,
            total,
            all_valid_int: all_valid,
            cases: vec![],
        }
    }

    #[test]
    fn test_build_full_score() {
        let visible = make_split(10, 10, true);
        let hidden = make_split(10, 10, true);
        let (report, status, score) = build_final_score_report(visible, hidden, true);
        assert_eq!(status, "Accepted");
        assert_eq!(score, 1000);
        assert!(report.hidden_provided);
    }

    #[test]
    fn test_build_partial_pass_wrong_answer() {
        // 内容部分对 + 格式全对：8 + 2 = 10 不可能；这里模拟 8 个对 + 2 个错
        let visible = make_split(8, 10, true);
        let hidden = make_split(0, 0, true);
        let (_, status, score) = build_final_score_report(visible, hidden, true);
        // score_content = 8.0 * 8 / 10 = 6.4, format = 2.0 → total = 8.4
        assert_eq!(status, "WrongAnswer"); // 8.4 != 10.0
        assert_eq!(score, 840);
    }

    #[test]
    fn test_build_content_perfect_format_fail() {
        // 内容全对但格式有错：8 + 0 = 8 → WrongAnswer
        let visible = make_split(10, 10, false);
        let hidden = make_split(0, 0, true);
        let (_, status, score) = build_final_score_report(visible, hidden, true);
        assert_eq!(status, "WrongAnswer");
        assert_eq!(score, 800);
    }

    #[test]
    fn test_build_zero_score() {
        let visible = make_split(0, 10, false);
        let hidden = make_split(0, 0, true);
        let (_, status, score) = build_final_score_report(visible, hidden, true);
        assert_eq!(status, "WrongAnswer");
        assert_eq!(score, 0);
    }

    #[test]
    fn test_build_no_hidden() {
        // hidden_provided=false, hidden 数据为空但不算"提供"
        let visible = make_split(10, 10, true);
        let hidden = make_split(0, 0, true);
        let (report, status, score) = build_final_score_report(visible, hidden, false);
        // score_content = 8.0 * 10/10 = 8.0, format = 2.0 → total = 10.0 → Accepted
        assert_eq!(status, "Accepted");
        assert_eq!(score, 1000);
        assert!(!report.hidden_provided);
    }

    // ── score_cases（核心评分函数） ──

    #[test]
    fn test_score_cases_all_pass() {
        let cases = vec![
            TestCase {
                id: "v001".into(),
                input: "1 2\n".into(),
                expected: "3".into(),
            },
            TestCase {
                id: "v002".into(),
                input: "0 0\n".into(),
                expected: "0".into(),
            },
        ];
        let outputs = vec![
            RunnerOutput {
                stdout: "3\n".into(),
                stderr: "".into(),
                exit_code: 0,
                time_ms: 10,
                memory_kb: 1024,
            },
            RunnerOutput {
                stdout: "0\n".into(),
                stderr: "".into(),
                exit_code: 0,
                time_ms: 5,
                memory_kb: 1024,
            },
        ];
        let report = score_cases(&cases, &outputs);
        assert_eq!(report.passed, 2);
        assert_eq!(report.total, 2);
        assert!(report.all_valid_int);
    }

    #[test]
    fn test_score_cases_with_debug_output() {
        // 用户代码：print("debug") + print(42) → 应正确解析 actual="42"
        let cases = vec![TestCase {
            id: "v001".into(),
            input: "1 2\n".into(),
            expected: "3".into(),
        }];
        let outputs = vec![RunnerOutput {
            stdout: "debug\n42\n".into(),
            stderr: "".into(),
            exit_code: 0,
            time_ms: 10,
            memory_kb: 1024,
        }];
        let report = score_cases(&cases, &outputs);
        assert_eq!(report.cases[0].actual, "42");
        assert!(!report.cases[0].content_ok); // 42 != 3
        assert!(report.all_valid_int); // 42 是整数
    }

    #[test]
    fn test_score_cases_format_fail_with_print_string() {
        // 用户代码 print("3.0") → 期望 3，actual="3.0"，int("3.0") 失败
        let cases = vec![TestCase {
            id: "v001".into(),
            input: "1 2\n".into(),
            expected: "3".into(),
        }];
        let outputs = vec![RunnerOutput {
            stdout: "3.0\n".into(),
            stderr: "".into(),
            exit_code: 0,
            time_ms: 10,
            memory_kb: 1024,
        }];
        let report = score_cases(&cases, &outputs);
        assert!(!report.all_valid_int);
        assert!(!report.cases[0].content_ok);
    }

    #[test]
    fn test_score_cases_empty_stdout() {
        // 用户代码 raise → stdout 空 → content_ok=false, all_valid_int=false
        let cases = vec![TestCase {
            id: "v001".into(),
            input: "1 2\n".into(),
            expected: "3".into(),
        }];
        let outputs = vec![RunnerOutput {
            stdout: "".into(),
            stderr: "Traceback...".into(),
            exit_code: 1,
            time_ms: 10,
            memory_kb: 1024,
        }];
        let report = score_cases(&cases, &outputs);
        assert_eq!(report.cases[0].actual, "");
        assert!(!report.cases[0].content_ok);
        assert!(!report.all_valid_int);
        assert_eq!(report.cases[0].stderr.as_deref(), Some("Traceback..."));
    }
}
