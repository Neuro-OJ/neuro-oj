## ADDED Requirements

### Requirement: 客观题提交计入竞赛排名

系统 SHALL 将客观题套卷提交纳入竞赛排名计算：竞赛题单中的 O 型套卷，其 objective_submissions 提交 SHALL 参与 evaluated_submissions 计算（与编程题提交 UNION），满分卷映射为 `status='Accepted'`、非满分映射为 `'WrongAnswer'`，提交时间取客观题提交创建时间。三种赛制（ICPC 罚时 / IOI / OI 总分）的既有排名规则 SHALL 对客观题提交同样生效。

#### Scenario: 竞赛中客观题满分计入 AC
- **WHEN** ICPC 竞赛中参赛者对套卷提交答案且卷面满分
- **THEN** 该套卷在该参赛者名下计为已解（solved 计数 +1），罚时按提交时间计算

#### Scenario: 竞赛中客观题非满分视为 WA
- **WHEN** ICPC 竞赛中参赛者对套卷提交答案但卷面非满分
- **THEN** 该提交记为失败尝试（与 WA 同等对待），不影响 solved 计数

#### Scenario: 竞赛客观题未提交不计排名
- **WHEN** 参赛者未提交某套卷
- **THEN** 该套卷在该参赛者名下无任何排名影响
