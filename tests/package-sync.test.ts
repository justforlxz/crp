import assert from "node:assert/strict";
import test from "node:test";

import { fetchPackageMetadata, PackageSyncError } from "../lib/packages/sync";

const PKG = { repoPath: "deepin-kde/kwin", defaultBranch: "develop/eagle" };

function fakeGerrit(options: {
  branches?: { ref: string; branch: string; revision: string }[];
  changelogVersion?: string;
}) {
  const calls: string[] = [];

  return {
    calls,
    client: {
      async listBranches(project: string) {
        calls.push(`listBranches:${project}`);
        return options.branches ?? [];
      },
      async readChangelog(project: string, ref: string) {
        calls.push(`readChangelog:${project}:${ref}`);
        return { entry: { version: options.changelogVersion ?? "5.27.10.2-1" } };
      },
    },
  };
}

test("取默认分支的当前提交与 changelog 版本", async () => {
  const gerrit = fakeGerrit({
    branches: [
      { ref: "refs/heads/develop/master", branch: "develop/master", revision: "aaaa111" },
      { ref: "refs/heads/develop/eagle", branch: "develop/eagle", revision: "bbbb222" },
    ],
    changelogVersion: "5.27.10.2-1",
  });

  const result = await fetchPackageMetadata(gerrit.client, PKG);

  assert.deepEqual(result, {
    defaultBranch: "develop/eagle",
    currentCommit: "bbbb222",
    currentVersion: "5.27.10.2-1",
  });
});

test("按分支名匹配，不去读其他分支的 changelog", async () => {
  const gerrit = fakeGerrit({
    branches: [
      { ref: "refs/heads/develop/master", branch: "develop/master", revision: "aaaa111" },
      { ref: "refs/heads/develop/eagle", branch: "develop/eagle", revision: "bbbb222" },
    ],
  });

  await fetchPackageMetadata(gerrit.client, PKG);

  assert.deepEqual(gerrit.calls, [
    "listBranches:deepin-kde/kwin",
    "readChangelog:deepin-kde/kwin:bbbb222",
  ]);
});

test("默认分支在 Gerrit 上不存在时报错，并指出分支名", async () => {
  const gerrit = fakeGerrit({
    branches: [
      { ref: "refs/heads/develop/master", branch: "develop/master", revision: "aaaa111" },
    ],
  });

  await assert.rejects(
    () => fetchPackageMetadata(gerrit.client, PKG),
    (error: unknown) => {
      assert.ok(error instanceof PackageSyncError);
      assert.match((error as Error).message, /develop\/eagle/);
      return true;
    },
  );
});

test("登记的是完整 ref 时也能匹配", async () => {
  const gerrit = fakeGerrit({
    branches: [
      { ref: "refs/heads/develop/eagle", branch: "develop/eagle", revision: "bbbb222" },
    ],
  });

  const result = await fetchPackageMetadata(gerrit.client, {
    repoPath: "deepin-kde/kwin",
    defaultBranch: "refs/heads/develop/eagle",
  });

  assert.equal(result.currentCommit, "bbbb222");
});
