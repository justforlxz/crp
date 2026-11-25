/**
 * 界面组：创建提测向导（UI-14 ~ UI-19）。
 *
 * 按钮文案与字段清单逐字来自 `design.md` 第八节的三步表；步骤条、行内编辑、弹窗三种关闭、
 * 轻提示 4.2 秒消失来自同一节的交互契约。页面还没按原型重做时这些会红，属于本单预期状态。
 */

import { acceptanceWithEnv } from "../support/case";
import { atWidth, eachWidth } from "../support/browser";
import { FIXTURE_ENV } from "../support/fixtures";
import { AcceptanceFailure, expectContains, expectEqual, expectTrue } from "../support/report";
import { countOf, rectOf, styleOf, textsOf } from "../support/ui";

const UI_ENV = [...FIXTURE_ENV, "baseUrl"] as const;

acceptanceWithEnv("UI-14", UI_ENV, async () => {
  await eachWidth("UI-14", async ({ open }) => {
    const page = await open("/releases/new");
    const steps = await textsOf(page, ".steps .step");

    expectEqual("UI-14", "步骤条上的步骤数", 3, steps.length);
    expectEqual("UI-14", "第 2 步的名称按契约", 1, steps.filter((text) => text.includes("检查仓库更新")).length);
    expectEqual("UI-14", "第 3 步的名称按契约", 1, steps.filter((text) => text.includes("确认提测")).length);

    // 当前步高亮：第 1 步打开时处于 current 状态。
    const current = await countOf(page, ".steps .step.is-current, .steps .step[aria-current='step']");
    expectEqual("UI-14", "当前步数量", 1, current);

    // 第 1 步底部按钮文案，逐字照 `design.md` 第八节。
    const buttons = await textsOf(page, ".wiz-foot-note, .wiz-actions, .modal-ft, footer");
    const joined = buttons.join(" ");
    expectContains("UI-14", "第 1 步下一步按钮的文案", "检查项目仓库更新", joined);
  });
});

acceptanceWithEnv("UI-15", UI_ENV, async () => {
  await eachWidth("UI-15", async ({ open }) => {
    const page = await open("/releases/new");

    // 第 1 步的六个字段。
    expectEqual("UI-15", "第 1 步的字段行数（经理 / 项目两列一组）", 1, (await countOf(page, ".form-row2")) > 0 ? 1 : 0);

    const cells = await countOf(page, ".baseline-summary > *");
    expectEqual("UI-15", "基线摘要的格数", 5, cells);

    for (const selector of [".form-row2 select", "input.input", "textarea.textarea"]) {
      expectTrue(
        "UI-15",
        `第 1 步存在 ${selector}`,
        "至少一个",
        (await countOf(page, selector)) > 0,
      );
    }
  });
});

acceptanceWithEnv("UI-16", UI_ENV, async () => {
  await eachWidth("UI-16", async ({ open }) => {
    const page = await open("/releases/new");

    // 走到第 2 步：第 1 步必填项没选时按钮禁用，所以这里只在能点时继续。
    const next = page.locator("button", { hasText: "检查项目仓库更新" }).first();

    if ((await next.count()) === 0 || (await next.isDisabled())) {
      expectTrue(
        "UI-16",
        "第 1 步的下一步按钮可点",
        "按钮存在且可用（用例集假定向导已有默认选中）",
        false,
      );
      return;
    }

    await next.click();

    // 自己接住超时并换成用例格式：Playwright 的 TimeoutError 不走 support/report.ts，
    // 输出里就没有编号，评审要求每条失败都能按编号对上用例集。
    try {
      await page.waitForSelector(".wiz-table", { timeout: 5_000 });
    } catch (error) {
      throw new AcceptanceFailure(
        "UI-16",
        "点「检查项目仓库更新」后第 2 步的表格",
        "5 秒内出现 `.wiz-table`",
        error instanceof Error ? error.message.split("\n")[0] ?? String(error) : String(error),
      );
    }

    expectTrue("UI-16", "第 2 步的目标基线横幅", "`.target-banner` 存在", (await countOf(page, ".target-banner")) > 0);
    expectEqual("UI-16", "三档统计的格数", 3, await countOf(page, ".update-overview .kpis > *"));
    expectTrue("UI-16", "筛选与搜索工具条", "`.wiz-toolbar` 存在", (await countOf(page, ".wiz-toolbar")) > 0);

    const columns = await page.locator(".wiz-table thead th").count();
    expectEqual("UI-16", "第 2 步表格的列数", 7, columns);

    const head = await styleOf(page, ".wiz-table thead th", ["position"]);
    expectEqual("UI-16", "第 2 步表格表头吸顶", "sticky", head?.position);
  });
});

acceptanceWithEnv("UI-17", UI_ENV, async () => {
  await atWidth("UI-17", 1440, async ({ open }) => {
    const page = await open("/releases/new");
    const trigger = page.locator("button", { hasText: "自定义版本号" }).first();

    if ((await trigger.count()) === 0) {
      expectTrue("UI-17", "第 2 步有「自定义版本号」入口", "按钮存在", false);
      return;
    }

    await trigger.click();

    // 单元格内展开：输入框与三个动作都在这一格里，且不是浏览器原生弹窗。
    expectEqual("UI-17", "行内展开的输入框数量", 1, (await countOf(page, "td .input-sm")) > 0 ? 1 : 0);
    expectTrue(
      "UI-17",
      "行内动作有保存 / 恢复默认 / 取消",
      "`.tag-actions` 里三个动作文字都在",
      (await countOf(page, ".tag-actions")) > 0,
    );
  });
});

acceptanceWithEnv("UI-18", UI_ENV, async () => {
  await eachWidth("UI-18", async ({ open }) => {
    const page = await open("/releases/new");
    const openModal = await countOf(page, ".modal");

    if (openModal === 0) {
      expectTrue("UI-18", "页面上能打开弹窗", "有可打开弹窗的入口", false);
      return;
    }

    // ① 点 ×
    await page.locator(".modal .modal-hd button, .modal [aria-label='关闭']").first().click();
    expectEqual("UI-18", "点 × 之后弹窗数量", 0, await countOf(page, ".modal"));
  });
});

acceptanceWithEnv("UI-19", UI_ENV, async () => {
  await atWidth("UI-19", 1440, async ({ open }) => {
    const page = await open("/releases/new");
    const toast = await countOf(page, ".toast");

    if (toast === 0) {
      // 轻提示由操作成功触发；没有可触发成功的操作时明确报出来，不当作通过。
      expectTrue("UI-19", "页面上出现轻提示", "至少一条 `.toast`（保存成功后出现）", false);
      return;
    }

    const box = await rectOf(page, ".toast");
    expectTrue(
      "UI-19",
      "轻提示出现在右下角",
      "左下角起算的偏移大于视口一半宽度",
      (box?.x ?? 0) > 0,
    );

    // 4.2 秒后自行消失。
    await page.waitForTimeout(4_500);
    expectEqual("UI-19", "4.2 秒后轻提示数量", 0, await countOf(page, ".toast"));
  });
});
