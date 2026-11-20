/**
 * 演练脚本里可以单测的纯逻辑：版本号换算、参数校验、定时入口返回体的错误提取。
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
