//! 来源以受控 lld 映射的实际对象为准；名称只在来源确认后用于 IO 候选标签。
use super::super::{standard, toolchain};
use anyhow::{Context, Result};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::{Component, Path},
};

#[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Contestant,
    IoCandidate,
    OtherSdk,
    Unconfirmed,
}
#[derive(Clone, Debug, Serialize)]
pub struct Origin {
    pub function_index: u32,
    pub category: Category,
    pub symbol: String,
    pub object: String,
    pub object_sha256: Option<String>,
}

fn io_candidate(symbol: &str) -> bool {
    [
        "num_get",
        "num_put",
        "__stdinbuf",
        "__stdoutbuf",
        "basic_istream",
        "basic_ostream",
        "basic_filebuf",
    ]
    .iter()
    .any(|pattern| symbol.contains(pattern))
        || matches!(
            symbol,
            "read"
                | "readv"
                | "write"
                | "writev"
                | "fread"
                | "fwrite"
                | "fgetc"
                | "getc"
                | "getchar"
                | "fputc"
                | "putc"
                | "putchar"
                | "fflush"
                | "scanf"
                | "fscanf"
                | "printf"
                | "fprintf"
                | "strtoll"
                | "strtoull"
                | "strtol"
                | "strtoul"
        )
}

// 解析 SDK ar 的成员内容，支持 GNU 长名称及 BSD 扩展名称。
fn archive_members(bytes: &[u8]) -> Result<BTreeMap<String, Option<String>>> {
    anyhow::ensure!(bytes.starts_with(b"!<arch>\n"), "SDK 库不是普通 ar 归档");
    let mut offset = 8;
    let mut names = Vec::new();
    let mut result = BTreeMap::new();
    while offset < bytes.len() {
        let header = bytes.get(offset..offset + 60).context("归档头不完整")?;
        anyhow::ensure!(&header[58..60] == b"`\n", "归档头非法");
        let size: usize = std::str::from_utf8(&header[48..58])?.trim().parse()?;
        offset += 60;
        let mut body = bytes.get(offset..offset + size).context("归档成员不完整")?;
        let name = std::str::from_utf8(&header[..16])?.trim();
        let resolved = if name == "//" {
            names = body.to_vec();
            None
        } else if name == "/" || name == "/SYM64/" {
            None
        } else if let Some(length) = name.strip_prefix("#1/") {
            let length: usize = length.parse()?;
            let label = std::str::from_utf8(body.get(..length).context("BSD 名称不完整")?)?
                .trim_end_matches('\0')
                .to_string();
            body = &body[length..];
            Some(label)
        } else if let Some(index) = name.strip_prefix('/') {
            let index: usize = index.parse()?;
            let tail = names.get(index..).context("GNU 名称索引非法")?;
            let end = tail
                .iter()
                .position(|&b| b == b'\n')
                .context("GNU 名称不完整")?;
            Some(
                std::str::from_utf8(&tail[..end])?
                    .trim_end_matches('/')
                    .to_string(),
            )
        } else {
            Some(name.trim_end_matches('/').to_string())
        };
        if let Some(name) = resolved {
            // lld 映射没有归档成员序号；同名成员不可唯一确认，保守留空。
            result
                .entry(name)
                .and_modify(|digest| *digest = None)
                .or_insert_with(|| Some(standard::hash(body)));
        }
        offset += size + size % 2;
    }
    Ok(result)
}

pub fn resolve(
    compilation: &super::super::wasm_compile::AnalysisCompilation,
    ranges: &[std::ops::Range<usize>],
    imported: u32,
) -> Result<Vec<Origin>> {
    let settings = toolchain::compiler_settings()?;
    let components = toolchain::expected_components();
    let expected = components["files"].as_object().context("SDK 清单缺失")?;
    let mut records: BTreeMap<(usize, usize), Vec<(String, String)>> = BTreeMap::new();
    let mut code = false;
    for line in compilation.link_map.lines() {
        let tokens: Vec<_> = line.split_whitespace().collect();
        if tokens.len() < 4 {
            continue;
        }
        if tokens[3] == "CODE" {
            code = true;
            continue;
        }
        if code
            && tokens.len() == 4
            && tokens[0] == "-"
            && matches!(
                tokens[3],
                "DATA" | "CUSTOM" | "ELEMENT" | "DATACOUNT" | "TAG"
            )
        {
            code = false;
        }
        if !code {
            continue;
        }
        let Ok(offset) = usize::from_str_radix(tokens[1], 16) else {
            continue;
        };
        let Ok(size) = usize::from_str_radix(tokens[2], 16) else {
            continue;
        };
        // 前三列是数字；余下整段保留含空格的真实路径。
        let mut cursor = 0;
        for _ in 0..3 {
            cursor += line[cursor..]
                .find(|c: char| !c.is_whitespace())
                .unwrap_or(0);
            cursor += line[cursor..]
                .find(char::is_whitespace)
                .unwrap_or(line.len() - cursor);
        }
        let rest = line[cursor..].trim();
        if let Some((object, symbol)) = rest.rsplit_once(":(") {
            if let Some(symbol) = symbol.strip_suffix(')') {
                records
                    .entry((offset, size))
                    .or_default()
                    .push((object.to_string(), symbol.to_string()));
            }
        }
    }
    let mut archives = BTreeMap::new();
    let mut result = Vec::new();
    // lld 的 CODE Off 在最终长度 LEB 收缩前记录；相对函数偏移和尺寸保持不变。
    // 仅在整段函数数量、每个尺寸和连续偏移一致时接受这个统一偏移修正。
    let ordered: Vec<_> = records.keys().copied().collect();
    let correction = ordered
        .first()
        .zip(ranges.first())
        .and_then(|((offset, size), range)| range.end.checked_sub(offset.checked_add(*size)?));
    let verified = ordered.len() == ranges.len()
        && correction.is_some_and(|delta| {
            ordered.iter().zip(ranges).all(|((offset, size), range)| {
                offset
                    .checked_add(*size)
                    .and_then(|end| end.checked_add(delta))
                    == Some(range.end)
                    && offset
                        .checked_add(delta)
                        .is_some_and(|start| start < range.start && range.start - start <= 5)
            })
        });
    for (index, range) in ranges.iter().enumerate() {
        let mut origin = Origin {
            function_index: imported + index as u32,
            category: Category::Unconfirmed,
            symbol: String::new(),
            object: "<unconfirmed>".into(),
            object_sha256: None,
        };
        // lld 范围包含 body 长度的 LEB 前缀，parser 范围从局部变量声明开始。
        let matches: Vec<_> = records
            .iter()
            .filter(|((offset, size), _)| {
                verified
                    && offset
                        .checked_add(*size)
                        .and_then(|end| end.checked_add(correction.unwrap()))
                        == Some(range.end)
            })
            .flat_map(|(_, values)| values)
            .collect();
        if matches.len() == 1 {
            let (object, symbol) = matches[0];
            origin.symbol = symbol.clone();
            if Path::new(object) == compilation.workspace.join("main.o") {
                origin.category = Category::Contestant;
                origin.object = "contestant/main.o".into();
                origin.object_sha256 = Some(standard::hash(&compilation.object));
            } else if object != "<internal>" {
                let (path, member) = if let Some((path, member)) = object.rsplit_once('(') {
                    (path, member.strip_suffix(')'))
                } else {
                    (object.as_str(), None)
                };
                if let Ok(path) = Path::new(path).canonicalize() {
                    if let Ok(relative) = path.strip_prefix(&settings.root) {
                        let label = relative.to_string_lossy().into_owned();
                        if relative
                            .components()
                            .all(|c| matches!(c, Component::Normal(_)))
                            && expected.contains_key(&label)
                        {
                            let digest = if let Some(member) = member {
                                if !archives.contains_key(&label) {
                                    archives.insert(
                                        label.clone(),
                                        archive_members(&std::fs::read(&path)?)?,
                                    );
                                }
                                archives[&label].get(member).cloned().flatten()
                            } else {
                                expected[&label].as_str().map(str::to_string)
                            };
                            if let Some(digest) = digest {
                                origin.category = if io_candidate(symbol) {
                                    Category::IoCandidate
                                } else {
                                    Category::OtherSdk
                                };
                                origin.object = format!(
                                    "sdk/{label}{}",
                                    member.map(|s| format!("({s})")).unwrap_or_default()
                                );
                                origin.object_sha256 = Some(digest);
                            }
                        }
                    }
                }
            }
        }
        result.push(origin);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_only_choose_candidate_after_trust() {
        assert!(io_candidate("_ZNSt3__17num_getIcE3getEv"));
        assert!(!io_candidate("memcpy"));
        assert!(!io_candidate("sort"));
    }
    #[test]
    fn malformed_archive_is_rejected() {
        assert!(archive_members(b"!<thin>\n").is_err());
        assert!(archive_members(b"!<arch>\ntruncated").is_err());
    }
}
