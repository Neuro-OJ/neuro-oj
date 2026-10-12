//! go-judge 原生执行路径：编译、子任务依赖与测试点结果归档。
use super::*;

pub(super) async fn evaluate_native_go_judge(
    client: &crate::oi::go_judge::GoJudgeClient,
    task: &JudgeTask,
    config: &OiRuntimeConfig,
    files: &HashMap<String, Vec<u8>>,
    lease_config: Option<&crate::oi::resource_lease::ResourceLeaseConfig>,
    progress: &crate::oi::progress::ProgressReporter,
) -> Result<JudgeResult> {
    let started = Instant::now();
    let user_compile_files = selected_user_compile_files(config, files);
    let mut cache_files = crate::oi::go_judge::CachedFiles::new(client);
    let user_runtime_files = selected_user_runtime_files(config, files);
    let checker_compile_files = selected_checker_compile_files(config, files);
    let compile_response = client
        .run(crate::oi::go_judge::command_for_compile(
            &task.language,
            &task.code,
            &user_compile_files,
        )?)
        .await?;
    let Some(executable_file_id) = crate::oi::go_judge::cached_file_id(&compile_response, "main")
    else {
        if compile_response_is_infrastructure_error(&compile_response) {
            return Ok(system_error_result(task, "go-judge 编译沙箱失败"));
        }
        let mut result = uniform_oi_status_result(task, config, OiStatus::CompileError)?;
        let diagnostics = compile_response
            .files
            .get("stderr")
            .map(|file| file.content())
            .unwrap_or_default();
        result.details["oi"]["compile_error"] =
            serde_json::json!(limited_output(diagnostics.as_bytes()).0);
        return Ok(result);
    };
    cache_files.track(executable_file_id);
    let checker_source = if config.checker.kind == OiCheckerType::Testlib {
        Some(
            files
                .get(config.checker.path.as_deref().unwrap_or_default())
                .context("go-judge testlib checker 文件索引丢失")?,
        )
    } else {
        None
    };
    let checker_file_id: Option<String> = if let Some(source) = checker_source {
        let checker_response = client
            .run(crate::oi::go_judge::command_for_checker_compile(
                source,
                &checker_compile_files,
            ))
            .await?;
        Some(
            crate::oi::go_judge::cached_file_id(&checker_response, "checker")
                .map(str::to_owned)
                .ok_or_else(|| anyhow::anyhow!("go-judge testlib checker 编译失败"))?,
        )
    } else {
        None
    };
    if let Some(id) = &checker_file_id {
        cache_files.track(id);
    }
    let mut case_results = Vec::new();
    let mut pending: HashSet<usize> = (0..config.subtasks.len()).collect();
    let mut passed = HashSet::new();
    let mut failed = HashSet::new();
    while !pending.is_empty() {
        let mut runnable = Vec::new();
        let mut skipped = Vec::new();
        for &index in &pending {
            let subtask = &config.subtasks[index];
            if subtask
                .depends_on
                .iter()
                .any(|dependency| failed.contains(dependency.as_str()))
            {
                skipped.push(index);
            } else if subtask
                .depends_on
                .iter()
                .all(|dependency| passed.contains(dependency.as_str()))
            {
                runnable.push(index);
            }
        }
        for index in skipped {
            pending.remove(&index);
            failed.insert(config.subtasks[index].id.as_str());
        }
        if runnable.is_empty() {
            if pending.is_empty() {
                break;
            }
            return Err(anyhow::anyhow!("OI 子任务依赖无法调度"));
        }
        runnable.sort_unstable();
        let batch = runnable.into_iter().take(2).collect::<Vec<_>>();
        for index in &batch {
            pending.remove(index);
        }
        let runs = join_all(batch.iter().map(|&index| {
            run_go_judge_subtask(
                client,
                config,
                index,
                executable_file_id,
                checker_file_id.as_deref(),
                files,
                &user_runtime_files,
                &checker_compile_files,
                lease_config,
                &task.submission_id,
                progress,
            )
        }))
        .await;
        for (index, run) in batch.into_iter().zip(runs) {
            let (subtask_passed, results) = run?;
            case_results.extend(results);
            if subtask_passed {
                passed.insert(config.subtasks[index].id.as_str());
            } else {
                failed.insert(config.subtasks[index].id.as_str());
            }
        }
    }
    let evaluation = score_submission(config, &case_results)
        .map_err(|error| anyhow::anyhow!("OI 结果计分失败: {error}"))?;
    Ok(evaluation.to_judge_result(
        &task.submission_id,
        task.rejudge_seq,
        Some(started.elapsed().as_millis() as u64),
        case_results.iter().filter_map(|case| case.memory_kb).max(),
    ))
}

#[allow(clippy::too_many_arguments)]
async fn run_go_judge_subtask(
    client: &crate::oi::go_judge::GoJudgeClient,
    config: &OiRuntimeConfig,
    subtask_index: usize,
    executable_file_id: &str,
    checker_file_id: Option<&str>,
    files: &HashMap<String, Vec<u8>>,
    user_runtime_files: &HashMap<String, Vec<u8>>,
    checker_extra_files: &HashMap<String, Vec<u8>>,
    lease_config: Option<&crate::oi::resource_lease::ResourceLeaseConfig>,
    owner: &str,
    progress: &crate::oi::progress::ProgressReporter,
) -> Result<(bool, Vec<OiCaseResult>)> {
    let lease = match lease_config {
        Some(config) => {
            Some(crate::oi::resource_lease::ResourceLease::acquire(config, owner).await?)
        }
        None => None,
    };
    let result = run_go_judge_subtask_inner(
        client,
        config,
        subtask_index,
        executable_file_id,
        checker_file_id,
        files,
        user_runtime_files,
        checker_extra_files,
        progress,
    )
    .await;
    if let Some(lease) = lease {
        lease.release().await;
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_go_judge_subtask_inner(
    client: &crate::oi::go_judge::GoJudgeClient,
    config: &OiRuntimeConfig,
    subtask_index: usize,
    executable_file_id: &str,
    checker_file_id: Option<&str>,
    files: &HashMap<String, Vec<u8>>,
    user_runtime_files: &HashMap<String, Vec<u8>>,
    checker_extra_files: &HashMap<String, Vec<u8>>,
    progress: &crate::oi::progress::ProgressReporter,
) -> Result<(bool, Vec<OiCaseResult>)> {
    let subtask = &config.subtasks[subtask_index];
    let mut passed = true;
    let mut results = Vec::with_capacity(subtask.cases.len());
    let maximums = subtask.case_max_scores();
    for (case_index, case) in subtask.cases.iter().enumerate() {
        let case_id = case
            .id
            .clone()
            .unwrap_or_else(|| format!("{}_{}", subtask.id, case_index + 1));
        if progress.is_cancelled() {
            results.push(crate::oi::cancelled_case(case));
            progress
                .finish_case(
                    &subtask.id,
                    &case_id,
                    results.last().unwrap(),
                    maximums[case_index],
                )
                .await;
            passed = false;
            continue;
        }
        progress.start_case(&subtask.id, &case_id).await;
        let time_limit_ms = case
            .time_limit_ms
            .or(subtask.time_limit_ms)
            .unwrap_or(config.time_limit_ms)
            .max(1);
        let memory_limit_mb = case
            .memory_limit_mb
            .or(subtask.memory_limit_mb)
            .unwrap_or(config.memory_limit_mb)
            .clamp(1, 512);
        let input = files
            .get(&case.input)
            .context("go-judge 输入文件索引丢失")?;
        let expected = files
            .get(&case.output)
            .context("go-judge 输出文件索引丢失")?;
        let command = crate::oi::go_judge::command_for_compiled_case(
            executable_file_id,
            input,
            time_limit_ms,
            memory_limit_mb,
            user_runtime_files,
            config.filename.as_deref(),
        )?;
        let response = tokio::select! {
            response=client.run(command)=>Some(response?),
            _=progress.wait_cancelled()=>None,
        };
        let Some(response) = response else {
            results.push(crate::oi::cancelled_case(case));
            progress
                .finish_case(
                    &subtask.id,
                    &case_id,
                    results.last().unwrap(),
                    maximums[case_index],
                )
                .await;
            passed = false;
            continue;
        };
        let stdout = response
            .files
            .get("stdout")
            .map(|file| file.content().as_bytes())
            .unwrap_or_default();
        let (actual, missing_file_output) = if let Some(filename) = config.filename.as_deref() {
            let name = format!("{filename}.out");
            match response.files.get(&name) {
                Some(file) => (file.content().as_bytes(), false),
                None => (&[][..], true),
            }
        } else {
            (stdout, false)
        };
        let mut checker_points = None;
        let mut status = if config.self_test.is_some() {
            crate::oi::go_judge::map_status(&response, expected, actual, |expected, actual| {
                config
                    .self_test
                    .as_ref()
                    .is_some_and(|mode| mode.no_compare_inputs.contains(&case.input))
                    || check_self_test_output(expected, actual)
            })
        } else if config.checker.kind == OiCheckerType::Testlib {
            crate::oi::go_judge::map_status(&response, expected, actual, |_, _| true)
        } else {
            crate::oi::go_judge::map_status(&response, expected, actual, |expected, actual| {
                check_output(config.checker.kind, expected, actual)
            })
        };
        // 资源/运行状态优先；只有程序正常结束且没有生成约定文件时才是 FE。
        if missing_file_output && status == OiStatus::Accepted {
            status = OiStatus::FormatError;
        }
        if config.checker.kind == OiCheckerType::Testlib && status == OiStatus::Accepted {
            let checker_file_id =
                checker_file_id.context("go-judge testlib checker 文件索引丢失")?;
            let checker = crate::oi::go_judge::command_for_compiled_checker(
                checker_file_id,
                input,
                expected,
                actual,
                time_limit_ms,
                memory_limit_mb,
                checker_extra_files,
            );
            let checker_response = client.run(checker).await?;
            status = crate::oi::go_judge::map_testlib_status(&checker_response);
            let resource_status = checker_response
                .status
                .as_deref()
                .unwrap_or("")
                .to_ascii_lowercase();
            if matches!(
                resource_status.as_str(),
                "accepted" | "nonzero exit status" | "nonzero_exit_status" | ""
            ) {
                let stderr = checker_response
                    .files
                    .get("stderr")
                    .map(|file| file.content().as_bytes())
                    .unwrap_or_default();
                let parsed = crate::oi::testlib_points(
                    checker_response.exit_status,
                    stderr,
                    maximums[case_index],
                );
                status = parsed.0;
                checker_points = parsed.1;
            }
        }
        let wall_time_ms = response.clock_time.map(|ns| ns / 1_000_000);
        let cpu_time_ms = response.time.map(|ns| ns / 1_000_000);
        results.push(OiCaseResult {
            stdout: config.self_test.as_ref().map(|_| limited_output(actual).0),
            stderr: config.self_test.as_ref().map(|_| {
                limited_output(
                    response
                        .files
                        .get("stderr")
                        .map(|file| file.content().as_bytes())
                        .unwrap_or_default(),
                )
                .0
            }),
            stdout_truncated: config.self_test.as_ref().map(|_| limited_output(actual).1),
            stderr_truncated: config.self_test.as_ref().map(|_| {
                limited_output(
                    response
                        .files
                        .get("stderr")
                        .map(|file| file.content().as_bytes())
                        .unwrap_or_default(),
                )
                .1
            }),
            score: checker_points,
            max_score: None,
            case_id: Some(case.input.clone()),
            input: case.input.clone(),
            status,
            time_ms: cpu_time_ms.or(wall_time_ms),
            memory_kb: response.memory.map(|bytes| bytes / 1024),
            cpu_time_ms,
            wall_time_ms,
            equivalent_time_ms: cpu_time_ms,
            fuel_consumed: None,
            fuel_budget: None,
            termination_reason: None,
        });
        progress
            .finish_case(
                &subtask.id,
                &case_id,
                results.last().unwrap(),
                maximums[case_index],
            )
            .await;
        if status != OiStatus::Accepted {
            passed = false;
        }
        if subtask.should_stop(&results) {
            break;
        }
    }
    Ok((passed, results))
}

pub(super) fn compile_response_is_infrastructure_error(
    response: &crate::oi::go_judge::GoJudgeResponse,
) -> bool {
    let status = response
        .status
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if status.is_empty() {
        return true;
    }
    if status == "accepted"
        && response.exit_status.unwrap_or_default() == 0
        && !response.file_ids.contains_key("main")
    {
        return true;
    }
    matches!(
        status.as_str(),
        "file error"
            | "file_error"
            | "internal error"
            | "internal_error"
            | "system error"
            | "system_error"
    )
}

fn uniform_oi_status_result(
    task: &JudgeTask,
    _config: &OiRuntimeConfig,
    status: OiStatus,
) -> Result<JudgeResult> {
    Ok(crate::oi::OiEvaluation {
        status,
        score: 0,
        subtasks: vec![],
    }
    .to_judge_result(&task.submission_id, task.rejudge_seq, None, None))
}
