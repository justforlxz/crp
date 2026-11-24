# CRP 提测平台（Release Hub）

在 CRP 之上补三层能力：项目化的提测归属、按依赖自动排队构建、可审计的提测快照。

技术栈：Next.js（App Router）+ TypeScript 全栈 + PostgreSQL + Prisma + pnpm。

## 做界面之前必须先读

**`.agents/spec/design/design.md`** 是界面基准，`.agents/spec/design/prototype.html` 是可交互原型，`.agents/spec/design/modules.json` 是机器可读的模块清单。

任何涉及页面、组件、样式、布局、文案排版的改动，**开工前先读这三份**。不要凭感觉设计，也不要另起一套视觉语言。

凭据相关的改动必须读 `.agents/spec/product/credentials.md`。收尾验收必须读 `.agents/spec/design/test-cases.md`。

### 界面硬规则

1. **原型是唯一基准。** 实现与原型不一致时以原型为准。要改原型，先在 issue 里说明理由。
2. **先改原型，再改代码。** 任何 UI 讨论先改 `.agents/spec/design/prototype.html`，同意后再动实现。
3. **涉及 UI 的 PR 必须 @ lxz 确认。** 没有他的明确确认，**不允许合并**。这条优先于「CI 全绿」「评审通过」「QA 通过」。
4. **QA 验收必须逐页对照原型**，结论写进 `[Result]`。只跑功能 AC、不做原型对照的验收判不通过。
5. **样式门禁必须绿。** `pnpm test:style` 只保证「样式没被意外改坏」，不保证「符合设计」，两者都要。
6. **收尾必须跑验收用例集。** `pnpm test:acceptance` 必跑；有部署环境时加跑 `pnpm test:acceptance:ui`。结果贴进 `[Result]`，有失败就判不通过。用例集在 `.agents/spec/design/test-cases.md`。
7. **界面参数只认 spec。** 颜色、字号、间距、圆角、断点一律取自 `design.md` 第五节到第六节的表格，不要临场挑值。
### 为什么这么定

功能全部满足、CI 全绿、每轮验收都通过，界面却和原型差了一整套视觉语言，而没有任何一道门禁能发现。根因是流程缺了「设计基准」这一环。

## 常用命令

```bash
pnpm install              # 装依赖（postinstall 会跑 prisma generate）
pnpm exec prisma generate # 切分支后必须重跑，否则类型检查会报出 main 上不存在的错误
pnpm dev                  # 本地开发
pnpm build                # 生产构建
pnpm lint && pnpm typecheck && pnpm test
pnpm db:migrate           # 迁移
pnpm db:seed              # 灌种子数据
pnpm test:style           # 样式门禁（三层检查）
```

**切分支或拉新提交后，先跑 `pnpm exec prisma generate` 再构建。** 本地 Prisma 客户端过期会报出 `main` 上并不存在的类型错误，很容易误判成主线坏了。

## 目录约定

| 路径 | 内容 |
| --- | --- |
| `app/` | 页面与 Route Handler |
| `components/` | 共用组件（`page-shell.tsx` 是全站外壳） |
| `lib/` | 领域逻辑 |
| `lib/integrations/` | CRP、Shuttle、Gerrit 客户端 |
| `prisma/` | schema、迁移、种子 |
| `scripts/` | 验证脚本、e2e、样式检查 |
| `tests/` | 单测与视觉基线 |
| `.agents/spec/design/` | **界面规范、原型、模块清单、验收用例集，改 UI 前必读** |
| `.agents/spec/product/` | **产品契约：凭据、权限等跨模块规则** |
| `tests/acceptance/` | 验收用例实现，按 `FUNC-` / `UI-` / `EDGE-` / `SEC-` 分组 |
| `docs/` | RUNBOOK、API、Webhook 等运维文档 |

## 提交与验收

- 提交信息用 `type(scope): 说明`，正文带 `Closes <issue-key>`。
- 每个 PR 的最后一次提交是 `chore: 功能点开发完成` 空提交，由合并人追加，不改任何文件。
- 合并前必须满足：CI 两个 job 全绿、评审 APPROVED、QA APPROVED、验收用例集通过、无冲突；**涉及 UI 的还要 lxz 确认**。
