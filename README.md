# 馆藏科研取样决策服务

面向博物馆科研取样申请、稀缺材料预留和成果返还的 TypeScript 后端服务。

服务围绕以下业务约束实现：

- **申请六要素**：研究目的、取样位置、预计质量、检测方法、成果返还承诺、保密期限。
- **额度只减不双占**：送审通过额度校验即预占；拒绝、评审超时（72h）、撤回才释放；并发送审经互斥队列串行化，不可能预占同一份材料。
- **关键参数改版本**：送审后修改目的/位置/质量/方法/承诺/保密期产生新版本，旧版本与旧步骤关闭留痕，预占按新版本重算。
- **实际取样偏差**：实际量与批准量不一致时追加偏差记录、重算余量，批准结论不变。
- **委员回避**：同机构自动回避 + 显式回避关系；不足法定人数挂起且不预占，补员后重新路由。
- **可追溯**：管理员可从标本剩余质量追溯历次切割、每份决定与采用的规则版本、成果到期状态。

## 运行

需要 Node.js 22+。`npm ci` 安装依赖，`npm test` 编译并运行测试，`npm start` 启动（默认 8000 端口，`GET /health` 健康检查）。也可 `docker compose up --build`。

运行时状态写入 `.runtime/state.json`，可用环境变量覆盖：`SAMPLING_STATE_FILE`、`SAMPLING_REFERENCE_DIR`、`PORT`、`HOST`、`SWEEP_INTERVAL_MS`。

## 身份

所有 `/api/*` 请求需带头 `x-user-id: <用户ID>`（演示用的简化鉴权）；管理员接口仅 `role=admin` 可访问。种子用户见 `reference/seed.json`（含三校申请人、4 名委员、主任、管理员）。

## 审批路径

| 情形 | 路径 |
| --- | --- |
| 加固区 < 500mg | 单委员 |
| 加固区 ≥ 500mg | 三人委员会多数 + 主任 |
| 未加固区 | 三人委员会全票 + 主任 |
| 未加固区且方法破坏性过高（micro_drill/section） | 系统驳回 |
| 超标本余量 50% / 未加固区超余量 25% / 超分区余量 | 配额驳回 |

## HTTP 接口

申请人/委员：

- `POST /api/applications` 创建申请（草稿）
- `POST /api/applications/:id/submit` 送审（触发路由与预占）
- `POST /api/applications/:id/amend` 送审后修改关键参数（新版本）
- `POST /api/applications/:id/withdraw` 撤回（释放预占）
- `GET /api/applications` 本人申请列表
- `GET /api/applications/:id` 本人进度（步骤、补件项、决定、偏差、成果状态、事件）
- `POST /api/applications/:id/supplements` 委员要求补件 `{items:[...], reason}`
- `POST /api/supplements/:sid/response` 申请人补交 `{applicationId, response}`
- `POST /api/supplements/:sid/accept` 委员受理/退回 `{applicationId, accept, comment}`
- `POST /api/applications/:id/decisions` 投票 `{vote: approve|reject, comment}`
- `POST /api/applications/:id/cuttings` 登记实际取样 `{actualMassMg, sampledAt?}`
- `POST /api/applications/:id/result/receive` 登记成果返还
- `GET /api/enums`、`GET /api/rules`

管理员：

- `GET /api/admin/specimens/:id/trace` **余量追溯**（余量/预占明细/各版本规则/决定/切割/偏差/成果到期）
- `GET /api/admin/applications` 全部申请
- `POST /api/admin/expire-timeouts` 手动扫描超时
- `POST /api/admin/applications/:id/retry-routing` 补员后重新路由
- `POST /api/admin/applications/:id/deviations/:did/annotate` 标注超差处置
- `POST /api/admin/specimens`、`POST /api/admin/users`、`POST /api/admin/recusals` 基础数据维护

## 示例

```bash
curl -X POST localhost:8000/api/applications -H 'x-user-id: u_app_zhou' \
  -H 'content-type: application/json' -d '{
    "specimenId":"spm_fossil_001","purpose":"骨组织学对比",
    "zoneId":"zone_unreinforced_b","plannedMassMg":200,"method":"powder",
    "deliverable":"原始数据与报告","resultDueDays":90,"confidentialityMonths":24
  }'
```

## 代码结构

- `src/domain/types.ts` 领域模型与枚举
- `src/domain/rules.ts` 版本化规则（阈值、破坏性、评审模式）
- `src/domain/quota.ts` 余量核算与回避判定
- `src/domain/store.ts` 原子落盘 + 变更互斥队列（失败回滚快照）
- `src/domain/service.ts` 申请生命周期、版本、计票、偏差与成果
- `src/app.ts` HTTP 路由与校验；`src/bootstrap.ts` 装配与种子；`src/index.ts` 入口
- `tests/` 领域测试 18 项 + HTTP 集成测试 3 项 + 健康检查 2 项
