import assert from "node:assert/strict";
import test from "node:test";

import {
  joinFieldErrors,
  parseManagerInput,
  parseProjectInput,
  parseProjectSoftwareInput,
} from "../lib/projects/validation";

function fields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "桌面专业版 V25",
    key: "desktop-v25",
    projectManagerId: "manager-1",
    baselineId: "baseline-1",
    description: "",
    ...overrides,
  };
}

test("字段齐全时原样通过，说明留空变成 null", () => {
  const parsed = parseProjectInput(fields());

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value : null, {
    name: "桌面专业版 V25",
    key: "desktop-v25",
    projectManagerId: "manager-1",
    baselineId: "baseline-1",
    description: null,
  });
});

test("没选项目经理时拒绝，并说明项目必须指定一位属于本工作区的项目经理", () => {
  const parsed = parseProjectInput(fields({ projectManagerId: "" }));

  assert.equal(parsed.ok, false);
  const errors = parsed.ok ? [] : parsed.errors;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "projectManagerId");
  assert.match(errors[0].message, /请选择项目经理/);
  assert.match(errors[0].message, /属于本工作区的项目经理/);
});

test("没选基线时拒绝，并说明必须绑定已同步的基线", () => {
  const parsed = parseProjectInput(fields({ baselineId: "   " }));

  assert.equal(parsed.ok, false);
  const errors = parsed.ok ? [] : parsed.errors;
  assert.equal(errors[0].field, "baselineId");
  assert.match(errors[0].message, /请选择 CRP 基线/);
});

test("项目标识只接受小写字母、数字与连字符", () => {
  for (const key of ["Desktop-V25", "desktop_v25", "桌面", "-desktop", "desktop v25"]) {
    const parsed = parseProjectInput(fields({ key }));

    assert.equal(parsed.ok, false, `${key} 不该通过`);
    const errors = parsed.ok ? [] : parsed.errors;
    assert.equal(errors[0].field, "key");
  }

  for (const key of ["desktop-v25", "v25", "a1"]) {
    assert.equal(parseProjectInput(fields({ key })).ok, true, `${key} 该通过`);
  }
});

test("名称与标识两端的空白被裁掉", () => {
  const parsed = parseProjectInput(fields({ name: "  安全组件  ", key: " security-suite  " }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.name : null, "安全组件");
  assert.equal(parsed.ok ? parsed.value.key : null, "security-suite");
});

test("名称空着时拒绝", () => {
  const parsed = parseProjectInput(fields({ name: "" }));

  assert.equal(parsed.ok, false);
  const errors = parsed.ok ? [] : parsed.errors;
  assert.equal(errors[0].field, "name");
  assert.match(errors[0].message, /项目名称不能为空/);
});

test("项目经理姓名空着时拒绝", () => {
  const parsed = parseManagerInput({ name: "  " });

  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.errors[0].message, /姓名不能为空/);
});

test("项目经理姓名裁掉两端空白", () => {
  const parsed = parseManagerInput({ name: " 刘洋 " });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.name : null, "刘洋");
});

test("项目经理的邮箱裁掉两端空白后原样保存", () => {
  const parsed = parseManagerInput({ name: "刘洋", email: " liuyang@uniontech.com " });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.email : "unexpected", "liuyang@uniontech.com");
});

test("项目经理没填邮箱时保存为 null，不编占位地址", () => {
  const parsed = parseManagerInput({ name: "刘洋", email: "   " });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.email : "unexpected", null);
});

test("项目经理的邮箱格式不对时拒绝", () => {
  const parsed = parseManagerInput({ name: "刘洋", email: "not-an-email" });

  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? "" : parsed.errors[0].field, "email");
  assert.match(parsed.ok ? "" : parsed.errors[0].message, /邮箱格式/);
});

test("跟踪分支不能包含空白字符", () => {
  const parsed = parseProjectSoftwareInput({
    packageId: "package-1",
    trackedBranch: "develop/eagle ",
  });

  // 两端空白被裁掉之后没有内部空白，这是允许的。
  assert.equal(parsed.ok, true);

  const withInner = parseProjectSoftwareInput({
    packageId: "package-1",
    trackedBranch: "develop /eagle",
  });

  assert.equal(withInner.ok, false);
  assert.match(withInner.ok ? "" : withInner.errors[0].message, /不能包含空白字符/);
});

test("没选软件包时拒绝", () => {
  const parsed = parseProjectSoftwareInput({ packageId: "", trackedBranch: "develop/eagle" });

  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.errors[0].message, /请选择要加入清单的软件包/);
});

test("多个字段出错时逐条给出来，拼成一句话", () => {
  const parsed = parseProjectInput(fields({ name: "", key: "", projectManagerId: "", baselineId: "" }));

  assert.equal(parsed.ok, false);
  const errors = parsed.ok ? [] : parsed.errors;
  assert.equal(errors.length, 4);

  const message = joinFieldErrors(errors);
  assert.equal(message.split("；").length, 4);
});

test("传入的不是一组字段时给出说明", () => {
  assert.equal(parseProjectInput(null).ok, false);
  assert.equal(parseProjectInput("desktop-v25").ok, false);
  assert.equal(parseProjectInput([]).ok, false);
});
