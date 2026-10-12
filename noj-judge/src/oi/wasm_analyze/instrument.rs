//! 仅对受控链接产物插桩；新增 globals 追加在原索引空间之后。
use anyhow::{Context, Result};
use wasm_encoder::{
    reencode::{self, Reencode},
    *,
};
use wasmparser::{Operator, Parser, Payload};

pub const PREFIX: &str = "__noj_analysis_";

pub struct Instrumented {
    pub bytes: Vec<u8>,
    pub body_ranges: Vec<std::ops::Range<usize>>,
    pub imported_functions: u32,
}

pub fn instrument(bytes: &[u8]) -> Result<Instrumented> {
    wasmparser::Validator::new().validate_all(bytes)?;
    let mut params = Vec::new();
    let mut types = Vec::new();
    let mut global_count = 0;
    let mut imported_functions = 0;
    let mut ranges = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::TypeSection(section) => {
                for ty in section.into_iter_err_on_gc_types() {
                    params.push(ty?.params().len() as u32);
                }
            }
            Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import?;
                    anyhow::ensure!(!import.name.starts_with(PREFIX), "原模块使用分析保留名称");
                    match import.ty {
                        wasmparser::TypeRef::Func(_) => imported_functions += 1,
                        wasmparser::TypeRef::Global(_) => global_count += 1,
                        _ => {}
                    }
                }
            }
            Payload::GlobalSection(section) => global_count += section.count(),
            Payload::ExportSection(section) => {
                for export in section {
                    anyhow::ensure!(!export?.name.starts_with(PREFIX), "原模块使用分析保留名称");
                }
            }
            Payload::FunctionSection(section) => {
                for ty in section {
                    types.push(ty?);
                }
            }
            Payload::CodeSectionEntry(body) => {
                let range = body.range();
                ranges.push(usize::try_from(range.start)?..usize::try_from(range.end)?);
            }
            _ => {}
        }
    }
    anyhow::ensure!(ranges.len() <= 16384, "分析函数数量超限");
    let count = ranges.len() as u32;
    let mut encoder = Encoder {
        base: global_count,
        count,
        params,
        types,
        next: 0,
        globals_written: false,
        exports_written: false,
        costs: super::super::standard::manifest()["operator_costs"].clone(),
    };
    let mut module = Module::new();
    encoder
        .parse_core_module(&mut module, Parser::new(0), bytes)
        .map_err(|e| anyhow::anyhow!("插桩失败: {e}"))?;
    let bytes = module.finish();
    wasmparser::Validator::new()
        .validate_all(&bytes)
        .context("插桩模块校验失败")?;
    Ok(Instrumented {
        bytes,
        body_ranges: ranges,
        imported_functions,
    })
}

struct Encoder {
    base: u32,
    count: u32,
    params: Vec<u32>,
    types: Vec<u32>,
    next: usize,
    globals_written: bool,
    exports_written: bool,
    costs: serde_json::Value,
}
impl Encoder {
    fn globals(&self, section: &mut GlobalSection) {
        for _ in 0..self.count {
            section.global(
                GlobalType {
                    val_type: ValType::I64,
                    mutable: true,
                    shared: false,
                },
                &ConstExpr::i64_const(0),
            );
        }
    }
    fn exports(&self, section: &mut ExportSection) {
        for index in 0..self.count {
            section.export(
                &format!("{PREFIX}{index}"),
                ExportKind::Global,
                self.base + index,
            );
        }
    }
}
fn add_const(f: &mut Function, global: u32, amount: u64) {
    if amount == 0 {
        return;
    }
    f.instruction(&Instruction::GlobalGet(global));
    f.instruction(&Instruction::I64Const(amount as i64));
    f.instruction(&Instruction::I64Add);
    f.instruction(&Instruction::GlobalSet(global));
}
fn add_variable(f: &mut Function, global: u32, local: u32, cost: u64) {
    // 批量指令长度总在栈顶；tee 保留原操作数，不改变程序语义。
    f.instruction(&Instruction::LocalTee(local));
    f.instruction(&Instruction::GlobalGet(global));
    f.instruction(&Instruction::LocalGet(local));
    f.instruction(&Instruction::I64ExtendI32U);
    f.instruction(&Instruction::I64Const(cost as i64));
    f.instruction(&Instruction::I64Mul);
    f.instruction(&Instruction::I64Add);
    f.instruction(&Instruction::GlobalSet(global));
}
fn variable_name(op: &Operator<'_>) -> Option<&'static str> {
    match op {
        Operator::MemoryCopy { .. } => Some("memory_copy_per_byte"),
        Operator::MemoryFill { .. } => Some("memory_fill_per_byte"),
        Operator::MemoryInit { .. } => Some("memory_init_per_byte"),
        Operator::MemoryGrow { .. } => Some("memory_grow_per_page"),
        Operator::TableCopy { .. } => Some("table_copy_per_element"),
        Operator::TableFill { .. } => Some("table_fill_per_element"),
        Operator::TableInit { .. } => Some("table_init_per_element"),
        Operator::TableGrow { .. } => Some("table_grow_per_element"),
        _ => None,
    }
}
impl Reencode for Encoder {
    type Error = String;
    fn parse_global_section(
        &mut self,
        section: &mut GlobalSection,
        reader: wasmparser::GlobalSectionReader<'_>,
    ) -> Result<(), reencode::Error<String>> {
        reencode::utils::parse_global_section(self, section, reader)?;
        self.globals(section);
        self.globals_written = true;
        Ok(())
    }
    fn parse_export_section(
        &mut self,
        section: &mut ExportSection,
        reader: wasmparser::ExportSectionReader<'_>,
    ) -> Result<(), reencode::Error<String>> {
        reencode::utils::parse_export_section(self, section, reader)?;
        self.exports(section);
        self.exports_written = true;
        Ok(())
    }
    fn intersperse_section_hook(
        &mut self,
        module: &mut Module,
        _after: Option<SectionId>,
        before: Option<SectionId>,
    ) -> Result<(), reencode::Error<String>> {
        if !self.globals_written
            && before.is_none_or(|id| u8::from(id) > u8::from(SectionId::Global))
        {
            let mut section = GlobalSection::new();
            self.globals(&mut section);
            module.section(&section);
            self.globals_written = true;
        }
        if !self.exports_written
            && before.is_none_or(|id| u8::from(id) > u8::from(SectionId::Export))
        {
            let mut section = ExportSection::new();
            self.exports(&mut section);
            module.section(&section);
            self.exports_written = true;
        }
        Ok(())
    }
    fn parse_function_body(
        &mut self,
        code: &mut CodeSection,
        body: wasmparser::FunctionBody<'_>,
    ) -> Result<(), reencode::Error<String>> {
        let index = self.next;
        self.next += 1;
        let global = self.base + index as u32;
        let mut local_count = self.params[self.types[index] as usize];
        let mut locals = Vec::new();
        for local in body.get_locals_reader()? {
            let (count, ty) = local?;
            local_count += count;
            locals.push((count, self.val_type(ty)?));
        }
        locals.push((1, ValType::I32));
        let mut f = Function::new(locals);
        let mut pending = 0;
        let mut reader = body.get_operators_reader()?;
        while !reader.eof() {
            let op = reader.read()?;
            let debug = format!("{op:?}");
            let name = debug.split([' ', '{', '(']).next().unwrap();
            let cost = self.costs[name]
                .as_u64()
                .ok_or_else(|| reencode::Error::UserError(format!("未支持算子 {name}")))?;
            // 在控制转移、调用和可能陷阱的操作前结算；纯算术段只插一次。
            let boundary = matches!(
                op,
                Operator::Block { .. }
                    | Operator::Loop { .. }
                    | Operator::If { .. }
                    | Operator::Else
                    | Operator::End
                    | Operator::Br { .. }
                    | Operator::BrIf { .. }
                    | Operator::BrTable { .. }
                    | Operator::Return
                    | Operator::Call { .. }
                    | Operator::CallIndirect { .. }
                    | Operator::Unreachable
            ) || name.contains("Load")
                || name.contains("Store")
                || name.contains("Div")
                || name.contains("Rem")
                || name.contains("Trunc")
                || name.starts_with("Call")
                || name.starts_with("ReturnCall")
                || name.starts_with("Ref")
                || name.starts_with("Throw")
                || name.starts_with("Try")
                || name.starts_with("Catch")
                || name == "Delegate"
                || name == "BrOnNull"
                || name == "BrOnNonNull"
                || name.starts_with("Table")
                || variable_name(&op).is_some();
            if boundary {
                add_const(&mut f, global, pending + cost);
                pending = 0;
                if let Some(key) = variable_name(&op) {
                    let cost = self.costs["variable"][key]
                        .as_u64()
                        .ok_or_else(|| reencode::Error::UserError(format!("变量成本缺失 {key}")))?;
                    add_variable(&mut f, global, local_count, cost);
                }
                f.instruction(&self.instruction(op)?);
            } else {
                f.instruction(&self.instruction(op)?);
                pending += cost;
            }
        }
        code.function(&f);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn run(wat: &str, fuel: u64) -> super::super::super::wasm::WasmRunResult {
        let bytes = wat::parse_str(wat).unwrap();
        let instrumented = instrument(&bytes).unwrap();
        super::super::super::wasm::run_analysis_module(
            &instrumented.bytes,
            &[],
            16,
            fuel,
            1000,
            None,
            &std::collections::HashMap::new(),
            instrumented.body_ranges.len(),
        )
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn empty_loop_consumes_budget_and_retains_partial_counts() {
        let r = run("(module (func (export \"_start\") (loop br 0)))", 10000).await;
        assert_eq!(
            r.status,
            super::super::super::wasm::WasmStatus::TimeLimitExceeded
        );
        assert!(r.analysis_counters[0] > 0);
        assert!(r.analysis_counters[0] < 10000);
    }
    #[tokio::test]
    async fn branch_counts_only_executed_arm() {
        let r = run("(module (func (export \"_start\") i32.const 1 if i32.const 7 drop else i32.const 9 i32.const 8 i32.add drop end))", 10000).await;
        // const + if + const；另一个分支不能预收成本。
        assert_eq!(r.analysis_counters, vec![3]);
    }
    #[tokio::test]
    async fn globals_calls_tables_and_data_indices_are_preserved() {
        let r = run(
            r#"(module
            (memory 1) (data (i32.const 0) "hello")
            (global $g (mut i32) (i32.const 0))
            (type $t (func)) (table 1 funcref) (elem (i32.const 0) $callback)
            (func $callback i32.const 7 global.set $g)
            (func (export "_start") i32.const 0 call_indirect (type $t)
                global.get $g i32.const 7 i32.ne if unreachable end
                i32.const 0 i32.load8_u i32.const 104 i32.ne if unreachable end))"#,
            10000,
        )
        .await;
        assert_eq!(r.status, super::super::super::wasm::WasmStatus::Accepted);
        assert_eq!(r.analysis_counters.len(), 2);
        assert!(r.analysis_counters.iter().all(|c| *c > 0));
    }
    #[tokio::test]
    async fn bulk_memory_cost_uses_original_length_and_preserves_stack() {
        let r = run(
            r#"(module (memory 1)
            (data $d "1234")
            (func (export "_start")
              i32.const 0 i32.const 42 i32.const 100 memory.fill
              i32.const 200 i32.const 0 i32.const 100 memory.copy
              i32.const 400 i32.const 0 i32.const 4 memory.init $d
              i32.const 0 memory.grow drop))"#,
            100000,
        )
        .await;
        assert_eq!(r.status, super::super::super::wasm::WasmStatus::Accepted);
        // fill/copy/init: 3 const + 1 固定 + length；grow: const + 1。
        assert_eq!(r.analysis_counters, vec![218]);
    }
    #[tokio::test]
    async fn attempted_trap_is_partial_and_does_not_charge_following_code() {
        let r = run("(module (func (export \"_start\") i32.const 1 i32.const 0 i32.div_u drop i32.const 123 drop))", 10000).await;
        assert_eq!(
            r.status,
            super::super::super::wasm::WasmStatus::RuntimeError
        );
        assert_eq!(r.analysis_counters, vec![3]);
    }
    #[test]
    fn original_code_cannot_name_or_address_new_counters() {
        let reserved =
            wat::parse_str("(module (global (export \"__noj_analysis_0\") i64 (i64.const 0)))")
                .unwrap();
        assert!(instrument(&reserved).is_err());
        let invalid =
            wat::parse_str("(module (func (export \"_start\") global.get 0 drop))").unwrap();
        assert!(instrument(&invalid).is_err());
    }
    #[tokio::test]
    async fn missing_global_and_export_sections_are_inserted() {
        let bytes = wat::parse_str("(module (func i32.const 7 drop))").unwrap();
        let output = instrument(&bytes).unwrap();
        wasmparser::Validator::new()
            .validate_all(&output.bytes)
            .unwrap();
    }
    #[tokio::test]
    async fn table_variables_and_memory_growth_are_counted() {
        let r = run(
            r#"(module (memory 1 2) (table 4 8 funcref)
          (elem $e funcref (ref.null func))
          (func (export "_start")
            i32.const 0 ref.null func i32.const 2 table.fill 0
            ref.null func i32.const 1 table.grow 0 drop
            i32.const 2 i32.const 0 i32.const 1 table.copy 0 0
            i32.const 0 i32.const 0 i32.const 1 table.init $e
            i32.const 1 memory.grow drop))"#,
            100000,
        )
        .await;
        assert_eq!(r.status, super::super::super::wasm::WasmStatus::Accepted);
        assert!(r.analysis_counters[0] >= 6);
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;
    #[tokio::test]
    async fn initialization_over_memory_limit_is_mle_not_infrastructure_failure() {
        let bytes = wat::parse_str("(module (memory 1024) (func (export \"_start\")))").unwrap();
        let m = instrument(&bytes).unwrap();
        let run = super::super::super::wasm::run_analysis_module(
            &m.bytes,
            &[],
            16,
            10000,
            1000,
            None,
            &std::collections::HashMap::new(),
            1,
        )
        .await
        .unwrap();
        assert_eq!(
            run.status,
            super::super::super::wasm::WasmStatus::MemoryLimitExceeded
        );
        assert!(run.analysis_counters.is_empty());
    }
}
