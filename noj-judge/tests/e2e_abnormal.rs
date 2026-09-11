//! 双容器异常场景 E2E：评测器崩溃、无结果、双容器失败、支持包缺失。
mod common;

use std::time::Duration;

use common::{get_docker, is_e2e_enabled};
use noj_judge::types::{EvaluatorRuntime, RuntimeConfig, SolutionRuntime};

fn sdk_runtime(evaluator_cmd: &str, time_limit_ms: u64) -> RuntimeConfig {
    RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            call_timeout_ms: 5000,
            memory_limit_mb: 128,
        },
    }
}

/// 评测器崩溃（非零退出且无 ---RESULT---）→ SystemError。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn evaluator_crash_no_result_returns_system_error() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    let runtime_config = sdk_runtime(
        r#"python3 -c "import sys; sys.stderr.write('boom\n'); sys.exit(1)""#,
        15000,
    );

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker,
            "e2e-evaluator-crash",
            &runtime_config,
            "def solve(): return 1",
            None,
            None,
            None,
            None,
            1000,
            true,
            "bridge",
            "noj-",
            &["python3".to_string()],
            300_000,
            60_000,
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(
        result.status, "error",
        "评测器崩溃应归 SystemError: {:?}",
        result
    );
}

/// 评测器正常退出但无 ---RESULT--- → SystemError。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn evaluator_no_result_exit0_returns_system_error() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    let runtime_config = sdk_runtime(r#"python3 -c "print('done')""#, 15000);

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker,
            "e2e-evaluator-no-result",
            &runtime_config,
            "def solve(): return 1",
            None,
            None,
            None,
            None,
            1000,
            true,
            "bridge",
            "noj-",
            &["python3".to_string()],
            300_000,
            60_000,
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(
        result.status, "error",
        "无 RESULT 应归 SystemError: {:?}",
        result
    );
}

/// 双容器创建失败（镜像不存在）→ evaluate_dual 返回 Err。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_container_failure_returns_err() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");

    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-missing-image:latest".to_string(),
            command: "python3 x".to_string(),
            time_limit_ms: 5000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-missing-image:latest".to_string(),
            call_timeout_ms: 1000,
            memory_limit_mb: 128,
        },
    };

    let result = noj_judge::dual::evaluate_dual_with_cpu_limit(
        docker,
        "e2e-dual-failure",
        &runtime_config,
        "",
        None,
        None,
        None,
        None,
        1000,
        true,
        "bridge",
        "noj-",
        &["python3".to_string()],
        300_000,
        60_000,
    )
    .await;

    assert!(result.is_err(), "镜像不存在应导致 Err: {:?}", result);
}

/// 支持包缺失时，不依赖支持包的评测仍可 finished。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn support_package_missing_still_finished() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // 注意：judge 的 parse_command 会消费反斜杠转义（含单引号内），
    // 这里用 chr(10) 输出换行，避免 `\n` 被吞掉导致 RESULT 标记与 JSON 粘连。
    // JSON 行故意不写末尾换行，覆盖「RESULT 标记后 payload 行 EOF 残留」路径。
    let runtime_config = sdk_runtime(
        r#"python3 -c "import sys,json; sys.stdout.write('---RESULT---' + chr(10)); sys.stdout.write(json.dumps({'score':10000,'details':{}}))""#,
        15000,
    );

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker,
            "e2e-support-missing",
            &runtime_config,
            "def solve(): return 1",
            None,
            None,
            None,
            None,
            1000,
            true,
            "bridge",
            "noj-",
            &["python3".to_string()],
            300_000,
            60_000,
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(
        result.status, "finished",
        "无支持包也应 finished: {:?}",
        result
    );
    assert_eq!(result.score, 10000);
}

/// 回归（D0）：Solution 先于 Evaluator 结束，不得丢失 Evaluator 的 RESULT payload。
///
/// 背景：此前编排循环在 Solution 输出流结束（EOF）时直接 break，抛弃 Evaluator
/// 仍在途的输出。典型受害场景是 evaluate.py 先写 `---RESULT---`，payload 行要等
/// 进程退出时才 flush —— payload 丢失后合法结果被误判为 SystemError（提交丢分）。
///
/// 本用例把该竞态**确定化**：Solution 立即结束（evaluator 从不调用它），
/// Evaluator 写完标记后 sleep 一段时间再写 payload，确保 Solution EOF 先被观察到。
///
/// 修复前：status=error（output 仅含 `---RESULT---`）。
/// 修复后：status=finished 且 score=10000。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn result_payload_survives_solution_eof() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // 先写 RESULT 标记并 flush，随后 sleep 1s（给 Solution EOF 充分的抢先窗口），
    // 最后写 payload 并 flush 后退出。
    let runtime_config = sdk_runtime(
        r#"python3 -c "import sys,time,json; sys.stdout.write('---RESULT---' + chr(10)); sys.stdout.flush(); time.sleep(1); sys.stdout.write(json.dumps({'score':10000,'details':{}})); sys.stdout.flush()""#,
        15000,
    );

    let result = tokio::time::timeout(
        Duration::from_secs(40),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker,
            "e2e-solution-eof-first",
            &runtime_config,
            // Solution 立即返回：其输出流会先于 Evaluator 结束。
            "def solve(): return 1",
            None,
            None,
            None,
            None,
            1000,
            true,
            "bridge",
            "noj-",
            &["python3".to_string()],
            300_000,
            60_000,
        ),
    )
    .await
    .expect("评测 40s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(
        result.status, "finished",
        "Solution 先结束不应丢失 Evaluator 的 RESULT payload: {:?}",
        result
    );
    assert_eq!(result.score, 10000);
}

/// 回归（评审）：评测器**不带 RESULT 标记**结束时必须立即收尾，不得空等到总超时。
///
/// 背景：阶段 2 的退出条件曾是 `evaluator_done && solution_done`，但 `solution_done`
/// 在生产中不可达——Solution 是常驻 host 进程，只在收到 shutdown 帧或 stdin EOF 时
/// 退出，而编排循环全程持有 `sol_input` 既不关闭也不发 shutdown。因此当评测器崩溃 /
/// `sys.exit(1)` 时，循环会一直空转到 `evaluator_time_limit_ms` 才由 deadline 收尾，
/// 白占评测槽位并拉长失败延迟（阶段 2 重构前是「Evaluator EOF 即 break」）。
///
/// 本用例把 `time_limit_ms` 设为 20s，并断言**实际耗时应显著小于它**：
/// - 修复前：耗时 ≈ 20s（等到 deadline 才返回），断言失败；
/// - 修复后：耗时 ≈ 容器启动时间（数秒内），断言通过。
/// 同时断言最终状态仍为 error（快速失败不改变判定结果）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn evaluator_eof_without_result_fails_fast() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // 评测器立刻以非零码退出，从不输出 ---RESULT---。
    const TIME_LIMIT_MS: u64 = 20_000;
    let runtime_config = sdk_runtime(
        r#"python3 -c "import sys; sys.stderr.write('no result\n'); sys.exit(1)""#,
        TIME_LIMIT_MS,
    );

    let started = std::time::Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(60),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker,
            "e2e-evaluator-eof-fastfail",
            &runtime_config,
            "def solve(): return 1",
            None,
            None,
            None,
            None,
            1000,
            true,
            "bridge",
            "noj-",
            &["python3".to_string()],
            300_000,
            60_000,
        ),
    )
    .await
    .expect("评测 60s 外层超时")
    .expect("评测应正常返回");
    let elapsed = started.elapsed();

    assert_eq!(
        result.status, "error",
        "评测器无 RESULT 应归 SystemError: {:?}",
        result
    );
    // 留足容器启动余量（实测数秒），但必须明显小于 time_limit_ms——
    // 若退化为「等到 deadline」，耗时会逼近 20s 而使本断言失败。
    assert!(
        elapsed < Duration::from_millis(TIME_LIMIT_MS * 3 / 4),
        "评测器 EOF 后应立即收尾，实际耗时 {:?}（time_limit_ms={}ms）——\
         疑似退化为空等到总超时",
        elapsed,
        TIME_LIMIT_MS
    );
}
