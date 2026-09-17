# 馆藏科研取样决策服务

面向博物馆科研取样申请、稀缺材料预留和成果返还的 TypeScript 后端服务。

服务围绕四条硬规则构建：申请材料的**预留互斥**（并发申请不能预占同一份材料）、送审后关键参数改动的**版本留痕**、预留仅在拒绝/超时/撤回时**释放**、实际取样偏差只**追加记录并重算余量**而不改批结论。委员回避关系决定评审路径（独任初审 / 委员会 / 主任签批），管理员可从每一毫克剩余质量追溯全部决定、切割、预留与成果状态。

## 运行

需要 Node.js 22 或更高版本。执行 `npm ci` 安装依赖，`npm test` 完成编译与测试，`npm start` 启动已编译服务。服务默认监听 8000 端口，访问 `GET /health` 可确认进程状态。也可以使用 `docker compose up --build` 启动容器。

- 运行时状态默认持久化到 `.runtime/state.json`（可用 `STATE_FILE` 覆盖），优雅退出时落盘、启动时回放。
- 首次启动会写入一块演示标本（含已加固区与仅存未加固区）和 5 名委员，便于直接演练。

## 文档

- [领域规则与不变量](docs/domain.md)
- [HTTP API](docs/api.md)
- 公开枚举：[reference/domain.json](reference/domain.json)

## 代码结构

```
src/domain/
  types.ts      领域模型（申请/版本/预留/切割/偏差/路径）
  rules.ts      规则阈值与规则版本
  clock.ts      时间与标识工具
  errors.ts     稳定错误码
  store.ts      互斥变更区 + 事件流 + JSON 持久化
  inventory.ts  余量核算（从初始质量与切割记录重算）
  review.ts     回避过滤与评审路径生成
  decision.ts   申请生命周期、投票、超时、切割、成果
  views.ts      研究员/委员/管理员读模型
src/app.ts      HTTP 路由与鉴权
src/index.ts    装配、种子数据、启停持久化
tests/          领域规则测试 + HTTP 集成测试
```
