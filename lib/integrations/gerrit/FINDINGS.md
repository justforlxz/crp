# A3 Gerrit 与 gitiles 客户端实测记录

本文件记录本节点接真实 Gerrit 时观测到的行为，每一条都带实际请求与响应。
凭据只在本机通过环境变量注入，仓库内不出现任何账号、密码或令牌。

测试环境：`https://gerrit.uniontech.com`，2026-11-18。

## 1. 认证方式

### 匿名访问会被 302 到登录页

```console
$ curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
    'https://gerrit.uniontech.com/plugins/gitiles/deepin-kde/kwin/+/refs/heads/develop/eagle/debian/changelog?format=TEXT'
302 http://gerrit.uniontech.com/login/https%3A%2F%2Fgerrit.uniontech.com%2Fplugins%2Fgitiles%2Fdeepin-kde%2Fkwin%2F%2B%2Frefs%2Fheads%2Fdevelop%2Feagle%2Fdebian%2Fchangelog%3Fformat%3DTEXT
```

注意 `Location` 的协议是 `http://`。跟过去就是一条明文请求，所以客户端用
`redirect: "manual"`，遇到 3xx 直接判定为凭据问题并抛出 `GerritAuthError`，绝不跟随。

### 认证用 HTTP Basic

用户名 + Gerrit 网页 Settings → HTTP Credentials 生成的密码，放在
`Authorization: Basic base64(用户名:密码)` 里。凭据按人存在数据库里
（`user_credential`，MKACG-986 起在「我的账号」页配置），不再有
`GERRIT_USERNAME` / `GERRIT_HTTP_PASSWORD` 环境变量。

### `/a/` 前缀不能省

同一个正确凭据，加不加 `/a/` 结果完全不同：

| 请求 | 状态 |
| --- | --- |
| `GET /a/projects/deepin-kde%2Fkwin/branches/` | 200 |
| `GET /a/plugins/gitiles/deepin-kde/kwin/+/refs/heads/develop/snipe/debian/changelog?format=TEXT` | 200，132860 字节 |
| `GET /plugins/gitiles/deepin-kde/kwin/+/refs/heads/develop/snipe/debian/changelog?format=TEXT` | **302 登录页**，0 字节 |

所以 issue 正文里写的 `/plugins/gitiles/{project}/+/{ref}/debian/changelog?format=TEXT`
是**匿名路径**，带认证访问必须写成 `/a/plugins/gitiles/...`。客户端里的
`GITILES_ROOT` 就是 `/a/plugins/gitiles`。

### 「匿名能拿到一点东西」不等于凭据可省

| 请求（不带凭据） | 状态 |
| --- | --- |
| `GET /projects/?d` | 200，2935 字节，返回一段公开项目清单 |
| `GET /projects/deepin-kde%2Fkwin/branches` | 404 |
| `GET /a/projects/deepin-kde%2Fkwin/branches/` | 401 |

匿名请求分支接口得到 404 而不是 401，看起来像「仓库不存在」。这正是必须把凭据配齐再看结论的原因。

## 2. 分支名带 `/` 的编码

gitiles 的路径是目录层级，`debian/changelog` 这类文件路径要和 ref 拼在同一条 URL 上，
ref 一旦编码错就整条路径失效。

三种写法实测都能取到同一份内容（都是 200、132860 字节、base64 解码后内容一致）：

| 写法 | 状态 |
| --- | --- |
| `+/refs/heads/develop/snipe/debian/changelog`（补齐 refs/heads/，按 `/` 分段转义） | 200 |
| `+/refs%2Fheads%2Fdevelop%2Fsnipe/debian/changelog`（整串转义） | 200 |
| `+/develop/snipe/debian/changelog`（不补齐前缀，只给短分支名） | 200 |

客户端采用**第一种**：补齐成完整 ref、再按 `/` 分段转义。

原因是另外两种依赖服务端猜：整串转义依赖它的百分号解码实现，
短分支名依赖它按最长匹配去试 `refs/heads/` 与 `refs/tags/`。
第一种把 ref 的全名和层级都写死，不会因为将来出现同名 ref 而指错地方。

对应的两个导出函数：

- `normalizeRef("develop/snipe")` → `"refs/heads/develop/snipe"`
- `encodeGitilesRef("develop/snipe")` → `"refs/heads/develop/snipe"`（分段转义，斜杠保留）

### 提交号不能补 `refs/heads/`

`readChangelog` 的 ref 参数既可以是分支、标签，也可以是提交号。提交号一旦被补成
`refs/heads/<提交号>`，gitiles 会去找一个同名分支，直接 404：

```console
200  /a/plugins/gitiles/deepin-kde/kwin/+/9286cd554592bdcee8909f697af6a581086643b3/debian/changelog?format=TEXT
404  /a/plugins/gitiles/deepin-kde/kwin/+/refs/heads/9286cd554592bdcee8909f697af6a581086643b3/debian/changelog?format=TEXT
```

短提交号同样可用（`+/9286cd5/...` 也是 200，返回 145604 字节，与完整提交号内容一致）。

所以 `normalizeRef` 的规则是：

| 输入 | 输出 |
| --- | --- |
| `9286cd554592bdcee8909f697af6a581086643b3`（40 位十六进制） | 原样返回 |
| `9286cd5`（7 位十六进制） | 原样返回 |
| `refs/tags/v1` | 原样返回 |
| `develop/eagle` | `refs/heads/develop/eagle` |

判定用 `/^[0-9a-f]{7,40}$/i`：七位以上十六进制才当提交号，长度按 git 短 sha 的常见下限取七。
副作用是理论上一个纯十六进制、长度七位以上的分支名会被当成提交号；这种分支名不存在于
本服务的实测分支清单里，暂不为此增加额外参数。

## 3. commit 列表的分页参数

`+log/<ref>?format=JSON` 的响应结构：

```json
{ "log": [ { "commit": "...", "tree": "...", "parents": [...],
             "author": {"name","email","time"}, "committer": {...},
             "message": "..." } ],
  "next": "<40 字符续页游标>" }
```

实测结论：

| 参数 | 实测结果 |
| --- | --- |
| 不带参数 | 一页 100 条，响应里带 `next` |
| `n=3` | 一页 3 条，`next` 仍然给出 |
| `s=<上一页的 next>` | 取到下一页 100 条 |

所以**条数用 `n` 控制，翻页用 `s` 控制**。客户端只支持「取最近的 N 条」，不支持翻页：

- `listCommits(project, branch, limit = 50)`；
- `MAX_COMMITS = 50`，调用方传更大的值会被压到 50（MUST：分页上限保护）；
- 请求时带 `n=<上限后的条数>`，避免为了 50 条下载 100 条；
- 客户端本地再 `slice` 一次兜底，服务端哪天忽略 `n` 也不会超量返回。

## 4. XSSI 前缀 `)]}'`

Gerrit REST 与 gitiles 的 **JSON** 响应都以 `)]}'` 开头，直接 `JSON.parse` 会失败：

| 请求 | 响应开头 |
| --- | --- |
| `GET /a/projects/deepin-kde%2Fkwin/branches/` | `)]}'\n[{"ref":"HEAD",...` |
| `GET /a/plugins/gitiles/.../+log/...?format=JSON` | `)]}'\n{\n  "log": [` |
| `GET /a/plugins/gitiles/.../+/<sha>?format=JSON` | `)]}'\n{\n  "commit": "..."` |

`format=TEXT` 是例外：响应体就是文件内容的 base64 原文，**没有**前缀，也不能当 JSON 解析：

```console
$ curl -s -u "$AUTH" '.../+/refs/heads/develop/snipe/debian/changelog?format=TEXT' | base64 -d | head -1
kwin (4:6.1.57) unstable; urgency=medium
```

`stripGerritPrefix` 同时兼容「有前缀」与「没前缀」两种输入，只剥 JSON 那一路。

## 5. 仓库或文件不存在时的响应

| 请求 | 状态 | 正文 |
| --- | --- | --- |
| `GET /a/projects/deepin-kde%2Fno-such-repo-xyz/branches/` | 404 | `Not found: deepin-kde/no-such-repo-xyz` |
| `GET /a/plugins/gitiles/deepin-kde/no-such-repo-xyz/+/refs/heads/develop/eagle/debian/changelog?format=TEXT` | 404 | HTML，`<title>Cannot parse URL as a Gitiles URL - Gitiles</title>` |

两种情况 Gerrit 都返回 404，HTTP 层分不开「仓库不存在」与「这个 ref 上没有 `debian/changelog`」。
所以客户端抛出的 `GerritNotFoundError` 消息里把两种可能都写出来，不假装能区分。

## 6. 真实数据

改动前先手工取了一次基线，改动后用 `scripts/verify-gerrit.ts` 复核，两边一致。

| 项目 | 分支 | 分支数 | 分支头提交 | changelog 首条版本 | 包名 |
| --- | --- | --- | --- | --- | --- |
| `deepin-kde/kwin` | `develop/snipe` | 44 | `fd6b2f3f6938d2ab3e49dd962ce9a5139c44db04` | `4:6.1.57` | `kwin` |
| `deepin-kde/kwin` | `develop/eagle` | 44 | `9286cd554592bdcee8909f697af6a581086643b3` | `4:5.27.2.331-deepin331-1` | `kwin` |
| `deepin-kde/wayland` | `develop/eagle` | 4 | `2900ef291742e67e0d308df357e15028c5e262e5` | `1.26.0.6-deepin6` | `wayland` |

changelog 首条原文（与人工打开 gitiles 页面看到的一致）：

```text
# deepin-kde/kwin @ develop/eagle（分支头 9286cd554592bdcee8909f697af6a581086643b3）
kwin (4:5.27.2.331-deepin331-1) unstable; urgency=medium
```
```text
# deepin-kde/kwin @ develop/snipe
kwin (4:6.1.57) unstable; urgency=medium
```
```text
# deepin-kde/wayland @ develop/eagle
wayland (1.26.0.6-deepin6) unstable; urgency=medium
```

### 按提交号读取

用上面的 `9286cd554592bdcee8909f697af6a581086643b3` 直接读该提交上的 changelog：

```console
$ curl -s -u "$AUTH" \
    'https://gerrit.uniontech.com/a/plugins/gitiles/deepin-kde/kwin/+/9286cd554592bdcee8909f697af6a581086643b3/debian/changelog?format=TEXT' \
  | base64 -d | head -1
kwin (4:5.27.2.331-deepin331-1) unstable; urgency=medium
```

状态 200，145604 字节。同一提交上短提交号 `9286cd5` 返回同样内容；
补成 `refs/heads/9286cd554592...` 则 404（对照见第 2 节）。

这一条是 A11 要用的能力：按被提测的那个提交取版本号，而不是按分支当前头取。

两个仓库正好构成 kwin 依赖 wayland 的一条链条，版本号格式也不同
（kwin 带 epoch 前缀 `4:`，wayland 带 debian 修订后缀 `-deepin6`、中间还有 `~` 之外的
四段式版本号），正好覆盖两处解析难点。

## 7. 版本号解析规则

`parseChangelog` 是纯函数，只读首条条目：

- 标题行：`软件包名 (版本号) 发行版; urgency=级别`。版本号取括号内的原文，不去掉 epoch 与修订号。
- 维护者时间行：以 ` -- ` 开头，姓名与时间之间按 Debian 惯例是两个及以上空格。
- 换行：CRLF 与单独的 CR 都先归一成 LF。
- 空行：标题行前与条目内的连续空行都不影响解析。
- 解析不出来一律抛 `ChangelogParseError`，消息里带原始行；**不返回空字符串冒充版本号**。

## 8. 仍不确定的部分

- `s=<next>` 只验证了「能取到下一页」，没有验证走到底之后的分页终止行为，客户端也暂不使用它。
- Gerrit 的 `/a/` 前缀对本服务上的其他插件是否同样必需，只验证了 gitiles 这一处。
- HTTP 凭据的有效期与轮换由 Gerrit 侧决定，客户端没做凭据过期后的自动重试。

## 9. A18 追加：列全部项目、按 Tag 反查提交（2026-11-19 实测）

从 CRP 导入提测时，CRP 只给包名（`ProjectName`），而读 `debian/changelog` 要仓库路径。
这两条读接口用来把包名落到唯一仓库上，并在 CRP 没给提交号时按 Tag 找回提交。

### 9.1 列全部项目：`GET /a/projects/`

```
GET /a/projects/
→ 200，922568 字节
{"All-Users":{"id":"All-Users","state":"ACTIVE","web_links":[…]},
 "Code-Quality":{…}, …}
```

响应是一个「仓库路径 → 详情」的字典，键就是仓库路径。实测 6133 个仓库。

**包名不等于仓库路径**，而且同名仓库可以有多个（这些都是实测结果）：

| 包名 | 最后一段等于它的仓库 |
| --- | --- |
| `kwin` | `deepin-kde/kwin`、`smartos/app/deepin-kde/kwin`、`snipe/kwin` |
| `dde-file-manager` | `dde-file-manager`、`smartos/app/dde-file-manager` |
| `dde-dock` | `dde-dock`（唯一） |

所以「按最后一段找候选」只能收敛到候选集合，不能直接定案；定案的办法见 9.3。

### 9.2 按 Tag 读提交：gitiles `+/refs/tags/{tag}`

```
GET /a/plugins/gitiles/deepin-kde/kwin/+/refs/tags/5.2.27.29?format=JSON
→ 200
{"commit": "17325d43cac4a15abba58dde2136f8e20526f671", "tree": "6d58bf04…",
 "parents": ["01b3aa65…"], "author": {"name":"zhangyu", …}, …}
```

Tag 不存在时（同一个仓库换一个不存在的版本号）：

```
GET /a/plugins/gitiles/deepin-kde/kwin/+/refs/tags/1.0.0.9-deepin1?format=JSON
→ 404（HTML 错误页）
客户端：GerritNotFoundError「项目 deepin-kde/kwin 上没有 Tag 1.0.0.9-deepin1。」
```

`refs/tags/` 前缀由 `normalizeRef` 原样保留、按 `/` 分段转义（与第 2 节同一个规则）。
只有 404 才表示「这个仓库没有这个 Tag」；认证失败与网络错误照常抛出，不当成「没有」。

**CRP 的 Tag 不一定是 git 标签**：CRP 里大量主题的 tag 形如 `1.0+uploadcrp`，
这类值在仓库里没有同名 Tag。此时反查失败，导入停在预览并点名该包 —— 这是设计要的结果，
不能用别的东西凑一个提交号。

### 9.3 候选有多个时怎么定案

拿 CRP Release 里的提交号逐个候选仓库去读 `debian/changelog`：

- 只有一个仓库读得到 → 就是它，代码版本同时拿到了；
- 一个都读不到 → 这条 Release 定不下来，导入停在预览；
- 两个以上都读得到 → 也不定案（镜像仓库就是这样），要求先在软件包管理登记唯一仓库。

真实例子：`kwin` 的提交 `17325d43…` 在 `deepin-kde/kwin` 与 `smartos/app/deepin-kde/kwin`
里都能读到（都是 200，版本号同为 `4:5.27.2.29-deepin29-1`），`snipe/kwin` 里读不到。
所以未登记的 `kwin` 会停在预览；已登记的软件包直接用登记时的仓库路径，不受这个歧义影响。
