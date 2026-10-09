//! 分资源池共享准入。所有容量、等待顺序和内存占用在 Redis 中原子协调。
use anyhow::{Context, Result};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Pool {
    #[serde(rename = "oi-wasm")]
    Wasm,
    #[serde(rename = "oi-native")]
    Native,
    #[serde(rename = "ai")]
    Ai,
}
impl Pool {
    pub const ALL: [Self; 3] = [Self::Wasm, Self::Native, Self::Ai];
    pub fn name(self) -> &'static str {
        match self {
            Self::Wasm => "oi-wasm",
            Self::Native => "oi-native",
            Self::Ai => "ai",
        }
    }
    pub fn index(self) -> usize {
        match self {
            Self::Wasm => 0,
            Self::Native => 1,
            Self::Ai => 2,
        }
    }
    pub fn for_task(task: &crate::types::JudgeTask) -> Self {
        match task.runtime_config.as_oi() {
            Some(config) if config.backend == crate::oi::OiBackend::Wasm => Self::Wasm,
            Some(_) => Self::Native,
            None => Self::Ai,
        }
    }
    pub fn validate_task(self, task: &crate::types::JudgeTask) -> Result<()> {
        anyhow::ensure!(
            task.scheduling_version == Some(1),
            "评测调度协议不匹配，请重测"
        );
        anyhow::ensure!(
            task.resource_pool.as_deref() == Some(self.name()) && Self::for_task(task) == self,
            "任务资源池与运行配置不匹配，请重测"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Capacities {
    pub wasm_tasks: u64,
    pub native_tasks: u64,
    pub ai_tasks: u64,
    pub wasm_compile: u64,
    pub wasm_run: u64,
    pub memory_mb: u64,
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub group: String,
    pub enabled: Vec<Pool>,
    pub capacities: Capacities,
}
fn number(name: &str, fallback: u64) -> Result<u64> {
    let value = std::env::var(name)
        .ok()
        .map(|v| v.parse::<u64>())
        .transpose()
        .with_context(|| format!("{name} 必须为正整数"))?
        .unwrap_or(fallback);
    anyhow::ensure!((1..=1024).contains(&value), "{name} 必须在 1..=1024 内");
    Ok(value)
}
pub fn parse_memory_limit(text: &str) -> Option<u64> {
    text.trim()
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && *n < (1_u64 << 60))
}
fn effective_memory_mb() -> Result<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").context("读取宿主内存上限失败")?;
    let mut bytes = text
        .lines()
        .find_map(|line| {
            line.strip_prefix("MemTotal:")?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
        })
        .context("宿主 MemTotal 缺失")?
        .saturating_mul(1024);
    // 同时读取本进程 cgroup 和各级父组；只看根目录可能漏掉 systemd slice 限额。
    if let Ok(groups) = std::fs::read_to_string("/proc/self/cgroup") {
        for line in groups.lines() {
            let mut fields = line.splitn(3, ':');
            let id = fields.next().unwrap_or_default();
            let controllers = fields.next().unwrap_or_default();
            let relative = fields.next().unwrap_or("/").trim_start_matches('/');
            let (root, filename) = if id == "0" && controllers.is_empty() {
                (Path::new("/sys/fs/cgroup"), "memory.max")
            } else if controllers.split(',').any(|v| v == "memory") {
                (Path::new("/sys/fs/cgroup/memory"), "memory.limit_in_bytes")
            } else {
                continue;
            };
            let mut directory = root.join(relative);
            loop {
                if let Ok(value) = std::fs::read_to_string(directory.join(filename)) {
                    if let Some(limit) = parse_memory_limit(&value) {
                        bytes = bytes.min(limit);
                    }
                }
                if directory == root || !directory.pop() || !directory.starts_with(root) {
                    break;
                }
            }
        }
    }
    Ok(bytes / 1024 / 1024)
}
impl Settings {
    pub fn from_env(instance: &str) -> Result<Self> {
        let group = std::env::var("JUDGE_RESOURCE_GROUP")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| instance.to_owned());
        anyhow::ensure!(
            !group.is_empty()
                && group.len() <= 128
                && group
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c)),
            "JUDGE_RESOURCE_GROUP 非法"
        );
        let enabled_text =
            std::env::var("JUDGE_RESOURCE_POOLS").unwrap_or_else(|_| "oi-wasm,oi-native,ai".into());
        let mut enabled = Vec::new();
        for name in enabled_text.split(',').map(str::trim) {
            let pool = Pool::ALL
                .into_iter()
                .find(|pool| pool.name() == name)
                .context("JUDGE_RESOURCE_POOLS 包含未知资源池")?;
            anyhow::ensure!(!enabled.contains(&pool), "资源池重复配置");
            enabled.push(pool);
        }
        let raw = std::env::var("JUDGE_RESOURCE_MEMORY_MB").unwrap_or_else(|_| "auto".into());
        let memory_mb = if raw == "auto" {
            effective_memory_mb()? / 2
        } else {
            raw.parse()
                .context("JUDGE_RESOURCE_MEMORY_MB 必须为 auto 或正整数")?
        };
        anyhow::ensure!(memory_mb > 0, "资源组内存预算必须为正整数");
        Ok(Self {
            group,
            enabled,
            capacities: Capacities {
                wasm_tasks: number("JUDGE_WASM_TASK_CONCURRENCY", 4)?,
                native_tasks: number("JUDGE_NATIVE_TASK_CONCURRENCY", 2)?,
                ai_tasks: number("JUDGE_AI_TASK_CONCURRENCY", 2)?,
                wasm_compile: number("JUDGE_WASM_COMPILE_CONCURRENCY", 2)?,
                wasm_run: number("JUDGE_WASM_CASE_CONCURRENCY", 16)?,
                memory_mb,
            },
        })
    }
}

#[derive(Clone)]
pub struct Scheduler {
    pub settings: Settings,
    client: redis::Client,
    key: String,
}
const TTL_MS: u64 = 60_000;

#[derive(Debug, Clone, Serialize)]
struct Demand {
    kind: String,
    parent: String,
    base: u64,
    headroom: u64,
    memory: u64,
}

// 父任务预留 base+headroom，阶段借用 headroom；并行阶段超出的部分才额外计入。
// 这样已准入任务始终有完成一个阶段的内存，避免所有任务占着数据等待编译的死锁。
const ACQUIRE: &str = r#"
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local demand=cjson.decode(ARGV[2]); local capacity=cjson.decode(ARGV[3]); local id=ARGV[1]
local entries={}; local parents={}; local children={}; local used={}
local actual=0; local rss=redis.call('HGETALL',KEYS[5])
for i=1,#rss,2 do
 local item=cjson.decode(rss[i+1])
 if item.expires<=now then redis.call('HDEL',KEYS[5],rss[i]) else actual=actual+item.mb end
end
if actual>capacity.memory_mb then return 0 end
local raw=redis.call('HGETALL',KEYS[1])
for i=1,#raw,2 do
 local item=cjson.decode(raw[i+1])
 if item.expires<=now then redis.call('HDEL',KEYS[1],raw[i]) else entries[raw[i]]=item end
end
if demand.parent~='' and not entries[demand.parent] then return -2 end
local fair=demand.kind=='run'
if fair then
 redis.call('HSET',KEYS[2],id,cjson.encode({parent=demand.parent,expires=now+tonumber(ARGV[4])}))
 redis.call('PEXPIRE',KEYS[2],tonumber(ARGV[4])*2)
 local live={}; local requests=redis.call('HGETALL',KEYS[2])
 for i=1,#requests,2 do
  local item=cjson.decode(requests[i+1])
  if item.expires<=now or not entries[item.parent] then redis.call('HDEL',KEYS[2],requests[i])
  else live[item.parent]=true end
 end
 local turns=redis.call('ZRANGE',KEYS[3],0,-1)
 for _,parent in ipairs(turns) do if not live[parent] then redis.call('ZREM',KEYS[3],parent) end end
 redis.call('ZADD',KEYS[3],'NX',0,demand.parent); redis.call('PEXPIRE',KEYS[3],tonumber(ARGV[4])*2)
 local first=redis.call('ZRANGE',KEYS[3],0,0)
 if first[1]~=demand.parent then return 0 end
end
demand.expires=now+tonumber(ARGV[4]); entries[id]=demand
for token,item in pairs(entries) do
 used[item.kind]=(used[item.kind] or 0)+1
 if item.parent=='' then parents[token]=item else children[item.parent]=(children[item.parent] or 0)+item.memory end
end
local memory=0
for token,item in pairs(parents) do memory=memory+item.base+math.max(item.headroom,children[token] or 0) end
for parent,value in pairs(children) do if not parents[parent] then memory=memory+value end end
local limits={['oi-wasm']=capacity.wasm_tasks,['oi-native']=capacity.native_tasks,['ai']=capacity.ai_tasks,
 ['compile']=capacity.wasm_compile,['run']=capacity.wasm_run}
local permitted=memory<=capacity.memory_mb
for kind,count in pairs(used) do if count>(limits[kind] or 0) then permitted=false end end
-- 运行容量已满时不消耗轮次；只在实际授予或内存不适配时轮转，避免轮次受轮询频率影响。
if fair and (permitted or (used['run'] or 0)<=capacity.wasm_run) then
 local turn=redis.call('INCR',KEYS[4]); redis.call('PEXPIRE',KEYS[4],tonumber(ARGV[4])*2)
 redis.call('ZADD',KEYS[3],turn,demand.parent)
end
if not permitted then return 0 end
if fair then redis.call('HDEL',KEYS[2],id) end
redis.call('HSET',KEYS[1],id,cjson.encode(demand)); redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[4])*2)
return 1
"#;

impl Scheduler {
    /// 仅在所有 Worker 心跳和执行租约都已排空后解除容量配置锁。
    // 独立维护入口使用；生产 Worker 不能在运行中解除配置锁。
    #[allow(dead_code)]
    pub async fn reset_group_config(
        client: &redis::Client,
        prefix: &str,
        group: &str,
    ) -> Result<bool> {
        let key = format!("{prefix}:resources:{group}");
        let mut conn = client.get_multiplexed_async_connection().await?;
        let result: i64 = redis::Script::new(
            r#"
            local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
            for _,k in ipairs({KEYS[1],KEYS[2]}) do
                local entries=redis.call('HGETALL',k)
                for i=1,#entries,2 do
                    local ok,item=pcall(cjson.decode,entries[i+1])
                    if not ok or not item.expires or item.expires>now then return 0 end
                end
            end
            redis.call('DEL',KEYS[1],KEYS[2],KEYS[3],KEYS[4],KEYS[5],KEYS[6]); return 1
        "#,
        )
        .key(&key)
        .key(format!("{key}:rss"))
        .key(format!("{key}:config"))
        .key(format!("{key}:requests"))
        .key(format!("{key}:turns"))
        .key(format!("{key}:sequence"))
        .invoke_async(&mut conn)
        .await?;
        Ok(result == 1)
    }
    pub fn resource_key(&self) -> &str {
        &self.key
    }
    pub async fn connect(client: redis::Client, settings: Settings, prefix: &str) -> Result<Self> {
        let key = format!("{prefix}:resources:{}", settings.group);
        let mut conn = client.get_multiplexed_async_connection().await?;
        let config_key = format!("{key}:config");
        let expected = serde_json::to_string(&settings.capacities)?;
        let _: bool = conn.set_nx(&config_key, &expected).await?;
        let actual: String = conn.get(&config_key).await?;
        anyhow::ensure!(
            actual == expected,
            "资源组容量或内存预算与其他 Worker 不一致；排空并协调更新后再启动"
        );
        Ok(Self {
            client,
            settings,
            key,
        })
    }
    async fn try_demand(&self, demand: &Demand) -> Result<Option<Lease>> {
        self.try_demand_at(demand, &uuid::Uuid::new_v4().to_string())
            .await
    }
    async fn try_demand_at(&self, demand: &Demand, id: &str) -> Result<Option<Lease>> {
        anyhow::ensure!(
            demand
                .base
                .saturating_add(demand.headroom)
                .max(demand.memory)
                <= self.settings.capacities.memory_mb,
            "任务最低资源需求超过资源组内存预算"
        );
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let result: i64 = redis::Script::new(ACQUIRE)
            .key(&self.key)
            .key(format!("{}:requests", self.key))
            .key(format!("{}:turns", self.key))
            .key(format!("{}:turn-sequence", self.key))
            .key(format!("{}:rss", self.key))
            .arg(id)
            .arg(serde_json::to_string(demand)?)
            .arg(serde_json::to_string(&self.settings.capacities)?)
            .arg(TTL_MS)
            .invoke_async(&mut conn)
            .await?;
        anyhow::ensure!(result != -2, "父任务资源租约已失效");
        Ok((result == 1).then(|| Lease::new(self.clone(), id.to_owned())))
    }
    pub async fn try_task(
        &self,
        pool: Pool,
        base_mb: u64,
        headroom_mb: u64,
    ) -> Result<Option<Lease>> {
        self.try_demand(&Demand {
            kind: pool.name().into(),
            parent: String::new(),
            base: base_mb,
            headroom: headroom_mb,
            memory: 0,
        })
        .await
    }
    pub async fn stage(&self, parent: &Lease, kind: &str, memory_mb: u64) -> Result<Lease> {
        anyhow::ensure!(kind == "compile" || kind == "run", "阶段名称非法");
        let id = uuid::Uuid::new_v4().to_string();
        let _waiting = WaitingRequest {
            scheduler: self.clone(),
            id: id.clone(),
        };
        loop {
            anyhow::ensure!(!parent.lost(), "资源租约已失效，停止运行");
            if let Some(lease) = self
                .try_demand_at(
                    &Demand {
                        kind: kind.into(),
                        parent: parent.id.clone(),
                        base: 0,
                        headroom: 0,
                        memory: memory_mb,
                    },
                    &id,
                )
                .await?
            {
                return Ok(lease);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

struct WaitingRequest {
    scheduler: Scheduler,
    id: String,
}
impl Drop for WaitingRequest {
    fn drop(&mut self) {
        let client = self.scheduler.client.clone();
        let key = format!("{}:requests", self.scheduler.key);
        let id = self.id.clone();
        tokio::spawn(async move {
            if let Ok(mut conn) = client.get_multiplexed_async_connection().await {
                let _: redis::RedisResult<usize> = conn.hdel(key, id).await;
            }
        });
    }
}

/// 租约只属于本次任务；续租丢失通过独立标志触发任务中止。
pub struct Lease {
    pub id: String,
    scheduler: Scheduler,
    lost: Arc<AtomicBool>,
    renewal: tokio::task::JoinHandle<()>,
}
impl Lease {
    pub async fn try_resize_task(&self, pool: Pool, base: u64, headroom: u64) -> Result<bool> {
        anyhow::ensure!(!self.lost(), "任务资源租约已失效");
        anyhow::ensure!(
            base.saturating_add(headroom) <= self.scheduler.settings.capacities.memory_mb,
            "任务最低资源需求超过资源组内存预算"
        );
        let demand = Demand {
            kind: pool.name().into(),
            parent: String::new(),
            base,
            headroom,
            memory: 0,
        };
        let mut conn = self
            .scheduler
            .client
            .get_multiplexed_async_connection()
            .await?;
        let result: i64 = redis::Script::new(ACQUIRE)
            .key(&self.scheduler.key)
            .key(format!("{}:requests", self.scheduler.key))
            .key(format!("{}:turns", self.scheduler.key))
            .key(format!("{}:turn-sequence", self.scheduler.key))
            .key(format!("{}:rss", self.scheduler.key))
            .arg(&self.id)
            .arg(serde_json::to_string(&demand)?)
            .arg(serde_json::to_string(&self.scheduler.settings.capacities)?)
            .arg(TTL_MS)
            .invoke_async(&mut conn)
            .await?;
        Ok(result == 1)
    }
    pub async fn shrink_base(&self, memory_mb: u64) -> Result<()> {
        let mut conn = self
            .scheduler
            .client
            .get_multiplexed_async_connection()
            .await?;
        let result: i64 = redis::Script::new(
            r#"local raw=redis.call('HGET',KEYS[1],ARGV[1]); if not raw then return 0 end
            local item=cjson.decode(raw); item.base=math.min(item.base,tonumber(ARGV[2]));
            redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(item)); return 1"#,
        )
        .key(&self.scheduler.key)
        .arg(&self.id)
        .arg(memory_mb)
        .invoke_async(&mut conn)
        .await?;
        anyhow::ensure!(result == 1, "资源租约已失效");
        Ok(())
    }
    fn new(scheduler: Scheduler, id: String) -> Self {
        let lost = Arc::new(AtomicBool::new(false));
        let flag = lost.clone();
        let client = scheduler.client.clone();
        let key = scheduler.key.clone();
        let token = id.clone();
        let renewal = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_secs(10));
            ticks.tick().await;
            loop {
                ticks.tick().await;
                let renew = async {
                    let mut conn = client.get_multiplexed_async_connection().await?;
                    redis::Script::new(r#"local v=redis.call('HGET',KEYS[1],ARGV[1]); if not v then return 0 end
                        local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); local item=cjson.decode(v)
                        if item.expires<=now then return 0 end; item.expires=now+tonumber(ARGV[2]);
                        redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(item)); redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[2])*2); return 1"#)
                        .key(&key).arg(&token).arg(TTL_MS).invoke_async::<i64>(&mut conn).await
                };
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(5), renew).await,
                    Ok(Ok(1))
                ) {
                    flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
        });
        Self {
            id,
            scheduler,
            lost,
            renewal,
        }
    }
    pub fn lost(&self) -> bool {
        self.lost.load(Ordering::Relaxed)
    }
    pub fn loss_flag(&self) -> Arc<AtomicBool> {
        self.lost.clone()
    }
    pub async fn wait_lost(&self) {
        while !self.lost() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.renewal.abort();
        let client = self.scheduler.client.clone();
        let key = self.scheduler.key.clone();
        let id = self.id.clone();
        // 普通路径立即清理；Redis 不可用或进程被杀时，服务端时间租约仍会过期。
        tokio::spawn(async move {
            if let Ok(mut conn) = client.get_multiplexed_async_connection().await {
                let _: redis::RedisResult<usize> = conn.hdel(key, id).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mismatched_protocol_or_pool_is_rejected_without_fallback() {
        let mut task: crate::types::JudgeTask = serde_json::from_str(include_str!(
            "../../noj-tests/fixtures/judge-task-oi.contract.json"
        ))
        .unwrap();
        assert!(Pool::Wasm.validate_task(&task).is_ok());
        assert!(Pool::Ai.validate_task(&task).is_err());
        task.resource_pool = Some("ai".into());
        assert!(Pool::Wasm.validate_task(&task).is_err());
        task.resource_pool = Some("oi-wasm".into());
        task.scheduling_version = None;
        assert!(Pool::Wasm.validate_task(&task).is_err());
        task.scheduling_version = Some(2);
        assert!(Pool::Wasm.validate_task(&task).is_err());
    }
    #[test]
    fn memory_limit_handles_unlimited_and_v1_sentinels() {
        assert_eq!(parse_memory_limit("max"), None);
        assert_eq!(parse_memory_limit("9223372036854771712"), None);
        assert_eq!(
            parse_memory_limit("4294967296\n"),
            Some(4 * 1024 * 1024 * 1024)
        );
    }
}
