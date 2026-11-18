import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseTag } from "../lib/integrations/crp/tag";
import {
  normalizeTopicWorkflow,
  WORK_PROGRESS,
  WORK_PROGRESS_TRANSFERRED_TO_TEST,
  workProgressLabel,
} from "../lib/integrations/crp/workflow";

test("实测被 CRP 接受的版本号一个都不拦", () => {
  for (const tag of ["1", "9.9.9", "9.9.9+deb1", "9.9.9~rc1", "0.1.0"]) {
    assert.equal(validateReleaseTag(tag), null, `${tag} 应该通过`);
  }
});

test("实测被 CRP 拒绝的版本号，本地先拦下并说明 CRP 的原话", () => {
  const cases: [string, RegExp][] = [
    ["", /不能为空/],
    ["   ", /不能为空/],
    ["7.7.7-rc1", /连字符/],
    ["9.9.9_1", /下划线/],
    ["9.9.9 rc", /空格/],
    ["v9.9.9", /数字开头/],
  ];

  for (const [tag, expected] of cases) {
    const reason = validateReleaseTag(tag);
    assert.notEqual(reason, null, `${tag} 应该被拦下`);
    assert.match(reason as string, expected);
  }
});

test("转测分界线是 20：到 20 就不能再改包", () => {
  assert.equal(WORK_PROGRESS_TRANSFERRED_TO_TEST, 20);
  assert.equal(WORK_PROGRESS.transferringToTest, 20);
  assert.ok(WORK_PROGRESS.notStarted < WORK_PROGRESS_TRANSFERRED_TO_TEST);
});

test("已知进度码都有中文标签，未知码不抛错", () => {
  assert.equal(workProgressLabel(WORK_PROGRESS.notStarted), "未开始");
  assert.equal(workProgressLabel(WORK_PROGRESS.transferringToTest), "转测试中（无法更新包）");
  assert.equal(workProgressLabel(WORK_PROGRESS.done), "完成");
  assert.equal(workProgressLabel(7), "未知状态");
});

test("新建 Topic 的 workflow/info 返回全零对象时，主题 ID 用请求值兜底", () => {
  // 真实响应就是这样：TopicID 为 0，WorkProgress 为 0，而不是 404。
  const workflow = normalizeTopicWorkflow(29157, {
    ID: 0,
    TopicID: 0,
    TopicName: "",
    WorkProgress: 0,
  });

  assert.equal(workflow.topicId, 29157);
  assert.equal(workflow.workProgress, 0);
  assert.equal(workflow.workProgressLabel, "未开始");
  assert.equal(workflow.appointUser, "");
  assert.equal(workflow.testTableUrl, "");
  assert.equal(workflow.releaseTableUrl, "");
});

test("返回真实主题 ID 与进度时原样取用，并保留原始响应", () => {
  const raw = {
    TopicID: 29157,
    TopicName: "a2-verify",
    WorkProgress: 20,
    AppointUser: "tester",
    TestTableUrl: "https://aptly.uniontech.com/pkg/crp-workflow/x/2026-11-19-测试-a.xlsx",
    ReleaseTableUrl: "",
  };

  const workflow = normalizeTopicWorkflow(1, raw);

  assert.equal(workflow.topicId, 29157);
  assert.equal(workflow.workProgress, 20);
  assert.ok(workflow.workProgress >= WORK_PROGRESS_TRANSFERRED_TO_TEST);
  assert.equal(workflow.workProgressLabel, "转测试中（无法更新包）");
  assert.equal(workflow.appointUser, "tester");
  assert.equal(workflow.testTableUrl, raw.TestTableUrl);
  assert.equal(workflow.raw, raw);
});

test("WorkProgress 缺失或不是数字时按未开始处理，不产生 NaN", () => {
  const missing = normalizeTopicWorkflow(5, {});
  assert.equal(missing.workProgress, 0);
  assert.ok(Number.isFinite(missing.workProgress));

  const bogus = normalizeTopicWorkflow(5, { WorkProgress: "abc" as unknown as number });
  assert.equal(bogus.workProgress, 0);
});
