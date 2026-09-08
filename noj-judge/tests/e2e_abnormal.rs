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

    let runtime_config = sdk_runtime(
        r#"python3 -c "import sys,json; sys.stdout.write('---RESULT---\n'); sys.stdout.write(json.dumps({'score':10000,'details':{}})); sys.stdout.flush()""#,
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
