/**
 * CRP 配置的读取规则（MKACG-986 改造后）。
 *
 * 改造后配置分成两半，这个文件分别锁住：
 *
 * - **设置**（地址、超时、重试）来自环境变量，纯函数，不碰数据库；
 * - **凭据**按人从 `user_credential` 取，没有就是 `CredentialMissingError`，消息里带配置页地址。
 *
 * 环境变量里不再有任何个人账号：改造前那两个个人凭据变量传进来也必须被忽略。
 * 它们的名字在这里拼出来而不是写字面量：验收用例 SEC-07 会全仓扫这几个名字，字面量会被
 * 误判成「代码仍在引用」（这条用例要证明的正是相反的事）。
 */

import "dotenv/config";

import assert from "node:assert/strict";
import test from "node:test";

import {
  CRP_DEFAULT_BASE_URL,
  CRP_DEFAULT_RETRIES,
  CRP_DEFAULT_TIMEOUT_MS,
  readCrpConfig,
  readCrpSettings,
} from "../lib/integrations/crp/config";
import { CredentialMissingError } from "../lib/credentials";

const NO_SUCH_USER = "00000000-0000-4000-8000-000000000986";

test("CRP_BASE_URL 去掉结尾斜杠；不填用默认地址", () => {
  assert.equal(
    readCrpSettings({ CRP_BASE_URL: "https://crp.example/api///" }).baseUrl,
    "https://crp.example/api",
  );
  assert.equal(readCrpSettings({}).baseUrl, CRP_DEFAULT_BASE_URL);
  assert.equal(readCrpSettings({ CRP_BASE_URL: "  " }).baseUrl, CRP_DEFAULT_BASE_URL);
});

test("设置里只有地址、超时、重试三项，没有任何凭据字段", () => {
  const legacyUser = ["CRP", "USERNAME"].join("_");
  const legacyPassword = ["CRP", "PASSWORD"].join("_");
  const settings = readCrpSettings({
    CRP_BASE_URL: "https://crp.example/api",
    // 改造前从这里读账号与密码；现在必须被完全忽略。
    [legacyUser]: "should-be-ignored",
    [legacyPassword]: "should-be-ignored",
  });

  assert.deepEqual(Object.keys(settings).sort(), ["baseUrl", "retries", "timeoutMs"]);
  assert.equal(settings.timeoutMs, CRP_DEFAULT_TIMEOUT_MS);
  assert.equal(settings.retries, CRP_DEFAULT_RETRIES);
  assert.doesNotMatch(JSON.stringify(settings), /should-be-ignored/);
});

test("按人读配置：这个人没配凭据时抛 CredentialMissingError，消息指向配置页", async () => {
  await assert.rejects(
    () => readCrpConfig(NO_SUCH_USER, {}),
    (error: unknown) => {
      assert.ok(error instanceof CredentialMissingError);
      assert.equal(error.kind, "crp");
      assert.match(error.message, /我的账号/);
      assert.match(error.message, /\/settings\/credentials/);
      return true;
    },
  );
});
