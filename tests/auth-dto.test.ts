import assert from "node:assert/strict";
import test from "node:test";

import { publicAccount, publicProject, publicWorkspace } from "../lib/auth/dto";
import type { AccountRecord } from "../lib/auth/store";

const account: AccountRecord = {
  id: "user-1",
  email: "user@example.com",
  displayName: "李四",
  isPlatformAdmin: false,
};

test("账号对外形态只含四个字段，不带任何密码字段（MUST：响应里不出现明文或哈希）", () => {
  const shape = publicAccount(account);

  assert.deepEqual(shape, account);
  assert.deepEqual(Object.keys(shape).sort(), [
    "displayName",
    "email",
    "id",
    "isPlatformAdmin",
  ]);
});

test("即使上游记录多带了哈希，对外形态也不会把它带出去", () => {
  const withHash: AccountRecord & { passwordHash: string } = {
    ...account,
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
  };
  const leaked = publicAccount(withHash);

  const serialized = JSON.stringify(leaked);
  assert.equal(serialized.includes("argon2"), false);
  assert.equal(serialized.includes("passwordHash"), false);
});

test("工作区与项目对外形态逐字段挑取，不多带字段", () => {
  assert.deepEqual(publicWorkspace({ id: "ws-1", slug: "desktop-core", name: "桌面核心组" }, "reader"), {
    id: "ws-1",
    slug: "desktop-core",
    name: "桌面核心组",
    role: "reader",
  });

  assert.deepEqual(publicProject({ id: "p-1", key: "kwin", name: "窗口管理器" }), {
    id: "p-1",
    key: "kwin",
    name: "窗口管理器",
  });
});
