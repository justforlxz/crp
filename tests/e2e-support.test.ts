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
  PLACEHOLDER_TEXT,
  adjustTagForProject,
  checkAppendLanded,
  checkBaseUrlEntry,
  collectJobFailures,
  describeRedirectChain,
  parseFaultMode,
  type BaseUrlEntry,
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

// ---------------------------------------------------------------------------
// 从 base URL 打开
// ---------------------------------------------------------------------------

/** 一条正常的匿名链：`/` → 307 `/dashboard` → 307 登录页 → 200。 */
function healthyAnonymousChain(): BaseUrlEntry {
  return {
    hops: [
      { path: "/", status: 307, location: "/dashboard" },
      { path: "/dashboard", status: 307, location: "/login?next=%2Fdashboard" },
      { path: "/login?next=%2Fdashboard", status: 200, location: null },
    ],
    body: "<html>登录</html>",
  };
}

/** 一条正常的带会话链：`/` → 307 `/dashboard` → 200 工作台。 */
function healthySessionChain(): BaseUrlEntry {
  return {
    hops: [
      { path: "/", status: 307, location: "/dashboard" },
      { path: "/dashboard", status: 200, location: null },
    ],
    body: "<html>工作台</html>",
  };
}

test("两种身份都从 / 落到该去的地方时通过", () => {
  const problems = checkBaseUrlEntry({
    anonymous: healthyAnonymousChain(),
    session: healthySessionChain(),
  });

  assert.deepEqual(problems, []);
});

test("重定向被删掉（/ 直接 404）时失败，并带出实际状态码", () => {
  const problems = checkBaseUrlEntry({
    anonymous: { hops: [{ path: "/", status: 404, location: null }], body: "404" },
    session: healthySessionChain(),
  });

  assert.ok(problems.length >= 1);
  assert.match(problems.join("；"), /不带会话：\/ 必须是 307 临时重定向，实际 404/);
});

test("用 308 永久重定向时失败：浏览器会把目标缓存下来", () => {
  const problems = checkBaseUrlEntry({
    anonymous: healthyAnonymousChain(),
    session: {
      hops: [
        { path: "/", status: 308, location: "/dashboard" },
        { path: "/dashboard", status: 200, location: null },
      ],
      body: "<html>工作台</html>",
    },
  });

  assert.match(problems.join("；"), /带会话：\/ 必须是 307 临时重定向，实际 308/);
});

test("/ 重定向到别处时失败，并说出跳到了哪", () => {
  const problems = checkBaseUrlEntry({
    anonymous: healthyAnonymousChain(),
    session: {
      hops: [
        { path: "/", status: 307, location: "/releases" },
        { path: "/releases", status: 200, location: null },
      ],
      body: "<html>提测记录</html>",
    },
  });

  assert.match(problems.join("；"), /带会话：\/ 应当重定向到 \/dashboard，实际 \/releases/);
});

test("/ 之后没有继续跳转时失败：只写了重定向、没人接着处理", () => {
  const problems = checkBaseUrlEntry({
    anonymous: { hops: [{ path: "/", status: 307, location: "/dashboard" }], body: "" },
    session: healthySessionChain(),
  });

  assert.match(problems.join("；"), /不带会话：\/ 之后没有继续跳转/);
});

test("不带会话停在 /dashboard 时失败：守卫没把未登录的人送到登录页", () => {
  const problems = checkBaseUrlEntry({
    anonymous: {
      hops: [
        { path: "/", status: 307, location: "/dashboard" },
        { path: "/dashboard", status: 200, location: null },
      ],
      body: "<html>工作台</html>",
    },
    session: healthySessionChain(),
  });

  assert.match(problems.join("；"), /不带会话：最终应当落在 \/login，实际 \/dashboard/);
});

test("登录页丢了 next 参数时失败：登录成功后回不到工作台", () => {
  const problems = checkBaseUrlEntry({
    anonymous: {
      hops: [
        { path: "/", status: 307, location: "/dashboard" },
        { path: "/dashboard", status: 307, location: "/login" },
        { path: "/login", status: 200, location: null },
      ],
      body: "<html>登录</html>",
    },
    session: healthySessionChain(),
  });

  assert.match(problems.join("；"), /不带会话：登录页的 next 应当是 \/dashboard，实际 没有 next 参数/);
});

test("next 指向别处时失败：登录后会回到 / 再弹一次", () => {
  const problems = checkBaseUrlEntry({
    anonymous: {
      hops: [
        { path: "/", status: 307, location: "/dashboard" },
        { path: "/dashboard", status: 307, location: "/login?next=%2F" },
        { path: "/login?next=%2F", status: 200, location: null },
      ],
      body: "<html>登录</html>",
    },
    session: healthySessionChain(),
  });

  assert.match(problems.join("；"), /不带会话：登录页的 next 应当是 \/dashboard，实际 \//);
});

test("带会话被踢回登录页时失败：会话没被认出来", () => {
  const problems = checkBaseUrlEntry({
    anonymous: healthyAnonymousChain(),
    session: {
      hops: [
        { path: "/", status: 307, location: "/dashboard" },
        { path: "/dashboard", status: 307, location: "/login?next=%2Fdashboard" },
        { path: "/login?next=%2Fdashboard", status: 200, location: null },
      ],
      body: "<html>登录</html>",
    },
  });

  assert.match(problems.join("；"), /带会话：最终应当落在 \/dashboard，实际 \/login/);
});

test("占位页回来时两种身份都失败，并把原文带出来", () => {
  const placeholder = `<html><p>${PLACEHOLDER_TEXT}</p></html>`;
  const problems = checkBaseUrlEntry({
    anonymous: { ...healthyAnonymousChain(), body: placeholder },
    session: { ...healthySessionChain(), body: placeholder },
  });

  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /不带会话：响应里出现了占位页原文/);
  assert.match(problems[1]!, /带会话：响应里出现了占位页原文/);
});

test("第一跳不是 / 时直接判失败，不再往下比", () => {
  const problems = checkBaseUrlEntry({
    anonymous: { hops: [{ path: "/login", status: 200, location: null }], body: "" },
    session: healthySessionChain(),
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /不带会话：没有从 \/ 起步/);
});

test("一跳都没有时不能静默通过", () => {
  const problems = checkBaseUrlEntry({
    anonymous: { hops: [], body: "" },
    session: { hops: [], body: "" },
  });

  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /不带会话：没有从 \/ 起步，实际 （没有任何一跳）/);
  assert.match(problems[1]!, /带会话：没有从 \/ 起步，实际 （没有任何一跳）/);
});

test("重定向链打印成一整行，失败时能看出停在哪一跳", () => {
  assert.equal(
    describeRedirectChain(healthyAnonymousChain().hops),
    "/ 307 → /dashboard；/dashboard 307 → /login?next=%2Fdashboard；/login?next=%2Fdashboard 200",
  );
  assert.equal(describeRedirectChain([]), "（没有任何一跳）");
});
