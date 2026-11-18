import assert from "node:assert/strict";
import test from "node:test";

import { readEnv } from "../lib/env";

test("缺少 DATABASE_URL 时抛出错误并指出变量名", () => {
  assert.throws(() => readEnv({}), /DATABASE_URL/);
});

test("DATABASE_URL 只有空白字符时按缺失处理", () => {
  assert.throws(() => readEnv({ DATABASE_URL: "   " }), /DATABASE_URL/);
});

test("读取 DATABASE_URL 时去掉首尾空白，其余变量不进入结果", () => {
  const env = readEnv({
    DATABASE_URL: " postgresql://crp:crp@localhost:5432/crp ",
    UNUSED: "ignored",
  });

  assert.deepEqual(env, { DATABASE_URL: "postgresql://crp:crp@localhost:5432/crp" });
});
