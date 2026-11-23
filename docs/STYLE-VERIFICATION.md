# 样式未损坏的判定方案

适用：本平台所有页面的样式回归。由 A20 落地成 `pnpm test:style`，由各节点的 QA 验收执行。

## 一、为什么需要它

A19 之前，18 个页面里只有 3 个有样式，其余按浏览器默认样式渲染，而 CI 全绿、每轮验收都通过。原因是验收只看功能 AC，没有任何一条 AC 与样式有关，也没有任何自动检查。

所以这套检查的目标不是「这次修好」，而是**让样式坏掉在 CI 上不再可能静默通过**。

## 二、运行环境（先读这一节）

整页截图与锚点几何对字体敏感。实测：换一套字体（Noto Sans CJK → WenQuanYi / Liberation），软件包表格高度从 740px 变成 490px、工作台整页从 1740px 变成 1718px。那不是样式坏了，是渲染环境不同。

因此本检查**只在一个固定环境里出结论**：

| 项 | 固定值 |
| --- | --- |
| 镜像 | `mcr.microsoft.com/playwright:v1.65.1-noble` |
| 浏览器 | 该镜像自带的 Chromium（Playwright 1.65.1 对应 revision 1255），只跑 chromium |
| 视口 | 1280×900，`deviceScaleFactor: 1`，`locale: zh-CN`，`timezoneId: UTC` |
| 基线 | 在同一个镜像里生成，跟着代码一起入库 |

CI 的样式 job 就跑在这个镜像里；基线也是在这个镜像里抓的。本机其它系统直接跑会看到字体差异带来的像素与几何报警，那不在本方案的判定范围内（见「九、已知边界」）。

在本机（Linux）上跑，用封装好的脚本，进同一个镜像：

```bash
scripts/style-check/container.sh            # 比对
scripts/style-check/container.sh --update   # 重写基线
```

前置条件：

- docker 可用；
- `DATABASE_URL`（或仓库根 `.env` 里那一行）指向一个已经 `pnpm db:migrate` + `pnpm db:seed` 过的库；
- **库里只有种子数据**。跑过 `pnpm test` 的库会多出构建轮询事件（`build_poll_event`），构建队列页会多出一张调度事件表，比对就会报差异。先 `pnpm db:reset` 把库退回种子状态，或者对一次性库跑。CI 的样式 job 每次都在空库上迁移 + 灌种子，天然满足这一条。

脚本用 `--network host` 直连本机数据库，容器里的 `node_modules` 单独挂一个目录，不覆盖本机那份。它进入镜像后会先跑一次 `pnpm db:seed` 核对记录数：数据对不上就直接以退出码 2 停下并提示 `pnpm db:reset`，把「环境不对」和「样式坏了」分开，而不是报一堆基线差异。

## 三、前提：样式有唯一入口

A19 之后：

- 全局样式表 `app/globals.css`，在 `app/layout.tsx` 引入，规则与设计变量都在这一个文件里；
- 页面外壳组件 `components/page-shell.tsx`，所有页面经它渲染；
- 表格统一 `.table-scroll` 容器 + `.data-table` 外观；
- 仓库里没有 `app/styles.ts`，也没有内联 `style={{`。

唯一入口是「比什么」的前提：来源只有一个时，样式坏了必然体现在这三层里。

## 四、覆盖页面（6 个）

| 页面 | 基线文件 | 取样路径 | 进基线的锚点 | 说明 |
| --- | --- | --- | --- | --- |
| 工作台 | `dashboard.json` / `.png` | `/dashboard` | 9 + 侧栏 9 | 会话记住的工作区是 `desktop-core` |
| 提测记录 | `releases.json` / `.png` | `/releases?workspace=desktop-core` | 7 个名字 / 9 个实例 | `releases.row-status` 一行一个，种子 3 行 |
| 提测详情 | `release-detail.json` / `.png` | `/releases/<id>?workspace=desktop-core` | 8 | 取种子里的 `桌面专业版 V25 / 25.0.1` |
| 创建提测 | `release-new.json` / `.png` | `/releases/new?workspace=desktop-core` | 3 | 第一步（选项目）；第二步需要 Gerrit 数据，见下表 |
| 构建队列 | `queue.json` / `.png` | `/queue?workspace=system-apps` | 6 | `desktop-core` 的提测都已完结，任务表为空，所以换工作区取样 |
| 软件包 | `packages.json` / `.png` | `/packages` | 6 | — |

为什么不是别的页面：`/login`、`/projects` 等页面在 A19 里没有 `data-style-anchor` 标注，没有可比的锚点。覆盖范围的唯一依据是 A19 交付的锚点清单。新增页面要进覆盖范围，先补锚点，再抓基线，属于新增工作，不自动生效。

L1 的静态检查不受这 6 页限制：它扫全部 `app/**/page.tsx`。

## 五、锚点清单

锚点用 `data-style-anchor="<名字>"` 标注。一个名字可能对应**多个元素**（表格行内的徽标一行一个），所以断言的口径是「名字 → 按文档顺序排列的所有实例」，实例数量本身也进基线。

工作台 `/dashboard`

| 锚点 | 元素用途 | 实例 | 状态 |
| --- | --- | --- | --- |
| `dashboard.workspace-switcher` | 工作区区块（列表 + 切换按钮） | 1 | 入基线 |
| `dashboard.overview-heading` | 「概览」二级标题 | 1 | 入基线 |
| `dashboard.stats` | 四张统计卡的卡片网格 | 1 | 入基线 |
| `dashboard.recent-releases` | 最近提测区块 | 1 | 入基线 |
| `dashboard.recent-releases-table` | 最近提测数据表 | 1 | 入基线 |
| `dashboard.queue-summary` | 构建队列摘要区块 | 1 | 入基线 |
| `dashboard.project-overview` | 项目提测概况区块 | 1 | 入基线 |
| `dashboard.config-todo` | 配置待办列表 | 1 | 入基线 |
| `dashboard.invite-form` | 邀请成员表单 | 1 | 入基线 |
| `nav.dashboard` … `nav.webhooks` | 侧栏导航项（8 项，当前页那项高亮） | 各 1 | 只在工作台入基线 |
| `sidebar.account` | 侧栏底部的账号区（账号名、角色、邮箱、退出登录，MKACG-957 起） | 1 | 只在工作台入基线 |

`nav.*` 与 `sidebar.*` 每个受保护页面都有，完全相同。只留工作台一份：一次侧栏改动的 diff 不会分散到六个文件，侧栏坏了照样挡得住。

提测记录 `/releases`

| 锚点 | 元素用途 | 实例 | 状态 |
| --- | --- | --- | --- |
| `releases.intro` | 页面说明段落 | 1 | 入基线 |
| `releases.status-tabs` | 状态页签行 | 1 | 入基线 |
| `releases.filters` | 筛选表单栏 | 1 | 入基线 |
| `releases.count` | 条数统计 | 1 | 入基线 |
| `releases.table` | 提测记录数据表 | 1 | 入基线 |
| `releases.row-status` | 行内状态徽标 | 3 | 入基线（多实例） |
| `releases.empty` | 空状态块 | 0 | 条件锚点：列表为空才出现，种子有 3 条记录 |
| `releases.create-actions` | 底部创建 / 导入入口 | 1 | 入基线 |

提测详情 `/releases/<id>`

| 锚点 | 元素用途 | 实例 | 状态 |
| --- | --- | --- | --- |
| `release-detail.summary` | 概要定义列表 | 1 | 入基线 |
| `release-detail.build-status` | 构建状态区块 | 1 | 入基线 |
| `release-detail.update-entry` | 「更新提测」入口区 | 1 | 入基线 |
| `release-detail.history-table-scroll` | 更新历史的滚动容器 | 0 | 条件锚点：提测有更新历史才出现 |
| `release-detail.history-table` | 更新历史数据表 | 0 | 条件锚点：同上 |
| `release-detail.snapshot-table-scroll` | 软件包快照滚动容器 | 1 | 入基线 |
| `release-detail.snapshot-table` | 软件包快照数据表 | 1 | 入基线 |
| `release-detail.repo-records-table` | CRP 仓库记录数据表 | 1 | 入基线 |
| `release-detail.crp-info` | 提测信息定义列表 | 1 | 入基线 |
| `release-detail.danger-zone` | 「危险操作」整节（MKACG-950 追加标题；MKACG-953 起锚点标在这一节的外层，2px 竖线、16px 左内边距与 48px 上外边距都量在它上面） | 1 | 入基线 |

创建提测 `/releases/new`

| 锚点 | 元素用途 | 实例 | 状态 |
| --- | --- | --- | --- |
| `release-new.step-project` | 第一步标题 | 1 | 入基线 |
| `release-new.manager-select` | 项目经理下拉框 | 1 | 入基线 |
| `release-new.project-select` | 项目下拉框 | 1 | 入基线 |
| `release-new.blockers` | 项目当前不能提测的阻断提示 | 0 | 条件锚点：有阻断才出现 |
| `release-new.review-table-scroll` | 第二步逐包表格的滚动容器 | 0 | 条件锚点：要读到 Gerrit 数据才出现 |
| `release-new.review-table` | 第二步逐包表格 | 0 | 条件锚点：同上 |
| `release-new.review-blockers` | 提交被阻断提示 | 0 | 条件锚点：同上 |
| `release-new.review-warnings` | 需人工确认的提示 | 0 | 条件锚点：同上 |
| `release-new.review-errors` | 读不到仓库数据的提示 | 0 | 条件锚点：同上 |
| `release-new.review-summary` | 本次提测汇总提示 | 0 | 条件锚点：同上 |
| `release-new.review-actions` | 第二步上一步 / 下一步按钮行 | 0 | 条件锚点：同上 |

第二步的 7 个锚点需要先选好项目、填版本、再真的从 Gerrit 读到分支与提交。基线环境不接 Gerrit（那是外部系统，凭据与网络都不在门禁的控制范围内），所以这 7 个锚点不在基线里。它们的变化由代码审查看住；真要给它们上基线，得先给这一步准备一个可控的仓库数据源。

构建队列 `/queue`

| 锚点 | 元素用途 | 实例 | 状态 |
| --- | --- | --- | --- |
| `queue.intro` | 页面说明段落 | 1 | 入基线 |
| `queue.workspace-switcher` | 工作区切换行 | 1 | 入基线 |
| `queue.stats` | 概览四张统计卡 | 1 | 入基线 |
| `queue.refresh` | 「立即轮询」按钮所在表单 | 1 | 入基线 |
| `queue.topo` | 「依赖拓扑」标题 | 1 | 入基线 |
| `queue.task-table` | 任务列表数据表 | 1 | 入基线（取样工作区 `system-apps`） |
| `queue.event-table` | 调度事件流水数据表 | 0 | 条件锚点：有调度记录才出现，种子没有 |

软件包 `/packages`

| 锚点 | 元素用途 | 实例 | 状态 |
| --- | --- | --- | --- |
| `packages.intro` | 页面说明段落 | 1 | 入基线 |
| `packages.create-entry` | 新建软件包入口 | 1 | 入基线 |
| `packages.table-scroll` | 数据表滚动容器 | 1 | 入基线 |
| `packages.table` | 软件包数据表 | 1 | 入基线 |
| `packages.table-header` | 表头行 | 1 | 入基线 |
| `packages.header-repo-path` | 仓库路径表头单元格 | 1 | 入基线 |
| `packages.empty` | 空状态块 | 0 | 条件锚点：没有软件包才出现 |

「条件锚点」的处理：它不在基线里，所以「这次没出现」不算失败；一旦它在基线环境里出现了（例如种子数据变了），会被报成「新增锚点」，需要显式 `--update`。这样既不会因为数据状态变化误报，也不会静默漏掉。

## 六、三层检查

`pnpm test:style` 依次跑三层，任意一层失败都以退出码 1 结束。

### L1 静态结构（不依赖浏览器与数据库）

| 判据 | 判据细节 |
| --- | --- |
| 所有 `app/**/page.tsx` 经 `PageShell` 渲染 | 未使用者 0 个，失败时列出文件 |
| 没有裸 `<table>` | 每个 `<table>` 开标签都要带 `className="data-table"`；横向滚动容器由 L2 的 `*.table-scroll` 锚点覆盖 |
| 样式来源唯一 | `app/**/*.tsx` 与 `components/**/*.tsx` 里 `style={{` 命中 0 处 |
| `app/globals.css` 规则数 | 不低于基线；规则数 = 去掉注释与字符串后 `{` 的个数（当前 111） |
| `app/globals.css` 设计变量 | `:root` 里每个变量的值与基线一致；变量被删也算失败，新增不算 |

设计变量这一条是为了兜住「改了值但没有任何锚点落在上面」的情况：例如 `--radius-card` 只影响 `.card`，而 `.card` 只在登录、注册与导入页出现，六个覆盖页面里没有它 —— 光靠锚点看不出这类改动。

实现：`scripts/style-check/lint.ts`。

### L2 计算样式快照（主判据）

每个锚点的每个实例取固定属性集，与 `tests/visual/baseline/<页面>.json` 逐字段**严格相等**比对：

```
display, position, margin, padding, fontSize, fontWeight, lineHeight,
color, backgroundColor, border, borderRadius, boxShadow, width, height
```

取值的口径就是 `getComputedStyle()` 的返回值（`border` 取简写、`margin` / `padding` 取简写、颜色是 `rgb()`、`width` / `height` 是布局后的像素值）。

判定：差异条数 = 0。四类差异分开报，一眼能分清是「锚点没了」还是「锚点还在但样式变了」：

| 差异类型 | 属性字段 | 含义 |
| --- | --- | --- |
| 锚点缺失 | `锚点` | 基线里有、这次一个实例都没量到 |
| 实例数变化 | `实例数` | 锚点还在，实例数量变了（例如提测记录从 3 行变 2 行） |
| 属性不符 | 属性名本身 | 单个属性的计算值不同 |
| 几何偏移 | `boundingBox.x/y/width/height` | 超出几何容差的位移 |

失败输出的格式固定为一行一条，可直接 grep：

```
页面 / 锚点 / 属性 / 期望 / 实际
```

例如：

```
提测记录 / releases.filters / borderRadius / 6px / 8px
工作台 / releases.row-status#2 / color / rgb(31, 35, 41) / rgb(0, 0, 0)
```

多实例锚点在名字后面加 `#序号`（从 1 开始）。不输出 DOM，也不输出整张快照。

实现：`scripts/style-check/compare.ts` 的 `compareAnchors()`。

### L3 几何与整页截图

| 检查项 | 容差 | 环境变量 |
| --- | --- | --- |
| 锚点 `boundingBox` 的 x / y / width / height | ≤ 2px | `CRP_STYLE_GEOMETRY_TOLERANCE_PX` |
| 整页截图（1280×900 视口、整页高度）像素差比例 | ≤ 0.5% | `CRP_STYLE_PIXEL_RATIO` |

几何差异在 L2 的同一份输出里报（`boundingBox.*`）。截图像素差超阈值时，把差异图写到 `tests/visual/diff/<页面>.png`（白底、差异像素标红），并在报告里给出一行：

```
提测记录 / 整页截图 / 像素差 / ≤ 0.50%（≤ 11136 像素） / 12800 像素（0.57%）
```

整页高度变了（例如表格多一行）就没法逐像素对齐，直接判失败并报出两边的尺寸。

实现：`scripts/style-check/compare.ts` 的 `comparePng()`。
### 颜色对比度（独立命令 `pnpm test:contrast`）

L2 只比「改没改」，不比「改得对不对」：把次要文字从 `#5d6875` 调成原型里的 `#758195`，
快照会跟着变，门禁照样绿，而正文对比度已经从 5.67:1 掉到 3.94:1。无障碍坏了，界面看上去没坏。

所以配色另有一道断言门禁，读 `app/globals.css` 的 `:root` 变量，按 WCAG 2.1 的相对亮度公式
逐对算对比度：

| 档位 | 阈值 | 适用 |
| --- | --- | --- |
| 正文 | 4.5:1 | 12–14px 的常规字（1.4.3 AA） |
| 非文本 | 3:1 | 控件边框这类「能点的东西的边」（1.4.11） |

另外扫一遍全表的十六进制色值：出现表外颜色即失败。**装饰线（`--color-line`）与控件边框
（`--color-control-border`）不得混用**，混了会在这里露出来。

配对表与色板都写在 `scripts/check-contrast.ts`；改配色要同时改那里、`app/globals.css` 与
issue 正文的 token 表。CI 的 `checks` job 在 Lint 之后跑这一步。


## 七、基线维护

| 项 | 内容 |
| --- | --- |
| 计算样式 + 几何 | `tests/visual/baseline/<页面>.json` |
| 整页截图 | `tests/visual/baseline/<页面>.png` |
| L1 基线 | `tests/visual/baseline/lint.json`（规则数 + 全部设计变量） |
| 差异图 | `tests/visual/diff/<页面>.png`（超阈值才生成，不入库） |
| 比对 | `pnpm test:style` |
| 更新 | `pnpm test:style --update` |

规则：

- **`--update` 在 CI 里被拒绝**：脚本检测到 `CI` 环境变量就直接退出码 2，不写任何文件。CI 只负责比对。
- 结论行的「失败 N 项」与退出码始终一致：L1 的结构类失败在任何模式下都计数，`--update` 只放宽依赖基线的那两条判据（规则数与设计变量）。
- **基线更新必须与引发它的样式改动在同一个 PR**。Reviewer 要看基线 diff，判断「改了哪些锚点、哪些属性、是否符合本次意图」。
- **与功能无关的节点不允许顺手改基线**。改了就按「样式被无授权修改」打回。
- `--update` 一次刷新全部：六页的 JSON + PNG，加上 `lint.json` 里的规则数与设计变量。不允许只刷新一部分。
- **L1 结构检查没通过时 `--update` 一个基线也不写**，直接以退出码 1 结束：按一棵结构有问题的树写盘，等于把问题存进基线。

## 八、数据稳定性与环境变量

取样对数据敏感，所以基线环境是钉死的：

- 种子数据来自 `prisma/seed.ts`（`pnpm db:seed`），提测、软件包、工作区的数量固定；
- 工作区钉在取样路径里：工作台 / 提测记录 / 提测详情 / 创建提测用 `desktop-core`，构建队列用 `system-apps`；
- 提测详情按「项目名 + 版本」定位（`桌面专业版 V25 / 25.0.1`），持久化时把 uuid 写成 `<id>`，换库不产生 diff 噪音；
- 会话由脚本自己签发（种子账号的密码哈希是占位值，登录接口用不了），跑完即删，不新增账号、不改页面数据。
- **页面上显示的创建时间写死在种子里**：`prisma/seed.ts` 的每条提测都带 `createdAt`。靠数据库默认值取「播种那一刻」的话，换一台机、换一次播种，详情页的「创建时间」就变一个值，基线会带一个与本单无关的基础差异。
- **渲染成表格的查询必须写 `orderBy`**：数据库不保证无序查询的返回顺序。L2 比的是锚点属性、行序变化在属性上完全看不出来，只有 L3 的整页截图会随机报警 —— 2026-11-19 的验收就撞到过：`lib/releases/detail.ts` 的「CRP 仓库记录」没写 `orderBy`，同一份代码 8 次里 1 次失败（像素差 0.89%）。同类查询改动时按这条自查，`tests/release-detail.test.ts` 有一条用例专门锁住它的行序。

页面上唯一的时钟输出是工作台与构建队列的「数据截至 …」一行。它不参与 L2 的属性比对；把阈值压到 0 单独量，这两页每次的像素差是 162–200 像素（0.01%），其余四页是 0 像素 —— 50 倍余量，连续跑六次报告输出完全一致。

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| `CRP_STYLE_BASELINE_DIR` | `tests/visual/baseline` | 基线目录（必须在仓库内） |
| `CRP_STYLE_DIFF_DIR` | `tests/visual/diff` | 差异图目录（必须在仓库内：脚本会先清空它，指到仓库外直接报错退出） |
| `CRP_STYLE_GEOMETRY_TOLERANCE_PX` | `2` | 几何容差（CSS 像素） |
| `CRP_STYLE_PIXEL_RATIO` | `0.005` | 整页截图像素差比例上限 |
| `CRP_STYLE_BASE_URL` | 空 | 有值时复用已有服务，不自己构建并起服务 |
| `CRP_STYLE_PORT` | `3100` | 自己起服务时监听的端口（被占用会直接报错） |
| `CRP_STYLE_EMAIL` | `admin@uniontech.com` | 取样用的种子账号 |
| `CRP_STYLE_SKIP_BUILD` | 空 | 设为 `1` 时跳过 `next build`（只给反复调脚本时用） |

走容器时（`scripts/style-check/container.sh`）这些变量会按原样透传给容器；两份目录类变量即便透传了，
路径也必须在仓库内 —— 容器只挂载仓库，指到仓库外会直接报错退出。

**取样的输入由门禁自己固定，不看操作者配了什么凭据。** 仓库根的 `.env` 会跟仓库一起进容器并被
Next 自己加载：配了 CRP / Gerrit 凭据时，提测详情页会多出「提交信息 / 工作流进度」那一段，整段
下压 12.4px，与提交进仓库的基线（在没有这些凭据的环境里生成）对不上。所以容器启动时用一份
**只含 `DATABASE_URL`** 的文件只读盖住 `.env`，取样结果与操作者有没有配业务凭据无关。
要改这件事，只能改门禁怎么固定取样输入；**不要**在配好凭据的环境里重生成基线 —— 那会让没有凭据的
CI 变红，方向正好反了。

默认会先 `next build` 再 `next start`：`next start` 跑的是上一次的构建产物，不重建就会量到旧代码。CI 里也一样，所以样式 job 不需要单独一步构建。

## 九、QA 验收怎么执行

每个节点的验收固定追加一条：

> 跑 `scripts/style-check/container.sh`（等价于门禁镜像里的 `pnpm test:style`），退出码 0。

若该节点改动涉及页面或样式：

- 必须同时提交基线更新（`scripts/style-check/container.sh --update` 的产物）；
- 必须在 issue 里贴「哪些页面、哪些锚点、哪些属性变了」；
- 未提交基线更新而比对失败，判定验收不通过。
- 配色改动还要跑 `pnpm test:contrast`，退出码 0（不需要数据库与浏览器，本机直接跑）。

## 十、已知边界

- **只覆盖页面级**，不做组件级视觉回归。
- **不覆盖未登录以外的权限态**：只读成员、非成员看不到的视图差异由功能 AC 覆盖。
- **不做跨浏览器、跨系统基线**：只有 chromium 一套，只有门禁镜像里的那一套字体。换环境报的差异不是样式坏了。
- **条件锚点不常驻**：依赖数据状态才出现的锚点在基线环境里没有出现，就没有被覆盖（详见第五节的状态列）。
- **设计变量只比 `:root` 里的字面值**，不比 `var()` 的解析结果；解析结果由 L2 的锚点属性覆盖。
- **新页面不自动纳入**：加页面要先补锚点、写进 `scripts/style-check/pages.ts` 与本文档、再抓基线。
