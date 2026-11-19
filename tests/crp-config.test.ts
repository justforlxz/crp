import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CRP_DEFAULT_TOKEN_PATH,
  expandHomePath,
  readCrpConfig,
} from "../lib/integrations/crp/config";
import { CrpInvalidParameterError } from "../lib/integrations/crp/errors";
import { buildNewReleasePayload } from "../lib/integrations/crp/releases";

test("CRP_TOKEN_PATH 写 ~ 开头时展开成家目录，不建字面 ~ 目录", () => {
  assert.equal(expandHomePath("~/.cache/crp/jwt"), join(homedir(), ".cache/crp/jwt"));
  assert.equal(expandHomePath("~"), homedir());
  assert.equal(expandHomePath("~/"), homedir());
});

test("绝对路径与相对路径原样保留，不做额外改写", () => {
  assert.equal(expandHomePath("/var/tmp/jwt"), "/var/tmp/jwt");
  assert.equal(expandHomePath("./cache/jwt"), "./cache/jwt");
  // 只有开头的 ~ 有特殊含义，中间的不动。
  assert.equal(expandHomePath("/data/~backup/jwt"), "/data/~backup/jwt");
  assert.equal(expandHomePath("~crp/jwt"), "~crp/jwt");
});

test("配置里的 tokenPath 走展开：按 .env.example 的示例值也能落到家目录", () => {
  const config = readCrpConfig({
    CRP_USERNAME: "crp-user",
    CRP_PASSWORD: "secret",
    CRP_TOKEN_PATH: "~/.cache/crp/jwt",
  });

  assert.equal(config.tokenPath, join(homedir(), ".cache/crp/jwt"));
  assert.notEqual(config.tokenPath.split("/").at(-2), "~");
});

test("不配 CRP_TOKEN_PATH 时用默认家目录路径，不依赖当前工作目录", () => {
  const config = readCrpConfig({ CRP_USERNAME: "crp-user", CRP_PASSWORD: "secret" });

  assert.equal(config.tokenPath, CRP_DEFAULT_TOKEN_PATH);
  assert.ok(config.tokenPath.startsWith(homedir()));
});

test("缺凭据时说清缺哪个变量", () => {
  assert.throws(
    () => readCrpConfig({}),
    (error: unknown) =>
      error instanceof CrpInvalidParameterError &&
      error.message.includes("CRP_USERNAME") &&
      error.message.includes("CRP_PASSWORD"),
  );
});

test("投递请求体按 CRP 原生约定组装：BranchID 是字符串、Changelog 是数组", () => {
  const payload = buildNewReleasePayload(
    {
      topicId: 29157,
      projectName: "dde-file-manager",
      branch: "develop/eagle",
      commit: "f8e9527a",
      branchId: 108,
      tag: "9.9.9",
      arches: "amd64;arm64",
    },
    8,
    "9.9.9",
    false,
  );

  assert.equal(payload.BranchID, "108");
  assert.equal(payload.ProjectID, 8);
  assert.equal(payload.TopicID, 29157);
  assert.deepEqual(payload.Changelog, [""]);
  assert.equal(payload.ChangeLogMode, false);
  assert.equal(payload.Tag, "9.9.9");
  assert.equal(payload.TopicType, "test");
  assert.equal(payload.RepoType, "deb");
  // 架构集合原样来自调用方（提测所属基线），请求体里不再有代码里的默认值。
  assert.equal(payload.Arches, "amd64;arm64");
});
