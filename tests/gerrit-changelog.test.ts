import assert from "node:assert/strict";
import test from "node:test";

import {
  ChangelogParseError,
  parseChangelog,
} from "../lib/integrations/gerrit/changelog";

const normalEntry = `demo (1.2.3-1) unstable; urgency=medium

  * 修复一个缺陷

 -- Zhang San <zhangsan@uniontech.com>  Mon, 06 Nov 2023 10:00:00 +0800
`;

test("正常 Debian 条目：解析出包名、版本号、发行版、紧急度与时间", () => {
  assert.deepEqual(parseChangelog(normalEntry), {
    packageName: "demo",
    version: "1.2.3-1",
    distribution: "unstable",
    urgency: "medium",
    date: "Mon, 06 Nov 2023 10:00:00 +0800",
  });
});

test("标题行没有版本号括号：抛出解析错误，并带上原始标题行", () => {
  const broken = `demo 1.2.3-1 unstable; urgency=medium

  * 缺括号

 -- Zhang San <zhangsan@uniontech.com>  Mon, 06 Nov 2023 10:00:00 +0800
`;

  assert.throws(
    () => parseChangelog(broken),
    (error: unknown) => {
      assert.ok(error instanceof ChangelogParseError);
      assert.match(error.message, /demo 1\.2\.3-1 unstable/);
      return true;
    },
  );
});

test("条目内有多处连续空行：仍然解析首条，不受空行数量影响", () => {
  const spongy = `demo (2.0.0~beta1) unstable; urgency=high


  * 第一段说明


  * 第二段说明



 -- Li Si <lisi@uniontech.com>  Tue, 07 Nov 2023 08:30:00 +0800


demo (1.9.0) unstable; urgency=low

  * 旧版本

 -- Li Si <lisi@uniontech.com>  Mon, 06 Nov 2023 08:30:00 +0800
`;

  const entry = parseChangelog(spongy);

  assert.equal(entry.packageName, "demo");
  assert.equal(entry.version, "2.0.0~beta1");
  assert.equal(entry.urgency, "high");
  assert.equal(entry.date, "Tue, 07 Nov 2023 08:30:00 +0800");
});

test("Windows 换行（CRLF）：解析结果与 LF 版本完全一致", () => {
  const crlf = normalEntry.replace(/\n/g, "\r\n");

  assert.deepEqual(parseChangelog(crlf), parseChangelog(normalEntry));
});

test("内容为空或只有空白：抛出解析错误，不返回空版本号", () => {
  assert.throws(() => parseChangelog(""), ChangelogParseError);
  assert.throws(() => parseChangelog("  \n\r\n\t\n"), ChangelogParseError);
});

test("有标题行但缺少维护者时间行：抛出解析错误，不编造时间", () => {
  const noTrailer = `demo (1.2.3-1) unstable; urgency=medium

  * 只有标题与说明
`;

  assert.throws(() => parseChangelog(noTrailer), ChangelogParseError);
});
