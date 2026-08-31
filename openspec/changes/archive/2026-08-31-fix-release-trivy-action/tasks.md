## 1. Release workflow

- [x] 1.1 将 `.github/workflows/release.yml` 中漏洞扫描和 SBOM 步骤更新到已验证可用的固定 Trivy Action 版本，并确认现有扫描输入保持不变

## 2. 供应链回归检查

- [x] 2.1 在 `scripts/release/check-supply-chain.sh` 增加 Trivy Action 版本约束，并在 `scripts/release/test-supply-chain.sh` 增加有效/失效引用测试

## 3. 验证

- [x] 3.1 运行 Shell 语法、供应链正负向测试、OpenSpec 严格校验和 workflow/actionlint 检查，并记录结果
