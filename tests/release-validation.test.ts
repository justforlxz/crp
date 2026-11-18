/**
 * 创建提测的输入校验单元测试。
 *
 * 锁的是「提交什么才算一次合法提测」：项目与版本号必填、每个包必须给分支与十六进制提交号、
 * 自定义 Tag 必须满足 CRP 实测出来的四条格式限制、提交的软件包清单必须与项目清单完全一致。
 *
 * 自定义 Tag 的规则不在这里重写，直接对照 `lib/integrations/crp/tag.ts` 的四条实测结论。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { comparePackageSet, parseReleaseInput } from "../lib/releases/validation";

const SHA = "4f0b1d2e8c9a7b6d5e4f3a2b1c0d9e8f7a6b5c4d";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    version: "25.0.2",
    description: "V25 第二个提测",
    packages: [
      { packageName: "kwin", branch: "develop/eagle", commitSha: SHA, customTag: null },
    ],
    ...overrides,
  };
}

test("合法输入通过，自定义 Tag 没填就是 null", () => {
  const parsed = parseReleaseInput(payload());

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.value.projectId, "project-1");
  assert.equal(parsed.value.version, "25.0.2");
  assert.equal(parsed.value.description, "V25 第二个提测");
  assert.deepEqual(parsed.value.packages, [
    { packageName: "kwin", branch: "develop/eagle", commitSha: SHA, customTag: null },
  ]);
});

test("请求体不是对象时直接拒绝", () => {
  for (const raw of [null, [], "text", 42]) {
    const parsed = parseReleaseInput(raw);

    assert.equal(parsed.ok, false, String(raw));
  }
});

test("项目、版本号、软件包清单都必填", () => {
  const parsed = parseReleaseInput({});

  assert.equal(parsed.ok, false);

  if (parsed.ok) {
    return;
  }

  assert.deepEqual(
    parsed.errors.map((error) => error.field),
    ["projectId", "version", "packages"],
  );
});

test("Topic 版本号不能包含空白字符", () => {
  const parsed = parseReleaseInput(payload({ version: "25 0 2" }));

  assert.equal(parsed.ok, false);

  if (parsed.ok) {
    return;
  }

  assert.ok(parsed.errors.some((error) => error.field === "version" && /空白/.test(error.message)));
});

test("Topic 版本号过长被拒绝", () => {
  const parsed = parseReleaseInput(payload({ version: "1".repeat(101) }));

  assert.equal(parsed.ok, false);
});

test("软件包清单为空被拒绝", () => {
  const parsed = parseReleaseInput(payload({ packages: [] }));

  assert.equal(parsed.ok, false);

  if (parsed.ok) {
    return;
  }

  assert.equal(parsed.errors[0].field, "packages");
  assert.match(parsed.errors[0].message, /至少一个软件包/);
});

test("软件包缺分支或缺 Commit 都被拒绝，字段名带下标", () => {
  const parsed = parseReleaseInput(
    payload({
      packages: [
        { packageName: "kwin", commitSha: SHA },
        { packageName: "dde-dock", branch: "develop/eagle" },
      ],
    }),
  );

  assert.equal(parsed.ok, false);

  if (parsed.ok) {
    return;
  }

  assert.deepEqual(
    parsed.errors.map((error) => error.field),
    ["packages[0].branch", "packages[1].commitSha"],
  );
});

test("Commit 必须是十六进制提交号，分支名不算", () => {
  const parsed = parseReleaseInput(
    payload({
      packages: [{ packageName: "kwin", branch: "develop/eagle", commitSha: "develop/eagle" }],
    }),
  );

  assert.equal(parsed.ok, false);

  if (parsed.ok) {
    return;
  }

  assert.equal(parsed.errors[0].field, "packages[0].commitSha");
  assert.match(parsed.errors[0].message, /十六进制提交号/);
});

test("短提交号（7 位）也接受", () => {
  const parsed = parseReleaseInput(
    payload({
      packages: [{ packageName: "kwin", branch: "develop/eagle", commitSha: "4f0b1d2" }],
    }),
  );

  assert.equal(parsed.ok, true);
});

test("自定义 Tag 的四条 CRP 限制全部当场拒绝，并说明规则", () => {
  const cases = [
    { tag: "7.7.7-rc1", pattern: /连字符/ },
    { tag: "9.9.9_1", pattern: /下划线/ },
    { tag: "9.9.9 rc", pattern: /空格/ },
    { tag: "v9.9.9", pattern: /数字开头/ },
  ];

  for (const item of cases) {
    const parsed = parseReleaseInput(
      payload({
        packages: [
          { packageName: "kwin", branch: "develop/eagle", commitSha: SHA, customTag: item.tag },
        ],
      }),
    );

    assert.equal(parsed.ok, false, item.tag);

    if (parsed.ok) {
      continue;
    }

    assert.equal(parsed.errors[0].field, "packages[0].customTag");
    assert.match(parsed.errors[0].message, item.pattern);
  }
});

test("CRP 接受的自定义 Tag 放行，原样保留", () => {
  for (const tag of ["9.9.9", "9.9.9+deb1", "9.9.9~rc1"]) {
    const parsed = parseReleaseInput(
      payload({
        packages: [
          { packageName: "kwin", branch: "develop/eagle", commitSha: SHA, customTag: tag },
        ],
      }),
    );

    assert.equal(parsed.ok, true, tag);

    if (parsed.ok) {
      assert.equal(parsed.value.packages[0].customTag, tag);
    }
  }
});

test("自定义 Tag 只填空格视为没填", () => {
  const parsed = parseReleaseInput(
    payload({
      packages: [
        { packageName: "kwin", branch: "develop/eagle", commitSha: SHA, customTag: "   " },
      ],
    }),
  );

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    assert.equal(parsed.value.packages[0].customTag, null);
  }
});

test("清单比对：少包、多包、重复包分别报出来", () => {
  assert.deepEqual(comparePackageSet(["a", "b", "c"], ["a", "b", "c"]), {
    missing: [],
    unexpected: [],
    duplicated: [],
  });

  assert.deepEqual(comparePackageSet(["a", "b", "c"], ["a", "b"]), {
    missing: ["c"],
    unexpected: [],
    duplicated: [],
  });

  assert.deepEqual(comparePackageSet(["a", "b"], ["a", "b", "d"]), {
    missing: [],
    unexpected: ["d"],
    duplicated: [],
  });

  assert.deepEqual(comparePackageSet(["a", "b"], ["a", "b", "a"]), {
    missing: [],
    unexpected: [],
    duplicated: ["a"],
  });
});

test("清单比对不看顺序：顺序由依赖拓扑排序决定", () => {
  assert.deepEqual(comparePackageSet(["a", "b"], ["b", "a"]), {
    missing: [],
    unexpected: [],
    duplicated: [],
  });
});
