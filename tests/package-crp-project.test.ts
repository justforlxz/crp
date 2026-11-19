/**
 * 「软件包名」与「CRP 项目名」的解析与校验（A16 缺陷修复的 AC1）。
 *
 * 纯函数，不连库：`resolveCrpProjectName` 是投递与认领共用的唯一入口，
 * `parsePackageInput` 是 `POST /api/packages` 与登记页面共用的入口，两边都必须挡住
 * 「只有空白字符」这种看起来填了、实际等于没填的值。
 *
 * 名字里的下划线是真实情况：分支 108 上 `deepin-kde/kwin` 与 `deepin-kde/wayland`
 * 只有带下划线的 CRP 项目名，所以这里用 `v25_kwin` 与
 * `v25_wayland` 两个实测名字做样本。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CRP_PROJECT_NAME_MAX_LENGTH,
  CrpProjectNameError,
  isValidCrpProjectName,
  resolveCrpProjectName,
} from "../lib/packages/crpProject";
import { parsePackageInput, parsePackagePayload } from "../lib/packages/validation";

const KWIN_CRP_NAME = "v25_kwin";
const WAYLAND_CRP_NAME = "v25_wayland";

const VALID = {
  name: "kwin",
  repoPath: "deepin-kde/kwin",
  defaultBranch: "develop/eagle",
  currentVersion: "5.27.10.2-1",
};

// ---------------------------------------------------------------------------
// 解析：投递与认领共用的那一个函数
// ---------------------------------------------------------------------------

test("没登记 CRP 项目名时回落到包名", () => {
  assert.equal(resolveCrpProjectName({ name: "kwin" }), "kwin");
  assert.equal(resolveCrpProjectName({ name: "kwin", crpProjectName: null }), "kwin");
  assert.equal(resolveCrpProjectName({ name: "wayland", crpProjectName: null }), "wayland");
});

test("登记了 CRP 项目名时用它，不碰包名", () => {
  assert.equal(resolveCrpProjectName({ name: "kwin", crpProjectName: KWIN_CRP_NAME }), KWIN_CRP_NAME);
  assert.equal(
    resolveCrpProjectName({ name: "wayland", crpProjectName: WAYLAND_CRP_NAME }),
    WAYLAND_CRP_NAME,
  );
  // 首尾空白不算名字的一部分：CRP 的查询按精确相等匹配，带空白一定查不到。
  assert.equal(
    resolveCrpProjectName({ name: "kwin", crpProjectName: `  ${KWIN_CRP_NAME}  ` }),
    KWIN_CRP_NAME,
  );
});

test("只有空白字符的 CRP 项目名按非法输入拒绝，不静默回落到包名", () => {
  for (const value of ["", " ", "\t", "\n", "   \t \n "]) {
    assert.throws(
      () => resolveCrpProjectName({ name: "kwin", crpProjectName: value }),
      (error: unknown) => {
        assert.ok(error instanceof CrpProjectNameError, `${JSON.stringify(value)} 应当被拒绝`);
        // 错误里要能看出是哪个包、填了什么，否则运维不知道该去改哪一行。
        assert.match(error.message, /kwin/);

        return true;
      },
      `${JSON.stringify(value)} 必须报错`,
    );
  }
});

test("含空白字符或超长的 CRP 项目名按非法输入拒绝", () => {
  assert.throws(
    () => resolveCrpProjectName({ name: "kwin", crpProjectName: "deepin kde kwin" }),
    CrpProjectNameError,
  );
  assert.throws(
    () =>
      resolveCrpProjectName({
        name: "kwin",
        crpProjectName: "a".repeat(CRP_PROJECT_NAME_MAX_LENGTH + 1),
      }),
    CrpProjectNameError,
  );
});

test("CRP 项目名的合法性判定：允许下划线，不允许空白与空值", () => {
  assert.equal(isValidCrpProjectName(KWIN_CRP_NAME), true);
  assert.equal(isValidCrpProjectName(WAYLAND_CRP_NAME), true);
  assert.equal(isValidCrpProjectName("dde-kwin"), true);
  assert.equal(isValidCrpProjectName("KWin_Upper"), true);
  assert.equal(isValidCrpProjectName("a".repeat(CRP_PROJECT_NAME_MAX_LENGTH)), true);

  assert.equal(isValidCrpProjectName(""), false);
  assert.equal(isValidCrpProjectName("   "), false);
  assert.equal(isValidCrpProjectName("deepin kde"), false);
  assert.equal(isValidCrpProjectName("deepin\tkde"), false);
  assert.equal(isValidCrpProjectName("a".repeat(CRP_PROJECT_NAME_MAX_LENGTH + 1)), false);
});

// ---------------------------------------------------------------------------
// 登记校验：POST /api/packages 与登记页面共用
// ---------------------------------------------------------------------------

test("登记时接受带下划线的 CRP 项目名，返回去空白后的值", () => {
  const result = parsePackageInput({ ...VALID, crpProjectName: ` ${KWIN_CRP_NAME} ` });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.crpProjectName, KWIN_CRP_NAME);
  // 包名规则没被放宽：CRP 项目名允许下划线，包名仍然不允许。
  assert.equal(result.ok && result.value.name, "kwin");
});

test("不填 CRP 项目名时为空，表示与包名相同", () => {
  const missing = parsePackageInput(VALID);
  assert.equal(missing.ok, true);
  assert.equal(missing.ok && missing.value.crpProjectName, null);

  const empty = parsePackageInput({ ...VALID, crpProjectName: "" });
  assert.equal(empty.ok, true);
  assert.equal(empty.ok && empty.value.crpProjectName, null);
});

test("登记时不接受只有空白字符的 CRP 项目名：报在 crpProjectName 字段上", () => {
  for (const value of ["   ", "\t"]) {
    const result = parsePackageInput({ ...VALID, crpProjectName: value });

    assert.equal(result.ok, false, `${JSON.stringify(value)} 应当被拒绝`);
    if (!result.ok) {
      assert.deepEqual(
        result.errors.map((item) => item.field),
        ["crpProjectName"],
      );
    }
  }
});

test("登记时不接受含空白字符或超长的 CRP 项目名", () => {
  const spaced = parsePackageInput({ ...VALID, crpProjectName: "deepin kde kwin" });
  assert.equal(spaced.ok, false);
  assert.deepEqual(
    spaced.ok ? [] : spaced.errors.map((item) => item.field),
    ["crpProjectName"],
  );

  const long = parsePackageInput({
    ...VALID,
    crpProjectName: "a".repeat(CRP_PROJECT_NAME_MAX_LENGTH + 1),
  });
  assert.equal(long.ok, false);
  assert.deepEqual(
    long.ok ? [] : long.errors.map((item) => item.field),
    ["crpProjectName"],
  );
});

test("数组提交里 CRP 项目名出错的字段带下标", () => {
  const result = parsePackagePayload([
    { ...VALID, name: "kwin" },
    { ...VALID, name: "wayland", repoPath: "deepin-kde/wayland", crpProjectName: "  " },
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.errors.map((item) => item.field),
    ["items[1].crpProjectName"],
  );
});
