/**
 * 「我的账号」接口的对外形态（MKACG-986 / CRED-2）。
 *
 * 锁住一件事：响应里只有「配没配、账号名、最后验证时间、最后错误」，
 * 没有密码、没有密文、没有向量与标签。这条检查放在 JSON 转换这一层，
 * 因为它是库里那一行离开服务端的唯一出口。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test from "node:test";

import { credentialJson } from "../app/api/settings/credentials/route";
import { toCredentialView } from "../lib/credentials";

const VERIFIED_AT = new Date("2026-11-24T08:30:00.000Z");

test("已配置的凭据只导出六个字段，没有密码", () => {
  const row = {
    kind: "crp" as const,
    username: "alice",
    verifiedAt: VERIFIED_AT,
    lastError: null,
  };

  const json = credentialJson(toCredentialView("crp", row));

  assert.deepEqual(json, {
    kind: "crp",
    label: "CRP 账号",
    configured: true,
    username: "alice",
    verifiedAt: "2026-11-24T08:30:00.000Z",
    lastError: null,
  });
});

test("未配置的凭据只有 kind / label / configured 有值", () => {
  const json = credentialJson(toCredentialView("gerrit", null));

  assert.deepEqual(json, {
    kind: "gerrit",
    label: "Gerrit 账号",
    configured: false,
    username: null,
    verifiedAt: null,
    lastError: null,
  });
});

test("最后错误原样带出，但里面不会出现密码", () => {
  const json = credentialJson(
    toCredentialView("crp", {
      kind: "crp",
      username: "alice",
      verifiedAt: null,
      lastError: "CRP 拒绝登录（HTTP 401）",
    }),
  );

  assert.equal(json.lastError, "CRP 拒绝登录（HTTP 401）");

  const serialized = JSON.stringify(json);
  for (const forbidden of ["secret", "ciphertext", "iv", "tag", "keyVersion", "password"]) {
    assert.ok(!serialized.includes(forbidden), `响应里出现了 ${forbidden}`);
  }
});
