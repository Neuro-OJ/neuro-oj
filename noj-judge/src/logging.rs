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

/// SGR **参数码**（不含 ESC 包装），与契约 §1 一一对应。
///
/// 存参数码而非完整转义序列，是为了把「行级强调」与「片段自身样式」合成进
/// 同一个序列（见 `render_segments`）。复合码由 `sgr_join` 合成：
/// ERROR 徽章 `1;31` = `sgr_join(&[CODE_BOLD, CODE_ERROR])`。
pub const CODE_BOLD: &str = "1";
pub const CODE_DIM: &str = "2";
pub const CODE_ERROR: &str = "31";
pub const CODE_WARN: &str = "33";
pub const CODE_INFO: &str = "36";
pub const CODE_DEBUG: &str = "90";
/// 模块名（契约 §2 模块列）。
pub const CODE_MODULE: &str = "34";

/// 模块列宽（契约 §2）。
pub const MODULE_WIDTH: usize = 14;
/// msg 起始列：12(ts) + 2 + 5(级别) + 2 + 14(模块) + 2 = 37（契约 §2）。
pub const MSG_COLUMN: usize = 12 + 2 + 5 + 2 + MODULE_WIDTH + 2;

/// 按级别取 SGR **参数码**，便于与行级强调合成。
///
/// 契约 §1：WARN 只是黄色徽章（`33`），**整行粗体是 ERROR 专属**。
/// WARN 在生产是常态级别（`LOG_LEVEL` 默认 warn），若也整行加粗，
/// 整个生产日志流会被加粗淹没，粗体不再指示「需要立刻处理」。
pub fn level_code(level: &Level) -> &'static str {
    match *level {
        Level::ERROR => CODE_ERROR,
        Level::WARN => CODE_WARN,
        Level::INFO => CODE_INFO,
        Level::DEBUG | Level::TRACE => CODE_DEBUG,
    }
}

/// ERROR 是否整行粗体（契约 §1）。
pub fn is_bold_line(level: &Level) -> bool {
    matches!(*level, Level::ERROR)
}

/// 合成 SGR 序列；参数码去重（行级 `1` 与徽章自身重复时不会变成 `1;1`）。
///
/// 无码时返回空串，调用方无需分支即可安全拼接。
pub fn sgr_join(codes: &[&str]) -> String {
    let mut uniq: Vec<&str> = Vec::with_capacity(codes.len());
    for c in codes {
        if !uniq.contains(c) {
            uniq.push(c);
        }
    }
    if uniq.is_empty() {
        String::new()
    } else {
        format!("\x1b[{}m", uniq.join(";"))
    }
}

/// 模块名：tracing `target` 去掉 crate 前缀，取末段（契约 §5）。
///
/// `noj_judge::dual::container` → `container`；`noj_judge` → `noj_judge`。
pub fn module_from_target(target: &str) -> &str {
    target.rsplit("::").next().unwrap_or(target)
}

/// 模块名截断到列宽（超宽加省略号，避免撑破列）。
///
/// 按**字符**而非字节截断：模块名可能含非 ASCII，按字节切会产出非法 UTF-8
/// 边界（`&str` 索引越界会 panic）。
pub fn fit_module(name: &str) -> String {
    let count = name.chars().count();
    if count <= MODULE_WIDTH {
        // padEnd 语义：右侧补空格到固定列宽
        let mut s = String::with_capacity(MODULE_WIDTH);
        s.push_str(name);
        s.extend(std::iter::repeat_n(' ', MODULE_WIDTH - count));
        s
    } else {
        let head: String = name.chars().take(MODULE_WIDTH - 1).collect();
        format!("{head}…")
    }
}

/// 一行中一个带样式的片段。
///
/// 渲染层**必须**按片段合成 SGR，不能在整行外层套样式：行内每个片段的
/// `reset` 都会把外层样式清掉——历史上「WARN/ERROR 整行粗体」正是因此
/// **从未生效**，而旧实现写在换行前且不带 `reset`，还会把粗体泄漏到后续输出。
struct Segment {
    text: String,
    /// SGR 参数码；空表示继承默认色。
    codes: Vec<&'static str>,
    /// 是否参与行级强调（纯空白片段不参与，避免白添转义字节）。
    emphasize: bool,
}

impl Segment {
    fn new(text: impl Into<String>, codes: Vec<&'static str>) -> Self {
        let text = text.into();
        let emphasize = !text.trim().is_empty();
        Self {
            text,
            codes,
            emphasize,
        }
    }
}

/// 把片段序列渲染为字符串；无色时仅拼接文本（保证零转义序列）。
fn render_segments(segments: &[Segment], color: bool, bold_line: bool) -> String {
    let mut out = String::new();
    for seg in segments {
        // 空文本不产出转义序列：否则会留下「开了样式却没有内容」的裸 SGR，
        // 该样式状态会泄漏到后续无关输出。
        if seg.text.is_empty() {
            continue;
        }
        let mut codes = seg.codes.clone();
        if bold_line && seg.emphasize && !codes.contains(&"1") {
            // 强调码**前置**，使合成结果与契约表一致：
            // ERROR 徽章 31 + 行级 1 → 1;31。
            codes.insert(0, "1");
        }
        if !color || codes.is_empty() {
            out.push_str(&seg.text);
            continue;
        }
        // 每个着色片段自成 `开 → 文本 → 关`，片段间不共享样式状态。
        out.push_str(&sgr_join(&codes));
        out.push_str(&seg.text);
        out.push_str(SGR_RESET);
    }
    out
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
        let mut segments: Vec<Segment> = Vec::with_capacity(6 + visitor.fields.len());
        segments.push(Segment::new(ts, vec![CODE_DIM]));
        segments.push(Segment::new("  ", vec![]));
        segments.push(Segment::new(level_badge(level), vec![level_code(level)]));
        // 模块列（契约 §2）：tracing 的等价物是 target，去掉 crate 前缀取末段。
        segments.push(Segment::new("  ", vec![]));
        segments.push(Segment::new(
            fit_module(module_from_target(event.metadata().target())),
            vec![CODE_MODULE],
        ));
        segments.push(Segment::new("  ", vec![]));

        // msg 含换行时续行缩进到 msg 起始列（与 TS 侧一致）。
        let indent = " ".repeat(MSG_COLUMN);
        let message = visitor.message.unwrap_or_default();
        segments.push(Segment::new(
            message.replace('\n', &format!("\n{indent}")),
            vec![],
        ));

        for (k, v) in &visitor.fields {
            segments.push(Segment::new("  ", vec![]));
            segments.push(Segment::new(format!("{k}="), vec![CODE_DIM]));
            // 多行值（如错误详情）续行缩进，保持块状可读。
            let value = v.replace('\n', &format!("\n{indent}  "));
            segments.push(Segment::new(value, vec![]));
        }

        let rendered = render_segments(&segments, self.color, is_bold_line(level));
        write!(writer, "{rendered}")?;
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
    fn emits_module_column_from_target() {
        // 契约 §2/§5：TS 侧模块名来自 LogTape category，Rust 侧等价物是
        // target（去 crate 前缀取末段），进入定宽模块列而非 `target=` 字段。
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
        // 本测试模块的 target 末段是 "tests"（module_path! = noj_judge::logging::tests）。
        assert!(
            !o.contains("target="),
            "模块名不再以 target= 字段输出（已升为模块列）: {o:?}"
        );
        // 模块列紧跟级别徽章之后，msg 从第 MSG_COLUMN 列开始。
        let msg_at = o.find("带模块名").expect("应含 msg");
        assert_eq!(
            msg_at, MSG_COLUMN,
            "msg 必须从第 {MSG_COLUMN} 列开始: {o:?}"
        );
        assert_eq!(&o[21..35], "tests         ", "模块列应定宽 14: {o:?}");
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
        assert!(
            o.contains(&sgr_join(&[CODE_DIM])),
            "时间戳应使用暗色: {o:?}"
        );
    }

    /// 按 SGR 状态机解析一行，返回「某段文本实际带的参数码集合」。
    ///
    /// 必要性：断言「行首是否有 `\x1b[1m`」**无法**证明整行粗体生效——
    /// 旧实现恰好满足该断言却完全没生效（`\x1b[1m` 写在末尾，只留下一个
    /// 未闭合的粗体状态，对任何文本都不生效且污染后续输出）。
    fn codes_for(line: &str, needle: &str) -> Vec<String> {
        let mut active: Vec<String> = Vec::new();
        let mut idx = 0;
        let bytes = line.as_bytes();
        let mut seg_start = 0;
        let mut result: Option<Vec<String>> = None;
        while idx < bytes.len() {
            if bytes[idx] == 0x1b && idx + 1 < bytes.len() && bytes[idx + 1] == b'[' {
                // 记录进入转义前的文本段
                if result.is_none() && line[seg_start..idx].contains(needle) {
                    result = Some(active.clone());
                }
                let end = line[idx..]
                    .find('m')
                    .map(|p| idx + p)
                    .unwrap_or(bytes.len());
                let params = &line[idx + 2..end];
                if params.is_empty() || params == "0" {
                    active.clear();
                } else {
                    for p in params.split(';') {
                        if !active.iter().any(|c| c == p) {
                            active.push(p.to_string());
                        }
                    }
                }
                idx = end + 1;
                seg_start = idx;
                continue;
            }
            idx += 1;
        }
        if result.is_none() && line[seg_start..].contains(needle) {
            result = Some(active.clone());
        }
        result.unwrap_or_default()
    }

    /// 一行结束时是否仍处于「已开样式」（未闭合 SGR → 样式泄漏）。
    fn has_unclosed_sgr(line: &str) -> bool {
        let mut active = 0usize;
        let mut idx = 0;
        let bytes = line.as_bytes();
        while idx < bytes.len() {
            if bytes[idx] == 0x1b && idx + 1 < bytes.len() && bytes[idx + 1] == b'[' {
                let end = line[idx..]
                    .find('m')
                    .map(|p| idx + p)
                    .unwrap_or(bytes.len());
                let params = &line[idx + 2..end];
                if params.is_empty() || params == "0" {
                    active = 0;
                } else {
                    active += params.split(';').count();
                }
                idx = end + 1;
                continue;
            }
            idx += 1;
        }
        active > 0
    }

    /// 在给定级别下渲染一行（着色），返回输出与走哪条流无关的字符串。
    fn render_one(level_msg: &str) -> String {
        let out = Arc::new(Mutex::new(Vec::new()));
        let err = Arc::new(Mutex::new(Vec::new()));
        let sub = tracing_subscriber::fmt::Subscriber::builder()
            .with_env_filter(tracing_subscriber::EnvFilter::new("trace"))
            .event_format(ContractFormat { color: true })
            .with_writer(Split(out.clone(), err.clone()))
            .finish();
        tracing::subscriber::with_default(sub, || match level_msg {
            "error" => tracing::error!("失败"),
            "warn" => tracing::warn!("失败"),
            _ => tracing::info!("失败"),
        });
        // ERROR/WARN 走 stderr，INFO 走 stdout
        let is_err = matches!(level_msg, "error" | "warn");
        let buf = if is_err { err } else { out };
        let bytes = buf.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn error_line_is_bold_and_covers_message() {
        // 契约 §1：ERROR 整行粗体，且必须**真的覆盖 message**。
        let o = render_one("error");
        let codes = codes_for(&o, "失败");
        assert!(
            codes.iter().any(|c| c == "1"),
            "ERROR 整行粗体必须覆盖 message 本体: {o:?}"
        );
        // 徽章合成码须为 1;31（行级 1 前置 + 级别 31）
        assert!(o.contains("\x1b[1;31m"), "ERROR 徽章应为 1;31: {o:?}");
        assert!(!has_unclosed_sgr(o.trim_end()), "不得留下未闭合 SGR: {o:?}");
    }

    #[test]
    fn warn_line_is_not_bold() {
        // 契约 §1：WARN 只着色徽章（33），不整行粗体。
        let o = render_one("warn");
        assert!(o.contains("\x1b[33m"), "WARN 徽章应为黄色 33: {o:?}");
        assert!(
            !o.contains("\x1b[1;33m"),
            "WARN 不得为粗体黄 1;33（整行粗体是 ERROR 专属）: {o:?}"
        );
        let codes = codes_for(&o, "失败");
        assert!(
            !codes.iter().any(|c| c == "1"),
            "WARN 的 message 不得为粗体: {o:?}"
        );
        assert!(!has_unclosed_sgr(o.trim_end()), "不得留下未闭合 SGR: {o:?}");
    }

    #[test]
    fn info_line_is_not_bold() {
        let o = render_one("info");
        let codes = codes_for(&o, "失败");
        assert!(!codes.iter().any(|c| c == "1"), "INFO 不得粗体: {o:?}");
    }

    #[test]
    fn fit_module_pads_and_truncates() {
        assert_eq!(fit_module("db"), "db".to_string() + &" ".repeat(12));
        assert_eq!(fit_module("content-review"), "content-review");
        assert_eq!(fit_module("content-review").chars().count(), MODULE_WIDTH);
        let long = fit_module("a-very-long-module-name");
        assert_eq!(long.chars().count(), MODULE_WIDTH);
        assert!(long.ends_with('…'), "超宽须有省略号: {long:?}");
        // 非 ASCII：必须按字符截断，不得 panic 或产出半个字符
        let cjk = fit_module("模块名字很长很长很长很长");
        assert_eq!(cjk.chars().count(), MODULE_WIDTH);
    }

    #[test]
    fn module_from_target_strips_crate_prefix() {
        assert_eq!(
            module_from_target("noj_judge::dual::container"),
            "container"
        );
        assert_eq!(module_from_target("noj_judge::mq"), "mq");
        assert_eq!(module_from_target("noj_judge"), "noj_judge");
        assert_eq!(module_from_target("bollard::docker"), "docker");
    }

    #[test]
    fn sgr_join_dedups_and_handles_empty() {
        assert_eq!(sgr_join(&[]), "");
        assert_eq!(sgr_join(&["1"]), "\x1b[1m");
        assert_eq!(sgr_join(&["1", "31"]), "\x1b[1;31m");
        // 去重：行级 1 与徽章自身重复时不得变成 1;1
        assert_eq!(sgr_join(&["1", "1", "33"]), "\x1b[1;33m");
    }

    #[test]
    fn level_codes_match_contract() {
        assert_eq!(level_code(&Level::ERROR), "31");
        assert_eq!(level_code(&Level::WARN), "33");
        assert_eq!(level_code(&Level::INFO), "36");
        assert_eq!(level_code(&Level::DEBUG), "90");
        // 整行粗体是 ERROR 专属
        assert!(is_bold_line(&Level::ERROR));
        assert!(!is_bold_line(&Level::WARN));
        assert!(!is_bold_line(&Level::INFO));
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
