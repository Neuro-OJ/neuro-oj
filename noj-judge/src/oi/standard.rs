//! NOJ 统一 WASM 标准：内置、版本化，不读取实例配置。
use super::OiCostProfile;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn manifest() -> Value {
    serde_json::from_str(include_str!("noj-wasm-v1.json")).expect("内置标准必须是合法 JSON")
}

pub fn profile() -> OiCostProfile {
    let standard = manifest();
    serde_json::from_value(json!({
        "schema_version": 1, "runtime_version": "wasmtime-49", "costs": {"default":1},
        "variable_costs": standard["operator_costs"]["variable"], "io_fuel_per_byte": 1,
        "fuel_per_ms": standard["fuel_per_ms"], "hash": standard["hash"],
        "toolchain": standard["toolchain"], "benchmark": standard["id"]
    }))
    .expect("内置成本快照必须合法")
}

pub fn validate_profile(value: &OiCostProfile) -> anyhow::Result<()> {
    if value != &profile() {
        anyhow::bail!("WASM 任务使用旧成本表或不匹配的标准，请重测");
    }
    if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        anyhow::bail!("noj-wasm-v1 仅支持 Linux amd64");
    }
    Ok(())
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(&map[*key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 每个 guest 独立的固定随机流；计数器和读取位置不跨测试点共享。
pub struct GuestRandom {
    seed: [u8; 32],
    counter: u64,
    block: [u8; 32],
    offset: usize,
}
impl GuestRandom {
    pub fn new() -> Self {
        Self {
            seed: serde_json::from_value(manifest()["random_bytes"].clone()).expect("固定随机种子"),
            counter: 0,
            block: [0; 32],
            offset: 32,
        }
    }
    fn read(&mut self, bytes: &mut [u8]) {
        for byte in bytes {
            if self.offset == 32 {
                let mut digest = Sha256::new();
                digest.update(self.seed);
                digest.update(self.counter.to_le_bytes());
                self.block = digest.finalize().into();
                self.counter = self.counter.checked_add(1).expect("随机流计数器耗尽");
                self.offset = 0;
            }
            *byte = self.block[self.offset];
            self.offset += 1;
        }
    }
}
impl Default for GuestRandom {
    fn default() -> Self {
        Self::new()
    }
}
impl rand_core::TryRng for GuestRandom {
    type Error = std::convert::Infallible;
    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        let mut bytes = [0; 4];
        self.read(&mut bytes);
        Ok(u32::from_le_bytes(bytes))
    }
    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        let mut bytes = [0; 8];
        self.read(&mut bytes);
        Ok(u64::from_le_bytes(bytes))
    }
    fn try_fill_bytes(&mut self, bytes: &mut [u8]) -> Result<(), Self::Error> {
        self.read(bytes);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_standard_matches_runtime_and_digest() {
        let mut standard = manifest();
        let expected = standard.as_object_mut().unwrap().remove("hash").unwrap();
        assert_eq!(
            hash(canonical_json(&standard).as_bytes()),
            expected.as_str().unwrap()
        );
        assert_eq!(
            standard["operator_costs"],
            serde_json::to_value(wasmtime::OperatorCost::default()).unwrap()
        );
        assert_eq!(profile().fuel_per_ms, 1_000_000.0);
        validate_profile(&profile()).unwrap();
    }
    #[test]
    fn rejects_legacy_or_modified_cost_profile() {
        let mut legacy = profile();
        legacy.fuel_per_ms = 10.0;
        assert!(validate_profile(&legacy).is_err());
        legacy = profile();
        legacy.hash = "a".repeat(64);
        assert!(validate_profile(&legacy).is_err());
    }
}
