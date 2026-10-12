//! WASM 运行、确定性计量和运行保护回归。
use super::*;
use std::collections::HashMap;

fn profile() -> OiCostProfile {
    OiCostProfile {
        schema_version: 1,
        runtime_version: "wasmtime-49".to_string(),
        costs: HashMap::from([(String::from("default"), 1)]),
        variable_costs: HashMap::new(),
        io_fuel_per_byte: 1,
        fuel_per_ms: 1000.0,
        hash: "a".repeat(64),
        toolchain: None,
        benchmark: None,
        hardware: None,
    }
}

#[tokio::test]
async fn reused_module_keeps_fuel_and_store_isolation() {
    let module = wat::parse_str(
        r#"(module
        (memory (export "memory") 1)
        (global $state (mut i32) (i32.const 0))
        (func (export "_start") (local $i i32)
          global.get $state if unreachable end
          i32.const 1 global.set $state
          i32.const 100000 local.set $i
          (loop $again local.get $i i32.const 1 i32.sub local.tee $i br_if $again)))"#,
    )
    .unwrap();
    let profile = profile();
    let baseline = run_module(&module, &[], 16, 10_000_000, &profile)
        .await
        .unwrap();
    let prepared = PreparedModule::new(&module, &profile).unwrap();
    for parallelism in [1, 2, 4, 8, 16] {
        let runs = join_all((0..parallelism).map(|_| {
            let prepared = prepared.clone();
            let module = module.clone();
            let profile = profile.clone();
            tokio::task::spawn_blocking(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                runtime
                    .block_on(run_prepared_module(
                        &module,
                        &[],
                        16,
                        10_000_000,
                        &profile,
                        &[],
                        None,
                        FsPerms::ReadOnly,
                        Some(10_000),
                        0,
                        None,
                        Some(&prepared),
                    ))
                    .unwrap()
            })
        }))
        .await;
        for run in runs {
            let run = run.unwrap();
            assert_eq!(run.status, WasmStatus::Accepted);
            assert_eq!(run.fuel_consumed, baseline.fuel_consumed);
            assert_eq!(run.stdout, baseline.stdout);
        }
    }
}

#[tokio::test]
async fn shared_engine_timeout_does_not_interrupt_another_store() {
    let profile = profile();
    let infinite = wat::parse_str("(module (func (export \"_start\") (loop br 0)))").unwrap();
    let finite = wat::parse_str("(module (func (export \"_start\") (local $i i32) i32.const 10000000 local.set $i (loop $l local.get $i i32.const 1 i32.sub local.tee $i br_if $l)))").unwrap();
    let first = PreparedModule::new(&infinite, &profile).unwrap();
    let second = first.checker(&finite).unwrap();
    let handles = join_all(
        [(first, infinite, 10), (second, finite, 10_000)]
            .into_iter()
            .map(|(prepared, module, deadline)| {
                let profile = profile.clone();
                tokio::task::spawn_blocking(move || {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap();
                    runtime
                        .block_on(run_prepared_module(
                            &module,
                            &[],
                            16,
                            u64::MAX,
                            &profile,
                            &[],
                            None,
                            FsPerms::ReadOnly,
                            Some(deadline),
                            0,
                            None,
                            Some(&prepared),
                        ))
                        .unwrap()
                })
            }),
    )
    .await;
    assert_eq!(handles[0].as_ref().unwrap().status, WasmStatus::SystemError);
    assert_eq!(handles[1].as_ref().unwrap().status, WasmStatus::Accepted);
}

#[tokio::test]
async fn bulk_memory_is_charged_by_bytes() {
    let wat = br#"(module (memory 2) (func (export "_start") i32.const 0 i32.const 65536 i32.const 65536 memory.copy))"#;
    let small = run_module(wat, b"", 16, 100, &super::super::standard::profile())
        .await
        .unwrap();
    assert_eq!(small.status, WasmStatus::TimeLimitExceeded);
    let enough = run_module(wat, b"", 16, 100000, &super::super::standard::profile())
        .await
        .unwrap();
    assert_eq!(enough.status, WasmStatus::Accepted);
    assert!(enough.fuel_consumed.unwrap() >= 65536);
}

#[tokio::test]
async fn host_sleep_is_protection_error_not_algorithm_tle() {
    let wat = br#"(module
      (import "wasi_snapshot_preview1" "poll_oneoff" (func $poll (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (func (export "_start")
        i32.const 16 i32.const 1 i32.store
        i32.const 24 i64.const 60000000000 i64.store
        i32.const 0 i32.const 64 i32.const 1 i32.const 96 call $poll drop))"#;
    let result = run_module_with_files(
        wat,
        b"",
        16,
        1_000_000_000,
        &super::super::standard::profile(),
        &[],
        None,
        FsPerms::ReadOnly,
        Some(20),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.status, WasmStatus::SystemError);
    assert!(result.wall_time_ms < 1000);
    assert!(result.fuel_consumed.unwrap() < 1_000_000_000);
}

#[tokio::test]
async fn guest_random_sequence_is_fixed_across_stores() {
    let wat = br#"(module
      (import "wasi_snapshot_preview1" "random_get" (func $random (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (func (export "_start")
        i32.const 16 i32.const 32 call $random drop
        i32.const 0 i32.const 16 i32.store
        i32.const 4 i32.const 32 i32.store
        i32.const 1 i32.const 0 i32.const 1 i32.const 64 call $write drop))"#;
    let first = run_module(wat, b"", 16, 10000, &super::super::standard::profile())
        .await
        .unwrap();
    let second = run_module(wat, b"", 16, 10000, &super::super::standard::profile())
        .await
        .unwrap();
    assert_eq!(first.status, WasmStatus::Accepted);
    assert_eq!(first.stdout, second.stdout);
    assert_eq!(first.fuel_consumed, second.fuel_consumed);
    assert_eq!(
        first.stdout,
        vec![
            223, 240, 207, 251, 246, 131, 136, 169, 225, 22, 106, 21, 207, 96, 219, 18, 159, 81,
            22, 242, 243, 142, 103, 18, 209, 158, 120, 198, 63, 148, 234, 170
        ]
    );
}

#[tokio::test]
async fn provenance_ignores_site_ids_but_tracks_source_and_data() {
    let mut task: JudgeTask = serde_json::from_str(include_str!(
        "../../../noj-tests/fixtures/judge-task-oi.contract.json"
    ))
    .unwrap();
    let config = task.runtime_config.as_oi().unwrap().clone();
    let empty = HashMap::new();
    let cases = vec![("testdata/1.in".into(), b"1 2".to_vec(), b"3".to_vec())];
    let legacy = profile();
    let first = evaluate_wasm_with_progress(
        &task, &config, &cases, &legacy, None, &empty, &empty, &empty, None,
    )
    .await
    .unwrap();
    assert_eq!(first.details["oi"]["verdict"], "SE");
    assert_eq!(first.details["metering"]["comparable"], false);
    task.submission_id = "another-instance".into();
    task.problem_id = "other-problem-id".into();
    let same = evaluate_wasm_with_progress(
        &task, &config, &cases, &legacy, None, &empty, &empty, &empty, None,
    )
    .await
    .unwrap();
    assert_eq!(first.details["metering"], same.details["metering"]);
    task.code.push_str(" /* changed */");
    let source = evaluate_wasm_with_progress(
        &task, &config, &cases, &legacy, None, &empty, &empty, &empty, None,
    )
    .await
    .unwrap();
    assert_ne!(
        first.details["metering"]["source_hash"],
        source.details["metering"]["source_hash"]
    );
    let cases = vec![("testdata/1.in".into(), b"2 3".to_vec(), b"5".to_vec())];
    let data = evaluate_wasm_with_progress(
        &task, &config, &cases, &legacy, None, &empty, &empty, &empty, None,
    )
    .await
    .unwrap();
    assert_ne!(
        first.details["metering"]["evaluation_hash"],
        data.details["metering"]["evaluation_hash"]
    );
}

#[tokio::test]
async fn published_v1_task_is_rejected_with_rejudge_guidance() {
    let task: JudgeTask = serde_json::from_str(include_str!(
        "../../../noj-tests/fixtures/judge-task-oi.contract.json"
    ))
    .unwrap();
    let config = task.runtime_config.as_oi().unwrap();
    let v1: serde_json::Value = serde_json::from_str(include_str!("noj-wasm-v1.json")).unwrap();
    let mut old = super::super::standard::profile();
    old.hash = v1["hash"].as_str().unwrap().into();
    old.benchmark = Some("noj-wasm-v1".into());
    old.toolchain = Some("wasi-sdk-34".into());
    let empty = HashMap::new();
    let result =
        evaluate_wasm_with_progress(&task, config, &[], &old, None, &empty, &empty, &empty, None)
            .await
            .unwrap();
    assert_eq!(result.details["oi"]["verdict"], "SE");
    assert!(result.output.contains("重测"));
    assert_eq!(result.details["metering"]["comparable"], false);
}

#[tokio::test]
async fn fuel_exhaustion_is_tle() {
    let wat = r#"(module (func (export "_start") (loop br 0)))"#;
    let result = run_module(wat.as_bytes(), b"", 16, 100, &profile())
        .await
        .unwrap();
    assert_eq!(result.status, WasmStatus::TimeLimitExceeded);
    assert_eq!(result.fuel_consumed, Some(100));
}

#[tokio::test]
async fn wall_deadline_interrupts_guest() {
    let wat = r#"(module (func (export "_start") (loop br 0)))"#;
    let result = run_module_with_files(
        wat.as_bytes(),
        b"",
        16,
        u64::MAX / 4,
        &profile(),
        &[],
        None,
        FsPerms::ReadOnly,
        Some(20),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.status, WasmStatus::SystemError);
    assert!(result.wall_time_ms < 1_000);
}
#[tokio::test]
async fn instantiation_start_is_subject_to_wall_deadline() {
    let wat = r#"(module (func $init (loop br 0)) (start $init) (func (export "_start")))"#;
    let result = run_module_with_files(
        wat.as_bytes(),
        b"",
        16,
        u64::MAX / 4,
        &profile(),
        &[],
        None,
        FsPerms::ReadOnly,
        Some(20),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.status, WasmStatus::SystemError);
    assert!(result.wall_time_ms < 1000);
}

#[tokio::test]
async fn returning_guest_without_wall_deadline_is_accepted() {
    let result = run_module(
        b"(module (func (export \"_start\")))",
        b"",
        16,
        100,
        &profile(),
    )
    .await
    .unwrap();
    assert_eq!(result.status, WasmStatus::Accepted);
}
#[tokio::test]
async fn out_of_bounds_load_is_re_not_mle() {
    let result = run_module(
        br#"(module (memory 1) (func (export "_start") i32.const 65536 i32.load drop))"#,
        b"",
        16,
        100,
        &profile(),
    )
    .await
    .unwrap();
    assert_eq!(result.status, WasmStatus::RuntimeError);
}

#[tokio::test]
async fn memory_grow_beyond_limit_is_mle() {
    let result = run_module(
        br#"(module (memory 1) (func (export "_start") i32.const 1024 memory.grow drop))"#,
        b"",
        1,
        u64::MAX / 4,
        &profile(),
    )
    .await
    .unwrap();
    assert_eq!(result.status, WasmStatus::MemoryLimitExceeded);
}
#[tokio::test]
async fn wasi_stdout_limit_is_ole_even_when_guest_tries_to_exit_successfully() {
    let wat = br#"(module
        (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
        (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
        (memory (export "memory") 514)
        (func (export "_start")
            i32.const 0 i32.const 1024 i32.store
            i32.const 4 i32.const 33554433 i32.store
            i32.const 1 i32.const 0 i32.const 1 i32.const 8 call $write drop
            i32.const 0 call $exit))"#;
    let result = run_module(wat, b"", 64, 10000, &profile()).await.unwrap();
    assert_eq!(result.status, WasmStatus::OutputLimitExceeded);
}

#[test]
fn duplicate_header_alias_uses_fixed_lexicographic_order() {
    let files = HashMap::from([
        ("z/shared.h".to_string(), b"second".to_vec()),
        ("a/shared.h".to_string(), b"first".to_vec()),
    ]);
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    write_extra_files(first.path(), &files).unwrap();
    write_extra_files(second.path(), &files).unwrap();
    assert_eq!(
        std::fs::read(first.path().join("shared.h")).unwrap(),
        b"first"
    );
    assert_eq!(
        std::fs::read(first.path().join("shared.h")).unwrap(),
        std::fs::read(second.path().join("shared.h")).unwrap()
    );
}

#[tokio::test]
async fn self_test_cancel_interrupts_guest_without_algorithm_tle() {
    let module = wat::parse_str(
        "(module (memory (export \"memory\") 1) (func (export \"_start\") (loop br 0)))",
    )
    .unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let cancel_thread = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        flag.store(true, Ordering::Relaxed);
    });
    let started = Instant::now();
    let result = run_module_with_files(
        &module,
        &[],
        256,
        u64::MAX,
        &super::super::standard::profile(),
        &[],
        None,
        FsPerms::ReadOnly,
        Some(3000),
        Some(cancelled),
    )
    .await
    .unwrap();
    cancel_thread.join().unwrap();
    assert_eq!(result.status, WasmStatus::SystemError);
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
}
