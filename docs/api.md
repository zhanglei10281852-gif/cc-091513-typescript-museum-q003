# HTTP API

所有接口返回 JSON。身份通过请求头传递（演示/内网部署用，生产环境应换成网关注名身份）：

| 请求头 | 说明 |
| --- | --- |
| `x-user-id` | 用户稳定标识，必填 |
| `x-user-roles` | 角色，逗号分隔：`researcher`、`reviewer`、`admin` |

申请参数（研究目的、取样位置等）既可平铺在请求体，也可放在 `draft` 对象内。错误响应统一为 `{ error, message, details? }`，状态码：400 参数错误、401 未鉴权、403 无权/回避、404 不存在、409 状态冲突（含材料余量不足）。

## 通用

- `GET /health` — 健康检查，返回服务名与当前规则版本。

## 研究员

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /applications` | 创建申请（草稿 v1）。body：`specimenId`、`applicantOrgId`、申请参数 |
| `POST /applications/:id/revise` | 修改申请；送审前就地改草稿，送审后关键参数变化生成新版本并释放旧预留 |
| `POST /applications/:id/submit` | 送审；原子校验余量并预占，返回 `reviewPath` 与 `hold`；回避阻塞时不预占 |
| `POST /applications/:id/withdraw` | 撤回（草稿/在审均可），释放预留 |
| `POST /applications/:id/supplements/:itemId` | 回应补件，body：`{ response }` |
| `GET /me/applications` | 本人全部申请的进度、当前阶段、待处理补件项、成果时效 |
| `GET /applications/:id` | 申请详情（本人、委员、管理员可见） |

申请参数字段：

```json
{
  "purpose": "研究目的",
  "zoneId": "Z-UNREINFORCED",
  "locationNotes": "标本腹侧未加固表层第 3 节",
  "estimatedMassMg": 300,
  "method": "micro_drill",
  "deliverables": ["检测原始数据", "剩余粉末返还"],
  "resultReturnBy": "2027-01-15T00:00:00.000Z",
  "confidentialityMonths": 12
}
```

`method` 取值：`surface_swab` / `micro_drill` / `section` / `powder`。

## 委员

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /reviewer/queue` | 轮到自己表决的在审申请；被回避的申请以 `recused: true` 列出但不能投票 |
| `POST /applications/:id/votes` | 投票：`{ "value": "approve"|"reject"|"request_changes", "comment"?, "supplementField"?, "supplementNote"? }` |
| `POST /reviewer/sweep` | 巡检：SLA 超时的在审件自动拒绝并释放预留；批准过期未取样释放预留 |
| `POST /reviewer/refresh-results` | 刷新成果 `due`/`overdue` 派生状态 |

规则（规则版本 1.0.0）：已加固区且 ≤500mg 走独任初审；未加固区或 >500mg 上委员会（满 3 人成会、满 3 票即决、赞成须严格多于反对）；取样后将跌破 200mg 安全库存追加主任签批。

## 管理员

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /admin/specimens` | 建立标本与分区（`zones[].reinforced`、`initialMassMg`） |
| `POST /admin/specimens/:id/zones` | 追加分区 |
| `PUT /admin/reviewers/:id` | 登记/更新委员（`orgId`、`isDirector`、`conflictUserIds`、`conflictOrgIds`） |
| `POST /admin/applications/:id/regenerate-path` | 增补委员后重建被回避阻塞的路径并补做预留 |
| `POST /admin/applications/:id/cuttings` | 登记实际取样：`{ actualMassMg, actualMethod, sampledAt?, note? }`；追加偏差记录、按实际量结算预留、重算余量；批准结论不变 |
| `POST /admin/applications/:id/result-received` | 登记成果返还接收 |
| `GET /admin/trace?specimenId=` | 全量追溯：每分区初始/已耗/在审预占/实物余量/可预占量、全部预留与切割偏差、每个申请的历次版本、决定记录（批准量、批准编号、保密期限、规则版本、表决快照）、成果时效 |

## 典型流程

1. 三所高校各自 `POST /applications` 后并发送审；互斥区保证只有余量允许的申请预占成功，其余得到 `409 material_unavailable`。
2. 委员按 `GET /reviewer/queue` 投票；需要补充材料时投 `request_changes`，研究员在 `GET /me/applications` 看到补件项并回应。
3. 批准后管理员登记实际切割；系统追加偏差记录（超 ±10% 标记 `withinTolerance:false`），余量按实际质量重算。
4. 管理员随时通过 `GET /admin/trace` 从剩余质量回溯全部决定、切割、预留释放原因、成果到期状态与规则版本。
