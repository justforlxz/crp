/**
 * 提测记录列表的 CSV 导出（界面规范 v2）。
 *
 * 锁住三件事：
 *
 * - 表头与表格列顺序一致，空视图也出表头（导出的文件不是空文件）；
 * - 含逗号、双引号、换行的值按 RFC 4180 加引号，不把整行列数打乱；
 * - 一行的字段顺序与条数固定，加一列必须同时改表头与行。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildReleaseListCsv, type ReleaseListCsvRow } from "../app/(app)/releases/listCsv";

const ROW: ReleaseListCsvRow = {
  version: "25.0.2",
  projectName: "桌面专业版 V25",
  projectKey: "desktop-v25",
  revision: 2,
  packageCount: 6,
  statusLabel: "构建中",
  createdByName: "刘洋",
  createdAt: "2026-11-19 03:00 UTC",
};

test("表头与表格列顺序一致", () => {
  const [header] = buildReleaseListCsv([]).split("\n");

  assert.equal(header, "提测版本,所属项目,项目标识,轮次,软件包数,状态,创建人,创建时间");
});

test("空视图也出表头", () => {
  assert.equal(buildReleaseListCsv([]), "提测版本,所属项目,项目标识,轮次,软件包数,状态,创建人,创建时间\n");
});

test("一行的字段顺序与表格一致", () => {
  const lines = buildReleaseListCsv([ROW]).trimEnd().split("\n");

  assert.equal(lines.length, 2);
  assert.equal(lines[1], "25.0.2,桌面专业版 V25,desktop-v25,2,6,构建中,刘洋,2026-11-19 03:00 UTC");
});

test("含逗号、双引号、换行的值按 RFC 4180 加引号", () => {
  const lines = buildReleaseListCsv([
    { ...ROW, projectName: '桌面,专业版 "V25"' },
  ]).trimEnd().split("\n");

  assert.equal(
    lines[1],
    '25.0.2,"桌面,专业版 ""V25""",desktop-v25,2,6,构建中,刘洋,2026-11-19 03:00 UTC',
  );
});

test("以公式前缀开头的值加单引号，表格软件按文本处理", () => {
  const lines = buildReleaseListCsv([
    { ...ROW, projectName: "=HYPERLINK(\"http://evil\")", version: "+25.0.2", createdByName: "@someone" },
  ]).trimEnd().split("\n");

  assert.match(lines[1] ?? "", /^'\+25\.0\.2,"'=HYPERLINK/u);
  assert.match(lines[1] ?? "", /,'@someone,/u);
});

test("行的顺序就是传进来的顺序", () => {
  const lines = buildReleaseListCsv([ROW, { ...ROW, version: "25.0.1" }]).trimEnd().split("\n");

  assert.match(lines[1] ?? "", /^25\.0\.2,/u);
  assert.match(lines[2] ?? "", /^25\.0\.1,/u);
});
