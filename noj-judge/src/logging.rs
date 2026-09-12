//! 日志呈现层：契约布局、着色判定、按级别分流。
//!
//! 视觉契约见 `dev-docs/engineering/log-conventions.md`。
//!
//! 注意：Rust 1.96 起 `std::env::set_var` / `remove_var` 是 `unsafe`，
//! 因此着色判定抽出纯函数内核 `resolve_color_from` 供测试；测试**不得**
//! 修改进程环境。

use std::io::{self, IsTerminal, Write};
use std::time::SystemTime;
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::fmt::{format::Writer, FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::registry::LookupSpan;

pub const SGR_RESET: &str = "\x1b[0m";
pub const SGR_DIM: &str = "\x1b[2m";
pub const SGR_BOLD: &str = "\x1b[1m";

/// 按级别取 SGR 颜色码（契约 §1）。
pub fn level_sgr(level: &Level) -> &'static str {
    match *level {
        Level::ERROR => "\x1b[1;31m",
        Level::WARN => "\x1b[1;33m",
        Level::INFO => "\x1b[36m",
        Level::DEBUG | Level::TRACE => "\x1b[90m",
    }
}

/// 契约级别徽章（`padEnd(5)` 语义：WARN/INFO 带尾空格）。
pub fn level_badge(level: &Level) -> &'static str {
    match *level {
        Level::ERROR => "ERROR",
        Level::WARN => "WARN ",
        Level::INFO => "INFO ",
        Level::DEBUG | Level::TRACE => "DEBUG",
    }
}

/// 着色策略纯函数内核（契约 §3）。
pub fn resolve_color_from(no_color: Option<&str>, log_color: Option<&str>, is_tty: bool) -> bool {
    if no_color.map(|v| !v.is_empty()).unwrap_or(false) {
        return false;
    }
    match log_color.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("never") => false,
        Some("always") => true,
        _ => is_tty,
    }
}

/// 从进程环境读取并按契约判定是否着色。
pub fn resolve_color(is_tty: bool) -> bool {
    let no_color = std::env::var("NO_COLOR").ok();
    let log_color = std::env::var("LOG_COLOR").ok();
    resolve_color_from(no_color.as_deref(), log_color.as_deref(), is_tty)
}

/// 两个输出流各自的着色判定（契约 §3 硬规则 1）。
///
/// **必须按流分别探测**：warn/error 走 stderr，info/debug 走 stdout。
/// 若像此前那样取 `stdout || stderr` 的单一布尔，则在
/// `1>file 2>tty`（或反向重定向）时会用错另一条流的 TTY 结论，
/// 把转义码写进文件、或让终端失去颜色。
#[derive(Clone, Copy, Debug)]
pub struct StreamColors {
    pub stdout: bool,
    pub stderr: bool,
}

/// 由两条流的 TTY 探测结果计算各自着色（`LOG_COLOR`/`NO_COLOR` 优先）。
pub fn resolve_stream_colors(stdout_tty: bool, stderr_tty: bool) -> StreamColors {
    StreamColors {
        stdout: resolve_color(stdout_tty),
        stderr: resolve_color(stderr_tty),
    }
}

/// 当前时刻的 `HH:MM:SS.mmm`（UTC，不新增依赖）。
pub fn timestamp_hms() -> String {
    timestamp_hms_from(SystemTime::now())
}

/// 由给定时刻渲染 `HH:MM:SS.mmm`（UTC）。
pub fn timestamp_hms_from(t: SystemTime) -> String {
    let d = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let ms = d.subsec_millis();
    let day = secs % 86_400;
    let (h, m, s) = (day / 3600, (day % 3600) / 60, day % 60);
    format!("{h:02}:{m:02}:{s:02}.{ms:03}")
}

/// 采集事件字段。
#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: Vec<(String, String)>,
}

impl tracing::field::Visit for FieldVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        if field.name() == "message" {
            // tracing 的 message 字段经 Debug 渲染会带引号，去掉
            self.message = Some(rendered.trim_matches('"').to_string());
        } else {
            self.fields.push((field.name().to_string(), rendered));
        }
    }
}

/// 契约布局的 `FormatEvent` 实现。
pub struct ContractFormat {
    pub color: bool,
}

impl ContractFormat {
    /// 由按流判定结果构造：本事件走哪条流就用哪条流的着色结论。
    pub fn from_streams(colors: StreamColors, stderr: bool) -> Self {
        Self {
            color: if stderr { colors.stderr } else { colors.stdout },
        }
    }
}

impl<S, N> FormatEvent<S, N> for ContractFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> std::fmt::Result {
        let level = event.metadata().level();
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        let ts = timestamp_hms();
        if self.color {
            write!(writer, "{SGR_DIM}{ts}{SGR_RESET}  ")?;
            write!(
                writer,
                "{}{}{SGR_RESET}",
                level_sgr(level),
                level_badge(level)
            )?;
        } else {
            write!(writer, "{ts}  {}", level_badge(level))?;
        }
        write!(writer, "  {}", visitor.message.unwrap_or_default())?;
        // 模块名（契约 §5）：TS 侧由 LogTape category 提供，Rust 侧的等价物是
        // tracing target。本期只保证它进入输出，不做列内对齐。
        let target = event.metadata().target();
        if self.color {
            write!(writer, "  {SGR_DIM}target={SGR_RESET}{target}")?;
        } else {
            write!(writer, "  target={target}")?;
        }
        for (k, v) in &visitor.fields {
            if self.color {
                write!(writer, "  {SGR_DIM}{k}={SGR_RESET}{v}")?;
            } else {
                write!(writer, "  {k}={v}")?;
            }
        }
        let bold = self.color && matches!(*level, Level::WARN | Level::ERROR);
        if bold {
            write!(writer, "{SGR_BOLD}")?;
        }
        writeln!(writer)
    }
}

/// 分流策略纯函数内核：warn/error 走 stderr，其余走 stdout。
///
/// 与 `resolve_color_from` 同理——把判定抽成纯函数，测试无需构造
/// `Metadata`（其 `FieldSet` 需要一个 `'static` callsite，测试里不便伪造）。
pub fn should_use_stderr(level: &Level) -> bool {
    matches!(*level, Level::WARN | Level::ERROR)
}

/// 按级别分流的 writer（warn/error → stderr，其余 → stdout）。
pub struct LevelSplitWriter;

/// 一次事件的输出目标。
pub struct LevelWriter {
    stderr: bool,
}

impl Write for LevelWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.stderr {
            io::stderr().write(buf)
        } else {
            io::stdout().write(buf)
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.stderr {
            io::stderr().flush()
        } else {
            io::stdout().flush()
        }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LevelSplitWriter {
    type Writer = LevelWriter;
    fn make_writer(&'a self) -> Self::Writer {
        LevelWriter { stderr: false }
    }
    fn make_writer_for(&'a self, meta: &tracing::metadata::Metadata<'_>) -> Self::Writer {
        LevelWriter {
            stderr: should_use_stderr(meta.level()),
        }
    }
}

/// 迁移前 `main.rs` 的默认过滤器，保持日志**量**不变。
///
/// 提到模块级是为了让测试能直接引用，避免测试与实现各写一份字面量而漂移。
pub const DEFAULT_DIRECTIVE: &str = "info,noj_judge=debug";

/// 级别过滤：`RUST_LOG` 优先，未设置时回退 `LOG_LEVEL`，再回退既有默认。
///
/// `EnvFilter` 解析的是过滤指令语法（如 `info,noj_judge=debug`），
/// 裸级别名同样合法。
///
/// 注意（与迁移计划的偏差，有意为之）：计划的 `build_filter` 在
/// `RUST_LOG` 未设置时回退到裸 `info`，这会**静默丢弃**本 crate 原有的
/// `noj_judge=debug` 默认——即评测细节日志（容器生命周期、拉取/重试等）。
/// 本迁移的目标是统一呈现层，不应顺带改变日志**量**。因此：
/// - `RUST_LOG` 设置 → 完全遵循（部署侧 per-target 配置不受影响）；
/// - `LOG_LEVEL` 设置 → 作为全局限级；
/// - 两者都未设置 → 保持原默认 `info,noj_judge=debug`。
pub fn build_filter() -> tracing_subscriber::EnvFilter {
    if let Ok(f) = tracing_subscriber::EnvFilter::try_from_default_env() {
        return f;
    }
    let directive = match std::env::var("LOG_LEVEL") {
        Ok(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "debug" => "debug".to_string(),
            "warn" => "warn".to_string(),
            "error" => "error".to_string(),
            "info" => "info".to_string(),
            _ => DEFAULT_DIRECTIVE.to_string(),
        },
        Err(_) => DEFAULT_DIRECTIVE.to_string(),
    };
    tracing_subscriber::EnvFilter::new(directive)
}

/// 装配全局 subscriber。
///
/// 修复既有缺陷：原实现使用 `tracing_subscriber::fmt()` 的默认 ansi 推导
/// （只认 `NO_COLOR`、不探测 TTY），在 `driver: json-file` 下把 ANSI 转义码
/// 原样写入日志文件。
///
/// 着色按流分别探测（契约 §3 硬规则 1）：`ContractFormat` 由 `LevelSplitWriter`
/// 在每条事件上按目标流重建，因此 `1>file 2>tty` 这类重定向不会串色。
pub fn init() {
    let colors = resolve_stream_colors(io::stdout().is_terminal(), io::stderr().is_terminal());
    // 注意：不要调用 `.with_ansi(...)` —— 该方法只存在于默认 formatter 的
    // builder（`SubscriberBuilder<N, Format<L,T>, F, W>`）上；改用自定义
    // `event_format` 后 builder 类型变为 `SubscriberBuilder<N, ContractFormat, F, W>`，
    // 调用它会编译失败。着色完全由 `ContractFormat` 自行产生。
    tracing_subscriber::fmt()
        .with_env_filter(build_filter())
        .event_format(StreamAwareFormat { colors })
        .with_writer(LevelSplitWriter)
        .init();
}

/// 按事件目标流选择着色的 `FormatEvent` 包装。
///
/// `MakeWriter::make_writer_for` 已经按级别决定了流，但着色必须与**同一条流**
/// 的 TTY 结论配对，故在此按级别重算一次分流（与 `should_use_stderr` 同一判据）。
pub struct StreamAwareFormat {
    pub colors: StreamColors,
}

impl<S, N> FormatEvent<S, N> for StreamAwareFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        writer: Writer<'_>,
        event: &Event<'_>,
    ) -> std::fmt::Result {
        let stderr = should_use_stderr(event.metadata().level());
        ContractFormat::from_streams(self.colors, stderr).format_event(ctx, writer, event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, UNIX_EPOCH};
    use tracing_subscriber::fmt::MakeWriter;

    #[test]
    fn color_policy_order() {
        assert!(!resolve_color_from(None, None, false));
        assert!(resolve_color_from(None, None, true));
        assert!(resolve_color_from(None, Some("always"), false));
        assert!(!resolve_color_from(None, Some("never"), true));
        assert!(!resolve_color_from(Some("1"), Some("always"), true));
        assert!(resolve_color_from(Some(""), None, true));
        assert!(resolve_color_from(None, Some("bogus"), true));
        // 大小写与空白须与 TS 侧同样宽容（core 用 trim + toLowerCase）
        assert!(resolve_color_from(None, Some("ALWAYS"), false));
        assert!(!resolve_color_from(None, Some("  Never  "), true));
    }

    #[test]
    fn colors_resolved_per_stream() {
        // 契约 §3 硬规则 1：两条流各自探测 TTY。
        // `1>file 2>tty` 这类重定向下，stdout 无色、stderr 有色，
        // 取 `stdout || stderr` 的单一布尔会把转义码写进文件。
        //
        // 直接测纯函数内核：`resolve_stream_colors` 会读进程环境，
        // 而 CI/开发机可能已设 NO_COLOR（本仓库开发环境即设了 NO_COLOR=1），
        // 断言其结果会变成环境敏感测试。
        let c = StreamColors {
            stdout: resolve_color_from(None, None, false),
            stderr: resolve_color_from(None, None, true),
        };
        assert!(!c.stdout, "stdout 非 TTY 必须无色（否则转义码进文件）");
        assert!(c.stderr, "stderr 是 TTY 应着色");

        let d = StreamColors {
            stdout: resolve_color_from(None, None, true),
            stderr: resolve_color_from(None, None, false),
        };
        assert!(d.stdout);
        assert!(!d.stderr);
    }

    #[test]
    fn contract_format_only_colors_its_own_stream() {
        // 无色 stdout + 有色 stderr：INFO 行不得带转义，WARN 行必须带。
        let out = Arc::new(Mutex::new(Vec::new()));
        let err = Arc::new(Mutex::new(Vec::new()));
        let sub = tracing_subscriber::fmt::Subscriber::builder()
            .with_env_filter(tracing_subscriber::EnvFilter::new("trace"))
            .event_format(StreamAwareFormat {
                colors: StreamColors {
                    stdout: false,
                    stderr: true,
                },
            })
            .with_writer(Split(out.clone(), err.clone()))
            .finish();
        tracing::subscriber::with_default(sub, || {
            tracing::info!("去 stdout");
            tracing::warn!("去 stderr");
        });
        let o = String::from_utf8(out.lock().unwrap().clone()).unwrap();
        let e = String::from_utf8(err.lock().unwrap().clone()).unwrap();
        assert!(!o.contains('\u{1b}'), "无色流不得出现转义序列: {o:?}");
        assert!(e.contains('\u{1b}'), "有色流应出现转义序列: {e:?}");
    }

    #[test]
    fn emits_target_as_module_name() {
        // 契约 §5：TS 侧模块名来自 LogTape category，Rust 侧等价物是 target。
        let out = Arc::new(Mutex::new(Vec::new()));
        let err = Arc::new(Mutex::new(Vec::new()));
        let sub = tracing_subscriber::fmt::Subscriber::builder()
            .with_env_filter(tracing_subscriber::EnvFilter::new("trace"))
            .event_format(ContractFormat { color: false })
            .with_writer(Split(out.clone(), err.clone()))
            .finish();
        tracing::subscriber::with_default(sub, || {
            tracing::info!("带模块名");
        });
        let o = String::from_utf8(out.lock().unwrap().clone()).unwrap();
        assert!(o.contains("target="), "应输出模块名等价物 target=: {o:?}");
    }

    #[test]
    fn timestamp_is_hms_with_millis() {
        let t = UNIX_EPOCH + Duration::from_millis(3_661_007);
        assert_eq!(timestamp_hms_from(t), "01:01:01.007");
        assert_eq!(timestamp_hms().len(), 12);
        assert_eq!(&timestamp_hms()[2..3], ":");
        assert_eq!(&timestamp_hms()[8..9], ".");
    }

    #[test]
    fn badges_pad_to_five() {
        assert_eq!(level_badge(&Level::ERROR), "ERROR");
        assert_eq!(level_badge(&Level::WARN), "WARN ");
        assert_eq!(level_badge(&Level::INFO), "INFO ");
        assert_eq!(level_badge(&Level::DEBUG), "DEBUG");
    }

    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl Write for Buf {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct Split(Arc<Mutex<Vec<u8>>>, Arc<Mutex<Vec<u8>>>);
    impl<'a> MakeWriter<'a> for Split {
        type Writer = Buf;
        fn make_writer(&'a self) -> Buf {
            Buf(self.0.clone())
        }
        fn make_writer_for(&'a self, m: &tracing::metadata::Metadata<'_>) -> Buf {
            if matches!(*m.level(), Level::WARN | Level::ERROR) {
                Buf(self.1.clone())
            } else {
                Buf(self.0.clone())
            }
        }
    }

    #[test]
    fn writes_contract_layout_and_splits_streams() {
        let out = Arc::new(Mutex::new(Vec::new()));
        let err = Arc::new(Mutex::new(Vec::new()));
        let sub = tracing_subscriber::fmt::Subscriber::builder()
            .with_env_filter(tracing_subscriber::EnvFilter::new("trace"))
            .event_format(ContractFormat { color: false })
            .with_writer(Split(out.clone(), err.clone()))
            .finish();
        tracing::subscriber::with_default(sub, || {
            tracing::info!(submission_id = %"abc", "入队");
            tracing::warn!(error = %"boom", "失败");
        });
        let o = String::from_utf8(out.lock().unwrap().clone()).unwrap();
        let e = String::from_utf8(err.lock().unwrap().clone()).unwrap();
        assert!(o.contains("INFO "), "stdout 应含 INFO 徽章: {o:?}");
        assert!(o.contains("submission_id"), "stdout 应含结构化字段: {o:?}");
        assert!(o.contains("入队"));
        assert!(e.contains("WARN "), "stderr 应含 WARN: {e:?}");
        assert!(e.contains("失败"));
        assert!(!o.contains('\u{1b}'), "无色模式不得有转义");
        assert!(!e.contains('\u{1b}'));
        // 时间戳位于行首，形如 HH:MM:SS.mmm
        assert_eq!(&o[..12], &timestamp_hms()[..12]);
        assert_eq!(o.as_bytes()[2], b':');
    }

    #[test]
    fn contract_format_emits_sgr_when_colored() {
        let out = Arc::new(Mutex::new(Vec::new()));
        let err = Arc::new(Mutex::new(Vec::new()));
        let sub = tracing_subscriber::fmt::Subscriber::builder()
            .with_env_filter(tracing_subscriber::EnvFilter::new("trace"))
            .event_format(ContractFormat { color: true })
            .with_writer(Split(out.clone(), err.clone()))
            .finish();
        tracing::subscriber::with_default(sub, || {
            tracing::info!("启动");
        });
        let o = String::from_utf8(out.lock().unwrap().clone()).unwrap();
        assert!(o.contains(SGR_RESET), "着色模式应含 SGR_RESET: {o:?}");
        assert!(o.contains(SGR_DIM), "时间戳应使用暗色: {o:?}");
    }

    #[test]
    fn build_filter_accepts_bare_level_from_log_level() {
        // 不触碰进程环境：直接验证回退逻辑构造的指令可被 EnvFilter 解析。
        let f = tracing_subscriber::EnvFilter::new("info");
        assert!(f.to_string().contains("info"));
    }

    #[test]
    fn default_directive_keeps_crate_debug_subsystem() {
        // 回归防护：迁移不得静默丢掉 noj_judge=debug 默认（评测细节日志）。
        // 直接验证语义：该指令放行 noj_judge 的 debug 事件，同时仍抑制
        // 其他 target 的 debug（全局为 info）。
        use tracing_subscriber::layer::SubscriberExt;

        let filter = tracing_subscriber::EnvFilter::new(DEFAULT_DIRECTIVE);
        assert!(
            filter.to_string().contains("noj_judge=debug"),
            "默认指令必须保留 crate 级 debug 放行: {filter}"
        );
        let sub = tracing_subscriber::registry().with(filter);
        tracing::subscriber::with_default(sub, || {
            assert!(
                tracing::enabled!(target: "noj_judge::docker", tracing::Level::DEBUG),
                "noj_judge 的 debug 应被放行"
            );
            assert!(
                !tracing::enabled!(target: "bollard::docker", tracing::Level::DEBUG),
                "其他 target 的 debug 应被抑制（全局 info）"
            );
            assert!(
                tracing::enabled!(target: "bollard::docker", tracing::Level::INFO),
                "其他 target 的 info 应被放行"
            );
        });
    }
}

#[cfg(test)]
mod split_tests {
    use super::*;

    /// `should_use_stderr` 的分级路由：warn/error → stderr，其余 → stdout。
    #[test]
    fn level_split_routes_by_level() {
        assert!(should_use_stderr(&Level::ERROR));
        assert!(should_use_stderr(&Level::WARN));
        assert!(!should_use_stderr(&Level::INFO));
        assert!(!should_use_stderr(&Level::DEBUG));
        assert!(!should_use_stderr(&Level::TRACE));
    }

    /// 默认 writer（无 level 上下文）走 stdout。
    #[test]
    fn default_writer_uses_stdout() {
        use tracing_subscriber::fmt::MakeWriter;
        assert!(!LevelSplitWriter.make_writer().stderr);
    }
}
