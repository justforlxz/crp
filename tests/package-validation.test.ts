import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PAYLOAD_ITEMS,
  parsePackageInput,
  parsePackagePayload,
} from "../lib/packages/validation";

const VALID = {
  name: "kwin",
  repoPath: "deepin-kde/kwin",
  defaultBranch: "develop/eagle",
  currentVersion: "5.27.10.2-1",
};

test("合法单条按字段原样返回", () => {
  const result = parsePackageInput(VALID);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, VALID);
});

test("currentVersion 可以不填，返回 null", () => {
  const result = parsePackageInput({
    name: "kwin",
    repoPath: "deepin-kde/kwin",
    defaultBranch: "develop/eagle",
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.currentVersion, null);
});

test("首尾空白被去掉", () => {
  const result = parsePackageInput({
    name: "  kwin ",
    repoPath: " deepin-kde/kwin ",
    defaultBranch: " develop/eagle ",
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.name, "kwin");
  assert.equal(result.ok && result.value.repoPath, "deepin-kde/kwin");
});

test("缺 name 时报出字段名", () => {
  const result = parsePackageInput({ ...VALID, name: "" });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.errors.map((item) => item.field),
    ["name"],
  );
});

test("name 用大写字母时被拒绝", () => {
  const result = parsePackageInput({ ...VALID, name: "KWin" });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.errors[0].message, /name/);
});

test("repoPath 带首尾斜杠时被拒绝", () => {
  for (const repoPath of ["/deepin-kde/kwin", "deepin-kde/kwin/", "deepin//kwin"]) {
    const result = parsePackageInput({ ...VALID, repoPath });
    assert.equal(result.ok, false, `${repoPath} 应当被拒绝`);
  }
});

test("defaultBranch 含空白时被拒绝", () => {
  const result = parsePackageInput({ ...VALID, defaultBranch: "develop eagle" });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.errors.map((item) => item.field),
    ["defaultBranch"],
  );
});

test("字段不是字符串时报错", () => {
  const result = parsePackageInput({ ...VALID, name: 42 });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.errors[0].message, /字符串/);
});

test("请求体是单条对象时当作一条处理", () => {
  const result = parsePackagePayload(VALID);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.length, 1);
});

test("请求体是数组时逐条校验，错误字段带下标", () => {
  const result = parsePackagePayload([
    VALID,
    { name: "", repoPath: "x/y", defaultBranch: "main" },
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.errors.map((item) => item.field),
    ["items[1].name"],
  );
});

test("数组里有一条不合法就整批拒绝，不返回部分结果", () => {
  const result = parsePackagePayload([VALID, "not-an-object"]);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.ok ? [] : result.errors.map((item) => item.field),
    ["items[1]"],
  );
});

test("空数组被拒绝", () => {
  const result = parsePackagePayload([]);

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.errors[0].message, /空数组/);
});

test("条目数超过上限被拒绝", () => {
  const items = Array.from({ length: MAX_PAYLOAD_ITEMS + 1 }, (_, index) => ({
    ...VALID,
    name: `pkg-${index}`,
  }));

  const result = parsePackagePayload(items);

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.errors[0].message, /最多/);
});

test("请求体不是对象也不是数组时被拒绝", () => {
  for (const body of [null, "kwin", 42]) {
    const result = parsePackagePayload(body);
    assert.equal(result.ok, false, `${String(body)} 应当被拒绝`);
  }
});
