/**
 * 演练脚本的纯逻辑（`scripts/e2e-support.ts`）。
 *
 * 这些期望值不是编的，来源写在 `docs/RUNBOOK.md` 6.1.1 与第十一节：
 * 版本号两条换算规则各有一条真实 CRP 响应做依据；`items[].error` 的口径来自
 * `lib/jobs/build-dispatch.ts` 与 `lib/build/poller.ts` 的类型定义（单条失败仍回 200）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustTagForProject,
  checkAppendLanded,
  collectJobFailures,
  parseFaultMode,
} from "../scripts/e2e-support";

// ---------------------------------------------------------------------------
// 版本号换算
// ---------------------------------------------------------------------------

test("项目带 PkgVerPrefix 时去掉同一个 epoch", () => {
  const result = adjustTagForProject("4:6.1.57", "4:");

  assert.equal(result.tag, "6.1.57");
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0]!, /去掉 epoch/);
});

test("changelog 版本带 Debian 修订号时截到第一个 '-' 之前", () => {
  const result = adjustTagForProject("1.10.0.32-deepin33-1", "");

  assert.equal(result.tag, "1.10.0.32");
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0]!, /截掉 Debian 修订号/);
});

test("项目没有前缀、版本也没有 '-' 时原样使用", () => {
  const result = adjustTagForProject("2:1.21.0.10", "");

  assert.equal(result.tag, "2:1.21.0.10");
  assert.deepEqual(result.reasons, []);
});

test("两条规则同时命中：先去掉 epoch，再截掉修订号", () => {
  const result = adjustTagForProject("4:6.1.57-deepin1", "4:");

  assert.equal(result.tag, "6.1.57");
  assert.equal(result.reasons.length, 2);
});

test("前缀与 epoch 不同时不动它：不能把别人的版本号改坏", () => {
  const result = adjustTagForProject("2:1.21.0.10", "4:");

  assert.equal(result.tag, "2:1.21.0.10");
});

test("前缀为空串时不按空前缀切掉首位", () => {
  assert.equal(adjustTagForProject("6.1.57", "").tag, "6.1.57");
  assert.equal(adjustTagForProject("6.1.57", "   ").tag, "6.1.57");
});

test("'-' 出现在第 0 位时不切，避免得到空 Tag", () => {
  const result = adjustTagForProject("-1.0.0", "");

  assert.equal(result.tag, "-1.0.0");
  assert.deepEqual(result.reasons, []);
});

// ---------------------------------------------------------------------------
// --fault 取值
// ---------------------------------------------------------------------------

test("--fault 缺省是 none", () => {
  assert.equal(parseFaultMode(undefined), "none");
});

test("--fault 认得白名单里的两个值", () => {
  assert.equal(parseFaultMode("none"), "none");
  assert.equal(parseFaultMode("upstream"), "upstream");
});

test("--fault 拼错时直接报错，不退化成正常演练", () => {
  assert.throws(() => parseFaultMode("upstrem"), /--fault 只接受/);
});

// ---------------------------------------------------------------------------
// 定时入口返回体的错误提取
// ---------------------------------------------------------------------------

const RELEASE_ID = "01a1f600-0000-7000-8000-000000000001";

test("本次提测出错时，把 error 原文带出来", () => {
  const body = {
    trigger: "schedule",
    releaseCount: 2,
    failed: 1,
    items: [
      {
        releaseId: RELEASE_ID,
        action: "error",
        error: "CrpAuthError: POST /login 失败（HTTP 401）：Unauthorized",
      },
      { releaseId: "other", action: "dispatch", error: null },
    ],
  };

  const failures = collectJobFailures(body, RELEASE_ID);

  assert.equal(failures.own.length, 1);
  assert.match(failures.own[0]!, /CrpAuthError/);
  assert.deepEqual(failures.tolerated, []);
  assert.deepEqual(failures.others, []);
});

test("别的提测出错不影响本次演练，但要打印出来", () => {
  const body = {
    items: [
      { releaseId: RELEASE_ID, action: "dispatch", error: null },
      { releaseId: "seed-release", action: "error", error: "ShuttleError: 请求 Shuttle 失败：… 已超时" },
    ],
  };

  const failures = collectJobFailures(body, RELEASE_ID);

  assert.deepEqual(failures.own, []);
  assert.equal(failures.others.length, 1);
  assert.match(failures.others[0]!, /seed-release/);
});

test("action 是 error 但没给原因时也要算作失败", () => {
  const failures = collectJobFailures(
    { items: [{ releaseId: RELEASE_ID, action: "error", error: null }] },
    RELEASE_ID,
  );

  assert.equal(failures.own.length, 1);
  assert.match(failures.own[0]!, /没有给出原因/);
});

test("返回体不是对象、items 不是数组时不抛异常", () => {
  const empty = { own: [], tolerated: [], others: [] };
  assert.deepEqual(collectJobFailures(null, RELEASE_ID), empty);
  assert.deepEqual(collectJobFailures("200 OK", RELEASE_ID), empty);
  assert.deepEqual(collectJobFailures({ items: "nope" }, RELEASE_ID), empty);
});

test("调用方声明为「还没到时机」的文案只归到 tolerated，不判失败", () => {
  const pending = "CRP 返回的工作流信息里没有可用的进度（全零对象）";
  const failures = collectJobFailures(
    { items: [{ releaseId: RELEASE_ID, error: pending }] },
    RELEASE_ID,
    new Set([pending]),
  );

  assert.deepEqual(failures.own, []);
  assert.deepEqual(failures.tolerated, [pending]);
});

test("别的提测最多回显 5 条，避免刷满日志", () => {
  const items = Array.from({ length: 8 }, (_unused, index) => ({
    releaseId: `other-${index}`,
    action: "error",
    error: "boom",
  }));

  const failures = collectJobFailures({ items }, RELEASE_ID);

  assert.equal(failures.others.length, 5);
});

// ---------------------------------------------------------------------------
// A17「补包」断言
// ---------------------------------------------------------------------------

const APPENDED = "xwayland";
/** 一次真实演练里更新后的快照：wayland、kwin 与补进来的 xwayland。 */
const SNAPSHOT_NAMES = ["wayland", "kwin", "xwayland"] as const;

test("更新接口说补了、快照里也有，断言通过", () => {
  assert.deepEqual(
    checkAppendLanded({
      packageName: APPENDED,
      appendedPackageNames: [APPENDED],
      snapshotPackageNames: SNAPSHOT_NAMES,
    }),
    [],
  );
});

test("补包名单里没有该包时断言失败，并把实际名单说出来", () => {
  const problems = checkAppendLanded({
    packageName: APPENDED,
    appendedPackageNames: [],
    snapshotPackageNames: SNAPSHOT_NAMES,
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /补包名单里没有 xwayland/);
  assert.match(problems[0]!, /（空）/);
});

test("更新接口引了包、但新一轮快照里没有时断言失败", () => {
  const problems = checkAppendLanded({
    packageName: APPENDED,
    appendedPackageNames: [APPENDED],
    snapshotPackageNames: ["wayland", "kwin"],
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /新一轮快照里没有补进来的 xwayland/);
  assert.match(problems[0]!, /wayland、kwin/);
});

test("两处都缺时两条理由都报出来", () => {
  const problems = checkAppendLanded({
    packageName: APPENDED,
    appendedPackageNames: ["plasma-wayland-protocols"],
    snapshotPackageNames: ["wayland", "kwin"],
  });

  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /补包名单里没有 xwayland/);
  assert.match(problems[1]!, /新一轮快照里没有补进来的 xwayland/);
});

test("预演阶段只有名单：名单里有该包就通过", () => {
  assert.deepEqual(
    checkAppendLanded({
      packageName: APPENDED,
      appendedPackageNames: [APPENDED],
      snapshotPackageNames: null,
    }),
    [],
  );
});

test("预演阶段名单里没有该包时照样失败", () => {
  const problems = checkAppendLanded({
    packageName: APPENDED,
    appendedPackageNames: ["wayland"],
    snapshotPackageNames: null,
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /补包名单里没有 xwayland/);
});

test("一份证据都不给时不能静默通过", () => {
  const problems = checkAppendLanded({
    packageName: APPENDED,
    appendedPackageNames: null,
    snapshotPackageNames: null,
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /没有提供任何证据/);
});
