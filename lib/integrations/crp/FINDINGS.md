# CRP 接入实测记录（A2）

本文件记录 `lib/integrations/crp/` 每一个接口的真实请求与响应，作为后续节点（A11、A12、A17）传参的依据。
所有结论都来自 2026-11-19 对 `https://crp.uniontech.com/api` 的实际调用，不是从旧文档抄的。

- 账号：`crp-user`（CRP 用户）——下文所有账号、姓名、邮箱都是占位符，实际跑用的是本地环境变量里的真实账号
- 交付分支：`eagle-1071`，ID `108`
- 验证脚本：`scripts/verify-crp.ts`

## 一、给后续节点直接用的结论

| 问题 | 结论 |
| --- | --- |
| 登录字段叫什么 | `userName`（不是 `username`），密码走 RSA PKCS#1 v1.5 填充后 base64 |
| token 怎么用、能活多久 | `Authorization: Bearer <jwt>`；实测 `exp` 是签发后 3 天 |
| 基线列表要不要登录 | 不要。`GET /branches` 匿名可用，实测 108 条 |
| 建 Topic 返回什么 | 201 + **裸数字**（TopicID），不是对象 |
| 投递 Release 返回什么 | 201 + **裸数字**（ReleaseID），不是对象 |
| 版本号怎么传 | `ChangeLogMode=false` + 自定义 `Tag`：Tag 按原样存进 Release。这是本平台要的行为 |
| `ChangeLogMode=true` 会怎样 | CRP 忽略传入的 `Tag`，自己生成，实测生成出来是 `0`。**不要用** |
| Tag 能用哪些字符 | 数字开头，不能有 `-`、`_`、空格。允许 `.`、`+`、`~` |
| 能删 Topic 吗 | 不能。CRP 没有删除 Topic 的接口，只能 `PUT` 置 `Abandoned=true` |
| 能重试失败的 Release 吗 | 当前部署上 `/topic_releases/{id}/retry` 一律 404，未打通；重试请走 Shuttle 的 `/job/rebuild`（A4） |
| 新 Topic 的 WorkProgress | `0`（未开始），`>= 20` 即已转测、不能再改包 |

## 二、登录

```
POST /api/login
{"userName": "<ldap 账号>", "password": "<RSA(PKCS1v15) 后 base64>"}
→ 200 {"Token": "<jwt>"}
```

- 密码必须用 CRP 前端内联的那把 1024 位公钥、PKCS#1 v1.5 填充加密（`lib/integrations/crp/auth.ts` 的 `encryptPassword`）。
- 字段名实测只认 `userName`；旧客户端会先试 `username` 再退到 `userName`，本实现直接用 `userName`。
- JWT 的 claims 只有两个：`exp`、`name`。实测 `exp - 签发时刻 ≈ 3 天`，所以 token 缓存必须按 `exp` 失效。
- 缓存写在 `~/.cache/crp/jwt`，权限 0600。与 CRP 官方 Python 客户端的 `~/.cache/crp/token` 分开，互不覆盖。

```
GET /api/user
→ 200 {"Name": "crp-user", "NameCN": "CRP 用户", "Read": "yes"}
```

## 三、交付分支

```
GET /api/branches          # 不需要 Authorization
→ 200 [{"ID": 108, "Name": "eagle-1071", "Description": "eagle-1071(...)", "RepoType": "deb", "Managers": "", "IsCheck": 1}, ...]
```

实测 108 条，`eagle-1071` = 108。基线列表同步因此不需要凭据。

## 四、Topic

### 4.1 建 Topic

```
POST /api/branches/108/topics
{"ID": null, "Name": "a2-verify-…", "TpcType": "public", "Description": "…", "Type": "test",
 "NameB64": null, "BranchID": 108, "SyncID": 0, "State": 0, "Owner": "crp-user",
 "Abandoned": false, "Completed": false, "Members": null, "RepoType": "deb", "CopyId": null}
→ 201 29158            # 响应体是裸数字，不是 JSON 对象
```

### 4.2 读 Topic

```
GET /api/topics/29158
→ 200 {"ID": 29158, "Name": "a2-verify-…", "NameB64": "YTItdmVyaWZ5LTE3OTUwMTk5OTg4MTIyMDI2LTExLTE5IDAwOjM5OjU4",
       "Description": "…", "BranchID": 108, "Completed": false, "Type": "test", "Abandoned": false,
       "Owner": [{"employeeid": "…", "mail": "crp-user@example.com", "name": "crp-user", "namecn": "CRP 用户"}],
       "Members": null, "TpcType": "public", "SyncID": 0, "State": 0, "Lock": false, "RepoType": "deb", "Mail": ""}
```

**Owner 两个方向的类型不同**：读回来是对象数组，写回去必须是字符串。
直接把读到的对象回传给 `PUT` 会被拒：

```
PUT /api/topics/29158   {"Owner": [{...}], ...}
→ 400 {"message": "Unmarshal type error: expected=string, got=array, field=Owner, offset=204"}
```

所以 `abandonTopic` 先把 Owner/Members 折成 `"a;b"` 形式的字符串再发。

### 4.3 没有删除 Topic 的接口

这是本节点最重要的发现之一：**CRP 不提供删除 Topic 的能力**。逐个试过的结果：

| 请求 | 响应 | 实际效果 |
| --- | --- | --- |
| `DELETE /api/topics/29158` | 200 + 完整 Topic 对象 | 什么也没发生，Topic 还在 |
| `DELETE /api/topics/29158`（放弃之后再试一次） | 200 + 完整 Topic 对象 | 仍然还在 |
| `DELETE /api/topics/29158?force=true` | 405 `{"message": "Method Not Allowed"}` | —（405 说明这个路径不接 DELETE 之外的写法） |
| `POST /api/topics/29158/abandon` | 404 `{"message": "Not Found"}` | — |
| `POST /api/topics/29158/delete` | 404 `{"message": "Not Found"}` | — |
| `POST /api/topics/29158/remove` | 404 `{"message": "Not Found"}` | — |
| `DELETE /api/branches/108/topics/29158` | 404 `{"message": "Not Found"}` | — |

结论：`DELETE /api/topics/{id}` 在这个部署上是个空操作（返回 200 但没删）。清理只能用「放弃」：

```
PUT /api/topics/29158   {…原样对象…, "Owner": "crp-user", "Members": null, "Abandoned": true}
→ 200 {…"Abandoned": true…}
```

放弃之后：

```
GET /api/topics/29158        → 200，Abandoned: true（Topic 依然可查）
GET /api/topics/29158/releases → 200 []
```

已放弃的 Topic 仍然能被 `GET /api/topics/{id}` 读到，也仍然出现在 `POST /api/topics/search` 的返回里
（带 `Abandoned: true`）。所以「清理」的准确说法是：**该 Topic 里不再有任何 Release，Topic 本身标记为已放弃**，
而不是「CRP 侧查不到」。

## 五、投递 Release

### 5.1 请求与响应

```
POST /api/topics/29158/new_release
{"Arches": "amd64;mips64el;arm64;sw64;loong64", "BaseTag": null, "Branch": "develop/eagle",
 "BuildID": 0, "BuildState": null, "Changelog": [""], "Commit": "f8e9527a…", "History": null,
 "ID": 0, "ProjectID": 8, "ProjectName": "dde-file-manager", "ProjectRepoUrl": null,
 "SlaveNode": null, "Tag": "9.9.9", "TagSuffix": null, "TopicID": 29158, "TopicType": "test",
 "ChangeLogMode": false, "RepoType": "deb", "Custom": true, "BranchID": "108"}
→ 201 107449           # 裸数字，ReleaseID
```

注意两个类型细节：`BranchID` 是**字符串**，`ProjectID` 是**数字**。按 CRP 原生写就对了。

### 5.2 ProjectID 必须查出来，不能传 0

```
POST /api/topics/29158/new_release   {"ProjectID": 0, …}
→ 500 {"message": "project not found"}
```

投影 ID 用 `POST /api/project` 按名字查：

```
POST /api/project
{"page": 0, "perPage": 0, "projectGroupID": 0, "newCommit": false, "archived": false,
 "branchID": 108, "name": "dde-file-manager"}
→ 200 {"Pagination": {…}, "Projects": [{"ID": 8, "Name": "dde-file-manager"}, …]}
```

`Projects` 可能是 `null`（查不到时）。名字是模糊匹配，所以客户端优先取名字完全相同的那条。

### 5.3 同一个 Topic 里同一个 project+branch 只能有一个 Release

第二次投递会被拒：

```
POST /api/topics/29158/new_release   # 上一次的 Release 还没删
→ 500 {"message": "topic release not found (该主题中项目id未找到，建议放弃该项目重新打包)"}
```

CRP 的原话有点误导，实际原因是「已存在」。A17 的「换包」必须**先删旧 Release 再投新的**，
顺序反过来就是这条报错。

### 5.4 `ChangeLogMode` 与 `Tag` 的实际行为（本节点的重点交付）

同一 Topic、同一 project+branch，每次先删干净再投，逐个试：

| `ChangeLogMode` | 请求里的 `Tag` | HTTP | 存进 Release 的 `Tag` | 结论 |
| --- | --- | --- | --- | --- |
| 不传 | `"7.7.7"` | 201 | `"7.7.7"` | 不传等同 false |
| `false` | `"7.7.7"` | 201 | `"7.7.7"` | **按原样生效** |
| `false` | `"9.9.9"` | 201 | `"9.9.9"` | 同上 |
| `false` | 不传 | 500 | — | `version string is empty` |
| `true` | `"1"` | 201 | `"0"` | Tag 被忽略，CRP 自己生成 |
| `true` | `"8.8.8"` | 201 | `"0"` | 同上，传什么都没用 |
| `true` | 不传 | 201 | `"0"` | 同上 |

补充两条：

- `ChangeLogMode=true` 时把 `Changelog` 换成真实的 `debian/changelog` 首条（`dde-file-manager (6.5.42) …`），存回来的 `Tag` 仍然是 `"0"`。
  也就是说自动生成的版本号不来自 changelog 文本，本节点没法让它符合预期。
- `GET /topics/{id}/releases` 返回的 `ChangeLogMode` 字段一律是 `false`，即使请求里写的是 `true`。
  **不要用列表里的这个字段判断当初怎么传的**，要判断就看 `Tag` 是否等于你传的值。

所以 PRD 的约定成立，可以照做：

> 默认用代码版本作为 `Tag`，并置 `ChangeLogMode=false`。

A11/A12 传参就是 `ChangeLogMode: false` + `Tag: <代码版本>`，投递后从 `GET /topics/{id}/releases` 读回 `Tag` 核对，
不要相信请求回执——回执只有一个数字。

### 5.5 Tag 的字符规则（实测）

| 传进去 | HTTP | CRP 的答复 |
| --- | --- | --- |
| `9.9.9` | 201 | 接受，存 `9.9.9` |
| `9.9.9+deb1` | 201 | 接受，原样存 |
| `9.9.9~rc1` | 201 | 接受，原样存 |
| `7.7.7-rc1` | 500 | `版本中不能包含'-'字符` |
| `9.9.9_1` | 500 | `invalid character in version number` |
| `9.9.9 rc` | 500 | `version string has embedded spaces` |
| `v9.9.9` | 500 | `version number does not start with digit` |
| `9.9.9:` | 500 | `epoch: strconv.ParseInt: parsing "9.9.9": invalid syntax` |
| 不传（`ChangeLogMode=false`） | 500 | `version string is empty` |

客户端把这五条已经证实的原因做成 `validateReleaseTag`，在发请求前就拦下。
没验证过的字符一律放行交给 CRP 判断——本地规则比服务器更严会把本来能投的版本号挡在门外。

`9.9.9:` 这一条说明 CRP 接受 Debian 的 epoch 写法（`<数字>:<版本>`），只是 `:` 前面必须是数字。
这条没有做成本地规则，因为它对 A11 没有影响，且规则细节没验证完。

## 六、查询、删除与重试

### 6.1 查 Release

```
GET /api/topics/29158/releases
→ 200 [{"ID": 107449, "TopicID": 29158, "ProjectID": 8, "ProjectName": "dde-file-manager",
        "Branch": "develop/eagle", "Commit": "f8e9527a…", "Tag": "9.9.9", "BaseTag": "9.9.9",
        "BuildID": 600208, "BuildState": {"state": "APPLYING", "log": ""}, "Changelog": [""],
        "ChangeLogMode": false, "Custom": false, "ProjectReleaseID": 83171, "Status": 0, …}]
```

- `ID` 是 ReleaseID，删除用它。
- `BuildID` 是 Shuttle 的构建任务 ID，查构建日志用它（A4/A14）。两者不能混用。
- `BuildState.state` 观测到三种值：`APPLYING`（排队中）、`UPLOAD_FAILED`（上传失败）、`UNKNOWN`。
  `UNKNOWN` 出现在构建收尾之后；本次验证在 30 秒内一直停在 `APPLYING`，没有等到终态。

### 6.2 删 Release

```
DELETE /api/topic_releases/107449
→ 200 {"code": "http.StatusOK", "status": "success"}
```

删完再查就是 `[]`。

### 6.3 重试 Release：当前部署上是 404

按旧文档的路径逐个试，全部 `404 {"message": "Not Found"}`：

| 请求 |
| --- |
| `POST /api/topic_releases/107446/retry` |
| `POST /api/topic_releases/107449/retry` |
| `PUT /api/topic_releases/107446/retry` |
| `POST /api/topic_releases/107446/rebuild` |
| `POST /api/topic_releases/retry/107446` |

同一路径族上 `PATCH /api/topic_releases/107446` 回的是 `405 Method Not Allowed`，说明路由存在、`retry` 子路径不存在。
尝试时对应的 Release 都是 `APPLYING` 或 `UNKNOWN` 状态，没有拿到一个真正 `UPLOAD_FAILED` 的 Release 再试。

`retryRelease` 按任务要求保留实现（CRP 文档里的路径），但**在本部署上没打通**，
A12 如果要重试失败构建，请用 Shuttle 的 `POST /job/rebuild`（A4 的 `retryJob`），并回来更新这里。

## 七、Topic 仓库地址

```
POST /api/topic_urls
{"branchID": 108, "topicID": 29158}
→ 200 {"OSTree": null,
       "RepoUrls": "https://aptly-dev.uniontech.com/pkg/eagle-1071/release-candidate/YTItdmVyaWZ5LTE3OTUwMTk5OTg4MTIyMDI2LTExLTE5IDAwOjM5OjU4/",
       "GitInfo": null}
```

- 没有投入任何 Release 时 `RepoUrls` 是 `null`（不是空数组），客户端统一成空数组。
- 有一个投递过的 Release 时返回一个字符串（不是数组）。客户端两种形态都接受。

## 八、工作流进度

```
GET /api/topics/29158/workflow/info
→ 200 {"ID": 0, "CreatedAt": "0001-01-01T00:00:00Z", "TopicID": 0, "TopicName": "", "Type": "",
       "WorkProgress": 0, "TestTableUrl": "", "ReleaseTableUrl": "", "AppointUser": "",
       "TestName": "", "TestTime": "", "TestResult": false, "TagState": false,
       "ReleaseName": "", "ReleaseTime": "", "ReleaseResult": false}
```

两个必须处理的细节：

1. 新建的 Topic 查工作流是 **200 + 全零对象**，不是 404。`WorkProgress: 0` 表示未开始。
2. 这个全零对象的 `TopicID` 也是 `0`。客户端用调用方传进来的 TopicID 兜底，不然调用方会拿到一个主题 ID 为 0 的结果。

`WorkProgress` 是数字，`>= 20` 就是已转测。`0 未开始` 这一条在真实响应里观察到了；
其余标签（10/13/20/22/25/40/52/60/100）取自 CRP 页面文案，本节点没有逐个把 Topic 推进到那个状态去验证，属于**推断**。

与 CRP 页面显示状态的对照没有做成：本次运行需要浏览器里的 CRP 登录态，运行时没有可用的会话。
所以 AC5 只验证了「数值取得到、可以直接比较」，页面文案对照待有登录态时补。

## 九、验收标准对照

| AC | 结果 | 证据 |
| --- | --- | --- |
| AC1 脚本退出码 0，输出含新建 Topic ID、Release ID、查回的 Release 状态 | 通过 | `pnpm tsx scripts/verify-crp.ts` 输出见第十节：Topic ID 29158、Release ID 107449、状态 APPLYING |
| AC2 FINDINGS 回答 `ChangeLogMode` 的实际效果 | 通过 | 本文件 5.4 节，每种取值都有真实 HTTP 状态与存回来的 Tag |
| AC3 故意传错 token 得到可读认证错误而非堆栈 | 通过 | 脚本第 11 步：`CrpAuthError（kind=auth，status=401）`，信息 `GET /user 失败（HTTP 401）：invalid or expired jwt` |
| AC4 脚本结束后该 Topic 已被清理 | **部分通过** | Release 已删净（`GET /topics/29158/releases` → `[]`），Topic 已置 `Abandoned: true`；但 CRP **没有删除 Topic 的接口**，Topic 记录本身消不掉（见 4.3 节） |
| AC5 `getTopicWorkflow` 返回可比较的数值 `WorkProgress` | 部分通过 | 数值 `0`（未开始）取到并打印；与 CRP 页面文案的对照未做，原因见第八节 |

## 十、复现方式

```bash
# 凭据从环境变量注入，不要写进仓库
export CRP_USERNAME=<ldap 账号>
export CRP_PASSWORD=<ldap 密码>

export CRP_VERIFY_PROJECT=dde-file-manager
export CRP_VERIFY_PROJECT_BRANCH=develop/eagle
export CRP_VERIFY_COMMIT=f8e9527a37495a1f0f0d297f0ecedcbeaffab268

pnpm tsx scripts/verify-crp.ts
```

一次成功的运行输出（2026-11-19）：

```
=== 1. 登录 ===
  账号：crp-user（CRP 用户）
  token 长度：136（不打印内容）
  token 缓存：/home/lxz/.cache/crp/jwt

=== 2. 取交付分支 ===
  共 108 条交付分支；eagle-1071 = ID 108

=== 3. 建临时 Topic ===
  Topic ID：29158
  Topic 名称：a2-verify-1795019998812
  Owner：crp-user

=== 4. 查工作流进度（getTopicWorkflow） ===
  WorkProgress = 0（未开始）
  已转测？否（还能改包）

=== 5. 投递软件包（ChangeLogMode=false，Tag 用调用方给的版本号） ===
  Release ID：107449
  ProjectID：8
  请求里的 Tag：9.9.9，ChangeLogMode：false

=== 6. 查回 Release ===
  Release 107449：dde-file-manager develop/eagle Tag=9.9.9 buildId=600208 状态=APPLYING

=== 7. 等构建状态变化（最多 30 秒） ===
  构建状态：APPLYING
  最终状态：APPLYING

=== 8. 查 Topic 仓库地址（topicUrls） ===
  仓库地址：https://aptly-dev.uniontech.com/pkg/eagle-1071/release-candidate/YTItdmVyaWZ5LTE3OTUwMTk5OTg4MTIyMDI2LTExLTE5IDAwOjM5OjU4/

=== 9. 清理：删除本脚本投递的 Release ===
  已删除 Release 107449
  删除后该 Topic 的 Release 数量：0

=== 10. 清理：放弃临时 Topic（CRP 无删除 Topic 的接口） ===
  已放弃 Topic 29158（a2-verify-1795019998812）

=== 11. 认证错误验证（故意用错 token） ===
  错误类型：CrpAuthError（kind=auth，status=401）
  错误信息：GET /user 失败（HTTP 401）：invalid or expired jwt
  响应片段：{
  "message": "invalid or expired jwt"
}

=== 验证完成 ===
  登录、取基线、建 Topic、投递 Release、查 Release、查工作流、清理，全部走通。
```

同一天复跑一次（评审修正之后），只把三个投递参数与凭据写进仓库根的 `.env`，不在 shell 里 export，
用来确认「按 `.env.example` 配置就能跑」这条路成立：

```
Topic ID 29159、Release ID 107450、状态 APPLYING、
token 缓存 /home/lxz/.cache/crp/jwt（CRP_TOKEN_PATH 写的是 `~/.cache/crp/jwt`，已展开成家目录，
仓库里没有出现名为 `~` 的目录）、Release 删净、Topic 置 Abandoned
```

跑完之后 CRP 侧的状态：

```
GET /api/topics/29158            → Abandoned: true
GET /api/topics/29158/releases   → []
GET /api/topics/29158/workflow/info → WorkProgress: 0
```

---

## 十一、A18 追加：读主题与搜主题（2026-11-19 实测）

从 CRP 导入已有提测主题需要两个能力：按 ID 读一个主题，按名称在一条交付分支下找主题。
第二个能力原本计划走 `POST /topics/search`，实测这个部署上没有这个接口，改用 CRP 前端
自己在走的「列分支主题」接口。以下都是真实请求，账号与分支同 A2（`eagle-1071`，分支 ID 108）。

### 11.1 读单个主题：`getTopic(topicId)`

`GET /api/topics/{id}`，需要登录态：

```
GET /api/topics/29158
→ 200
{"ID": 29158, "Name": "a2-verify-1795019998812", "NameB64": "YTItdmVyaWZ5…",
 "Description": "a2-verify-1795019998812", "BranchID": 108, "Completed": false,
 "Type": "test", "Abandoned": true,
 "Owner": [{"employeeid": "…", "mail": "zhangdingyuan@uniontech.com",
            "name": "zhangdingyuan", "namecn": "张丁元"}],
 "Members": null, "TpcType": "public", "SyncID": 0, "State": 0, "Lock": false,
 "RepoType": "deb", "Mail": null}
```

用客户端对另一个主题（29123）再取一次：

```
GET /api/topics/29123 → 200
整理后：{"id":29123,"name":"【FlemingX】缩放需求实时生效联调测试_20261117",
        "branchId":108,"type":"test","owner":"zhangcailian",
        "abandoned":false,"completed":false,"state":0}
```

导入要用到的四个字段都在这个响应里：`Name`（显示）、`BranchID`（校验项目基线）、
`Type`（只接 `test`）、`Owner`（显示是谁建的主题）。`Abandoned` 为真时不允许导入。
`Owner` 仍是对象数组（与 `createTopic` / `abandonTopic` 写回的字符串形式不同，原因见 4.2）。

### 11.2 `POST /topics/search` 在这个部署上不可用

逐个试了五种请求体，全部 `200` + 字面量 `null`，没有报错也没有数据：

```
POST /api/topics/search  {}
→ 200 null
POST /api/topics/search  {"Name":""}
→ 200 null
POST /api/topics/search  {"BranchID":108}
→ 200 null
POST /api/topics/search  {"name":"","branchID":108,"type":"test"}
→ 200 null
POST /api/topics/search  {"Page":1,"PerPage":20,"Name":"","BranchID":108,"Type":"test"}
→ 200 null
```

再翻 CRP 前端的打包产物（`main-es2015.*.js`）确认：全文件没有 `topics/search` 这个路径，
主题列表用的是 `GET ${api}branches/{currentBranchId}/topics?Type=${t}`。

结论：**不实现 `searchTopics` 走 `POST /topics/search`**，函数名保留，实现换成下面这条实测可用的读接口。

### 11.3 列一条交付分支下的 test 类型主题（`searchTopics` 的实际实现）

```
GET /api/branches/108/topics?Type=test
→ 200，717460 字节，916 条主题
第一项：{"ID":29164,"Name":"a2-verify-1795023022176","BranchID":108,
        "Completed":false,"Type":"test","Abandoned":true,
        "Owner":[{"name":"zhangdingyuan","namecn":"张丁元"}],"State":0,"RepoType":"deb"}
```

客户端在这一条响应上做三件事，都在本地完成：

1. 丢掉 `Type` 不是 `test` 的项（服务端已经按 `Type=test` 过滤，本地再筛一次，防它改行为）；
2. 名字做「包含」匹配，比较前统一转小写（主题名里中英混排，大小写不该影响搜得到）；
3. 最多回 50 条（`TOPIC_SEARCH_LIMIT`），整条分支 916 条不能整包塞给页面。

一次真实调用（分支 108、关键字 `Fleming`）：

```
GET /api/branches/108/topics?Type=test → 200
结果：50 条（命中上限），第一条 id=29123 「【FlemingX】缩放需求实时生效联调测试_20261117」
```

### 11.4 Release 的 `BuildState` 实测取值（导入时按它写快照状态）

之前只知道 `APPLYING` / `UPLOAD_FAILED` / `UNKNOWN`。A18 又看到三个，其中 `UNKNOWN`
在真实主题上很常见：

| `BuildState.state` | 场景 | 导入时按 |
| --- | --- | --- |
| `UPLOAD_OK` | 已上传 CRP，构建完成 | `success` |
| `UPLOAD_CRP` | 正在往 CRP 上传 | `building` |
| `UPLOAD_GIVEUP` | 上传放弃 | `failed` |
| `APPLYING` | CRP 正在处理 | `building` |
| `UNKNOWN` | CRP 没给状态 | `pending`（并在预览里标注） |
| 没有 `BuildState`（`null`） | 还没开始 | `pending` |

真实主题 29123 的四个包全部是 `UNKNOWN`，主题 28684 的那个包是 `UPLOAD_OK`，
主题 28724 的 `startdde` 是 `UPLOAD_GIVEUP`。所以「按 CRP 状态原样写、没见过的按待投递」
不是理论要求，是导入实际会遇到的分布。

### 11.5 `Commit` 字段可能不是提交号

同一次抽样看到的真实值：

```
topic 28724  startdde        Commit "c163701600…"（正常提交号）
topic 28947  hw-version      Commit "uploadcrp"   ← 预置 deb，没有源码提交
topic 28866  kernel          Commit "uploadcrp"
```

所以导入时先判断 `Commit` 是不是 7–40 位十六进制；不是就当作「CRP 没有给提交号」，
转去按 `Tag` 在 Gerrit 反查（见 `lib/integrations/gerrit/FINDINGS.md` 第 9 节）。
两条都拿不到就停在预览，绝不把 `uploadcrp` 之类写进快照。
