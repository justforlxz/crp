/**
 * 演练脚本里可以单测的纯逻辑：版本号换算、参数校验、定时入口返回体的错误提取、
 * 从 base URL 打开的重定向链断言。
 *
 * 这些规则以前写在 `scripts/e2e.ts` 里，只能靠跑一次真实构建来验证，改错了也看不出来。
 * 抽到这里之后，`tests/e2e-support.test.ts` 用表驱动逐条锁住：
 *
 * | 代码版本 | CRP 项目前缀 | 提测版本 | 依据 |
 * | --- | --- | --- | --- |
 * | `4:6.1.57` | `4:` | `6.1.57` | `docs/RUNBOOK.md` 6.1.1，epoch 会被 CRP 再拼一次 |
 * | `1.10.0.32-deepin33-1` | `` | `1.10.0.32` | 同上，CRP 不接受调用方传来的 `-` |
 * | `2:1.21.0.10` | `` | `2:1.21.0.10` | 项目没有前缀时原样使用 |
 *
 * 这里不碰网络、不碰数据库、不读环境变量：只有入参与返回值。
 */

/** 一次版本号换算的结果。`reasons` 是要写进日志的原因，为空表示原样使用。 */
export type TagAdjustment = {
  tag: string;
  reasons: string[];
};

/**
 * 把 `debian/changelog` 的版本换算成真正发给 CRP 的提测版本（`customTag`）。
 *
 * 两条规则都有实测支撑，见 `docs/RUNBOOK.md` 第十一节「待确认的两处」：
 *
 * 1. CRP 项目带 `PkgVerPrefix`（例如 `4:`）时，前缀由 CRP 拼，调用方必须去掉同一个 epoch，
 *    否则 `4:` + `4:6.1.57` 会拼成 `4:4:6.1.57`，apply 阶段直接 `APPLY_FAILED`。
 * 2. 调用方显式给 `Tag` 时 CRP 不接受 `-`，而 `debian/changelog` 的版本常带 Debian 修订号
 *    （`1.10.0.32-deepin33-1`）。截到第一个 `-` 之前：`1.10.0.32` 仍高于仓库里已有的
 *    `1.10.0.28-1`，不会变成降级。
 */
export function adjustTagForProject(codeVersion: string, pkgVerPrefix: string): TagAdjustment {
  const reasons: string[] = [];
  let tag = codeVersion;

  const prefix = pkgVerPrefix.trim();
  if (prefix !== "" && tag.startsWith(prefix)) {
    tag = tag.slice(prefix.length);
    reasons.push(`去掉 epoch（CRP 项目自带前缀 ${JSON.stringify(prefix)}）`);
  }

  const dash = tag.indexOf("-");
  if (dash > 0) {
    reasons.push(`截掉 Debian 修订号 ${JSON.stringify(tag.slice(dash))}（CRP 不接受 '-'）`);
    tag = tag.slice(0, dash);
  }

  return { tag, reasons };
}

/** `--fault` 允许的取值。 */
export const FAULT_MODES = ["none", "upstream"] as const;

export type FaultMode = (typeof FAULT_MODES)[number];

/**
 * 解析 `--fault`。
 *
 * 只认白名单：拼错成 `--fault=upstrem` 时直接报错退出，而不是安静地跑一遍正常演练、
 * 让「故障演练通过」变成假证据。
 */
export function parseFaultMode(value: string | undefined): FaultMode {
  if (value === undefined) {
    return "none";
  }

  const matched = FAULT_MODES.find((item) => item === value);
  if (matched === undefined) {
    throw new Error(
      `--fault 只接受 ${FAULT_MODES.join(" / ")}，收到的是 ${JSON.stringify(value)}。` +
        "拼错时不会退化成正常演练，这里直接报错。",
    );
  }

  return matched;
}

/** 定时入口返回体里，属于本次提测的失败原因 + 其它提测的失败原因（只用来打印）。 */
export type JobFailures = {
  /** 本次提测的**真失败**：非空即判演练失败。 */
  own: string[];
  /** 本次提测的已知「还没到时机」提示：打印出来，不影响判断。 */
  tolerated: string[];
  /** 别的提测的错误（种子数据、别人的提测）：打印出来便于定位，但不影响本次演练。 */
  others: string[];
};

/** 其它提测最多回显这么多条，避免整轮日志被别人的失败刷满。 */
const OTHER_FAILURE_LIMIT = 5;

type JobItem = {
  releaseId?: unknown;
  error?: unknown;
  action?: unknown;
};

/**
 * 从定时入口的返回体里挑出错误。
 *
 * 这两个入口（`/api/jobs/build-dispatch`、`/api/jobs/build-poll`）的约定是
 * 「单条失败仍回 HTTP 200，明细在 `items[].error`，另有 `failed` 计数」。
 * 所以只看 HTTP 状态是不够的：CRP 账号密码错、Shuttle 不可用、某条提测推进抛错，
 * 状态码都是 200，真正的原因只在 `items[].error` 里。
 *
 * 三条分流规则：
 *
 * 1. 属于本次提测、且不是已知的「还没到时机」提示 → `own`，调用方要判失败；
 * 2. 属于本次提测、但是已知提示（新建 Topic 头几轮的「全零对象」）→ `tolerated`，只打印；
 * 3. 属于别的提测 → `others`，只打印（种子里那几条提测指向真实但不属于本次演练的主题，
 *    它们失败是常态，不能拿来判本次演练的成败）。
 *
 * 哪些文案算「已知提示」由调用方传进来（`tolerated`）：文案的真身在
 * `lib/build/poller.ts` 的 `WORKFLOW_PROGRESS_PENDING_MESSAGE`，这里只做集合判断，
 * 既不抄字符串，也不把 `lib` 的副作用（连库）带进这个纯逻辑模块。
 */
export function collectJobFailures(
  body: unknown,
  releaseId: string,
  tolerated: ReadonlySet<string> = new Set<string>(),
): JobFailures {
  const own: string[] = [];
  const toleratedMessages: string[] = [];
  const others: string[] = [];

  if (typeof body !== "object" || body === null) {
    return { own, tolerated: toleratedMessages, others };
  }

  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return { own, tolerated: toleratedMessages, others };
  }

  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }

    const item = raw as JobItem;
    const itemReleaseId = typeof item.releaseId === "string" ? item.releaseId : "";
    const message = describeItemFailure(item);

    if (message === null) {
      continue;
    }

    if (itemReleaseId !== releaseId) {
      if (others.length < OTHER_FAILURE_LIMIT) {
        others.push(`${itemReleaseId || "（没有 releaseId）"} → ${message}`);
      }
      continue;
    }

    if (tolerated.has(message)) {
      toleratedMessages.push(message);
    } else {
      own.push(message);
    }
  }

  return { own, tolerated: toleratedMessages, others };
}

/** 一条提测的错误原因：优先用 `error` 原文，只有 `action === "error"` 时补一句说明。 */
function describeItemFailure(item: JobItem): string | null {
  if (typeof item.error === "string" && item.error.trim() !== "") {
    return item.error;
  }

  if (item.action === "error") {
    return "定时入口报告这条提测推进出错，但没有给出原因";
  }
  return null;
}

/**
 * 「补包」这半边要看的证据。
 *
 * 补包（append）与换包（replace）是两件事：补进来的包只需要进新一轮快照，
 * 没有旧产物要作废，所以它只出现在 `plan.appendedPackageNames` 里，**不在**
 * `plan.redispatchedPackageNames` 里 —— 后者的含义是「被换掉的包 + 它的全部传递下游」，
 * 只补包时为空的数组。这条语义以 `lib/releases/update.ts` 的实现为准
 * （PL 已在 MKACG-890 里确认），不要为了让断言通过去改业务代码。
 */
export type AppendEvidence = {
  /** 应该被补进来的包名。 */
  packageName: string;
  /** 更新接口返回的 `plan.appendedPackageNames`；`null` 表示这一步还没执行。 */
  appendedPackageNames: readonly string[] | null;
  /** 更新后重新读到的投递快照里的包名；`null` 表示还没重新读。 */
  snapshotPackageNames: readonly string[] | null;
};

/**
 * 检查「补进来的包真的进了提测」，返回不成立的证据（空数组表示全部成立）。
 *
 * 抽成纯函数是为了能单测：跑一次真实演练要一小时，而这里只要喂一份假数据，
 * 就能证明「字段缺失时断言会失败、字段存在时会通过」。断言只活在真实演练里时，
 * 补包被平台静默丢弃也看不出来，会出现脚本假绿。
 */
export function checkAppendLanded(evidence: AppendEvidence): string[] {
  const problems: string[] = [];
  const { packageName } = evidence;

  if (evidence.appendedPackageNames !== null && !evidence.appendedPackageNames.includes(packageName)) {
    problems.push(
      `更新接口的补包名单里没有 ${packageName}：实际有 ${joinOrEmpty(evidence.appendedPackageNames)}`,
    );
  }

  if (evidence.snapshotPackageNames !== null && !evidence.snapshotPackageNames.includes(packageName)) {
    problems.push(
      `新一轮快照里没有补进来的 ${packageName}：实际有 ${joinOrEmpty(evidence.snapshotPackageNames)}`,
    );
  }

  if (evidence.appendedPackageNames === null && evidence.snapshotPackageNames === null) {
    problems.push(`补包没有提供任何证据：${packageName} 既没有更新接口的名单，也没有新一轮快照`);
  }

  return problems;
}

/** 名单为空时打印「（空）」，免得日志里出现一串空白认不出是空。 */
function joinOrEmpty(names: readonly string[]): string {
  return names.length === 0 ? "（空）" : names.join("、");
}

// ---------------------------------------------------------------------------
// 从 base URL 打开（MKACG-959）
// ---------------------------------------------------------------------------

/**
 * 占位页的原文。
 *
 * A1 建骨架时 `app/page.tsx` 就写着这句话，37 个节点都做完了它还活着 —— 用户从 base URL
 * 打开，第一眼看到的是「还没开始」。页面已在 MKACG-958 删掉，这里留一份原文当断言：
 * 只要它重新出现在 `/` 的响应里，就说明占位页又回来了。
 */
export const PLACEHOLDER_TEXT = "项目骨架已就绪，业务页面按节点计划在后续实现。";

/** 重定向链上的一跳。 */
export type RedirectHop = {
  /** 请求的路径（含查询串），例如 `/login?next=%2Fdashboard`。 */
  path: string;
  /** 这一跳的响应状态码。 */
  status: number;
  /** `Location` 响应头；不是重定向时为 `null`。 */
  location: string | null;
};

/** 从 `/` 起步的一次采样：整条重定向链 + 最后一跳的响应体。 */
export type BaseUrlEntry = {
  hops: readonly RedirectHop[];
  /** 最后一跳的响应体（HTML）。 */
  body: string;
};

/** 从 base URL 打开要看的两种身份。 */
export type BaseUrlEvidence = {
  /** 不带会话。 */
  anonymous: BaseUrlEntry;
  /** 带会话。 */
  session: BaseUrlEntry;
};

/** 根路径的重定向目标。 */
const DASHBOARD_PATH = "/dashboard";
/** 未登录时 `/dashboard` 的守卫把页面送到哪里。 */
const LOGIN_PATH = "/login";
/** 根路径必须是临时重定向（307），理由见 `next.config.ts` 的注释。 */
const ROOT_STATUS = 307;
/** 登录页与工作台都应当是 200。 */
const PAGE_STATUS = 200;

/**
 * 检查「从 base URL 打开」的两种身份，返回不成立的证据（空数组表示全部成立）。
 *
 * 抽成纯函数是为了能单测：跑一次真实演练要一小时，而这里喂一份假的重定向链，就能证明
 * 「重定向被删掉时断言会失败、占位页回来时断言会失败」。断言只活在真实演练里时，改坏了
 * 也没人知道 —— MKACG-931 那轮的「脚本假绿」就是这么来的。
 *
 * 判定口径（`docs/RUNBOOK.md` 第十节）：
 *
 * 1. 两种身份的 `/` 都必须 307 到 `/dashboard`，且真的继续跳；
 * 2. 不带会话最终落在 `/login`，且 `next` 是 `/dashboard`（登录成功后回工作台）；
 * 3. 带会话最终落在 `/dashboard`；
 * 4. 两种身份的响应体里都不许出现占位页原文。
 */
export function checkBaseUrlEntry(evidence: BaseUrlEvidence): string[] {
  return [
    ...checkEntry("不带会话", evidence.anonymous, checkAnonymousLanding),
    ...checkEntry("带会话", evidence.session, checkSessionLanding),
  ];
}

/**
 * 一种身份：先查 `/` 的重定向，链成立再查落地。
 *
 * 链本身就不成立时不再比落地：否则同一条重定向会报两遍（「没从 / 起步」+「没落在 /login」），
 * 真正的第一处问题反而被淹掉。
 */
function checkEntry(
  label: string,
  entry: BaseUrlEntry,
  landing: (entry: BaseUrlEntry) => string[],
): string[] {
  const problems = checkRootRedirect(label, entry);

  return problems.length > 0 ? problems : landing(entry);
}

/** 两种身份共用的前半段：`/` 必须是 307 到 `/dashboard`，且真的继续跳了。 */
function checkRootRedirect(label: string, entry: BaseUrlEntry): string[] {
  const first = entry.hops[0];

  if (first === undefined || first.path !== "/") {
    return [`${label}：没有从 / 起步，实际 ${describeRedirectChain(entry.hops)}`];
  }

  const problems: string[] = [];

  if (first.status !== ROOT_STATUS) {
    problems.push(
      `${label}：/ 必须是 ${ROOT_STATUS} 临时重定向，实际 ${first.status}（${describeRedirectChain(entry.hops)}）`,
    );
  }

  if (first.location !== DASHBOARD_PATH) {
    problems.push(
      `${label}：/ 应当重定向到 ${DASHBOARD_PATH}，实际 ` +
        `${first.location === null ? "没有 Location 响应头" : first.location}`,
    );
  }

  if (entry.hops.length < 2) {
    problems.push(`${label}：/ 之后没有继续跳转，链只有 ${describeRedirectChain(entry.hops)}`);
  }

  return problems;
}

/** 不带会话：最终落在登录页，且 `next` 指回工作台。 */
function checkAnonymousLanding(entry: BaseUrlEntry): string[] {
  const final = entry.hops.at(-1);
  if (final === undefined) {
    return ["不带会话：一跳都没有，什么都没验到"];
  }

  const problems: string[] = [];
  const path = parseHopPath(final.path);

  if (path.pathname !== LOGIN_PATH) {
    problems.push(
      `不带会话：最终应当落在 ${LOGIN_PATH}，实际 ${path.pathname}（${describeRedirectChain(entry.hops)}）`,
    );
  } else if (path.searchParams.get("next") !== DASHBOARD_PATH) {
    problems.push(
      `不带会话：登录页的 next 应当是 ${DASHBOARD_PATH}，实际 ` +
        `${path.searchParams.get("next") ?? "没有 next 参数"}（${describeRedirectChain(entry.hops)}）`,
    );
  }

  if (final.status !== PAGE_STATUS) {
    problems.push(
      `不带会话：登录页应当是 ${PAGE_STATUS}，实际 ${final.status}（${describeRedirectChain(entry.hops)}）`,
    );
  }

  return [...problems, ...checkNoPlaceholder("不带会话", entry.body)];
}

/** 带会话：最终落在工作台，且响应体里没有占位页原文。 */
function checkSessionLanding(entry: BaseUrlEntry): string[] {
  const final = entry.hops.at(-1);
  if (final === undefined) {
    return ["带会话：一跳都没有，什么都没验到"];
  }

  const problems: string[] = [];
  const path = parseHopPath(final.path);

  if (path.pathname !== DASHBOARD_PATH) {
    problems.push(
      `带会话：最终应当落在 ${DASHBOARD_PATH}，实际 ${path.pathname}（${describeRedirectChain(entry.hops)}）`,
    );
  }

  if (final.status !== PAGE_STATUS) {
    problems.push(
      `带会话：工作台应当是 ${PAGE_STATUS}，实际 ${final.status}（${describeRedirectChain(entry.hops)}）`,
    );
  }

  return [...problems, ...checkNoPlaceholder("带会话", entry.body)];
}

/** 占位页原文出现在响应体里就判失败：`/` 不该再渲染任何页面。 */
function checkNoPlaceholder(label: string, body: string): string[] {
  if (!body.includes(PLACEHOLDER_TEXT)) {
    return [];
  }

  return [`${label}：响应里出现了占位页原文「${PLACEHOLDER_TEXT}」，占位页又回来了`];
}

/** 把一跳的路径拆成 pathname 与查询串；`path` 本来就是相对路径，不需要真的地址。 */
function parseHopPath(path: string): URL {
  return new URL(path, "http://hop.invalid");
}

/** 把整条链写成一行，断言失败时能直接看出停在哪一跳。 */
export function describeRedirectChain(hops: readonly RedirectHop[]): string {
  if (hops.length === 0) {
    return "（没有任何一跳）";
  }

  return hops
    .map((hop) => `${hop.path} ${hop.status}${hop.location === null ? "" : ` → ${hop.location}`}`)
    .join("；");
}
