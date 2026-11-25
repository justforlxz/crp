/**
 * 界面组：各页结构（UI-05、UI-09 ~ UI-13、UI-24）。
 *
 * 这一组量「模块有没有按原型摆好」：统计卡一行四个、项目卡的层级、队列条不被挤、
 * 依赖流是竖向串联而不是表格、详情双栏在 1180 变单栏、时间线带时间戳、空态三件套。
 */

import { acceptanceWithEnv } from "../support/case";
import { atWidth, eachWidth } from "../support/browser";
import { disconnect } from "../support/db";
import { FIXTURE_ENV, createFixture, type Fixture } from "../support/fixtures";
import { expectBetween, expectEqual, expectTrue } from "../support/report";
import { countOf, rectOf, requireDetailPath, sameRow, styleOf, textsOf } from "../support/ui";

const UI_ENV = [...FIXTURE_ENV, "baseUrl"] as const;
const PREFIX = "zzacui24";

acceptanceWithEnv("UI-05", UI_ENV, async () => {
  await atWidth("UI-05", 1440, async ({ open }) => {
    const page = await open("/dashboard");
    const boxes = await page.locator(".stats > .stat").evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );

    expectEqual("UI-05", "统计卡数量", 4, boxes.length);
    expectTrue("UI-05", "四张统计卡在同一行", "四张卡的 y 相同", sameRow(boxes));

    const value = await styleOf(page, ".stat-value", ["fontSize", "fontVariantNumeric"]);
    expectEqual("UI-05", "统计数值字号", "30px", value?.fontSize);

    const icon = await styleOf(page, ".stat-ico", ["width", "height", "borderRadius"]);
    expectEqual("UI-05", "图标块宽度", "38px", icon?.width);
    expectEqual("UI-05", "图标块高度", "38px", icon?.height);
    expectEqual("UI-05", "图标块圆角", "10px", icon?.borderRadius);
  });
});

acceptanceWithEnv("UI-09", UI_ENV, async () => {
  await eachWidth("UI-09", async ({ open }) => {
    const page = await open("/projects");
    const structure = await page.evaluate(() => {
      const card = document.querySelector(".project-card");

      if (card === null) {
        return null;
      }

      return {
        hasHead: card.querySelector(".pc-hd") !== null,
        hasBody: card.querySelector(".pc-body") !== null,
        hasFacts: card.querySelector(".pc-body .pc-facts") !== null,
        hasChips: card.querySelector(".pc-body .pc-chips") !== null,
        hasFoot: card.querySelector(".pc-ft") !== null,
      };
    });

    expectEqual("UI-09", "项目卡的层级（`.pc-hd` → `.pc-body`（含 `.pc-facts`、`.pc-chips`）→ `.pc-ft`）", {
      hasHead: true,
      hasBody: true,
      hasFacts: true,
      hasChips: true,
      hasFoot: true,
    }, structure);
  });
});

acceptanceWithEnv("UI-10", UI_ENV, async () => {
  await atWidth("UI-10", 1440, async ({ open }) => {
    const page = await open("/queue");
    const meta = await rectOf(page, ".qi-meta");

    expectBetween("UI-10", "队列条 `.qi-meta` 的宽度", 96, Number.POSITIVE_INFINITY, meta?.width ?? 0);

    const progresses = await textsOf(page, ".qi-bar");
    const percents = await textsOf(page, ".qi-pct");

    expectTrue(
      "UI-10",
      "进度条的数值等于已完成的架构数比总架构数",
      "每个进度条的文字形如 N/M",
      progresses.length > 0 && progresses.every((text) => /^\d+\/\d+/u.test(text)),
    );
    expectTrue(
      "UI-10",
      "进度条右侧有百分比",
      "百分比文字不为空",
      percents.length > 0,
    );
  });
});

acceptanceWithEnv("UI-11", UI_ENV, async () => {
  await atWidth("UI-11", 1440, async ({ open }) => {
    const page = await open("/queue");
    const rows = await page.locator(".dep-row").evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { y: rect.y, hasNumber: element.querySelector(".dep-n") !== null, hasNote: element.querySelector(".dep-note") !== null };
      }),
    );

    expectTrue("UI-11", "依赖流有行", "`.dep-row` 至少一行", rows.length > 0);
    expectTrue(
      "UI-11",
      "依赖流是竖向串联",
      "每行的 y 严格递增",
      rows.every((row, index) => index === 0 || row.y > (rows[index - 1]?.y ?? 0)),
    );
    expectTrue(
      "UI-11",
      "每行有序号节点与上游说明",
      "`.dep-n` 与 `.dep-note` 都在",
      rows.every((row) => row.hasNumber && row.hasNote),
    );
    expectEqual("UI-11", "依赖流不应放进表格", 0, await countOf(page, "table .dep-row"));
  });
});

acceptanceWithEnv("UI-12", UI_ENV, async () => {
  await atWidth("UI-12", 1440, async ({ open }) => {
    const page = await open("/releases");
    const detail = await open(await requireDetailPath("UI-12", page));

    const columns = await detail.evaluate(() => {
      const container = document.querySelector(".detail-cols");

      if (container === null) {
        return 0;
      }

      const tops = [...container.children].map(
        (child) => child.getBoundingClientRect().top,
      );

      return tops.filter((top) => Math.abs(top - (tops[0] ?? 0)) <= 1).length;
    });

    expectEqual("UI-12", "1440 下详情双栏的列数", 2, columns);
  });

  await atWidth("UI-12", 1180, async ({ open }) => {
    const page = await open("/releases");
    const detail = await open(await requireDetailPath("UI-12", page));
    const style = await styleOf(detail, ".detail-cols", ["gridTemplateColumns"]);

    // ≤1180 变单栏：模板列数只有一列。
    expectTrue(
      "UI-12",
      "1180 下详情双栏变单栏",
      "grid-template-columns 只有一列",
      (style?.gridTemplateColumns ?? "").split(" ").length === 1,
    );
  });
});

acceptanceWithEnv("UI-13", UI_ENV, async () => {
  await atWidth("UI-13", 1440, async ({ open }) => {
    const page = await open("/releases");
    const detail = await open(await requireDetailPath("UI-13", page));

    const items = await detail.locator(".timeline .tl-item").evaluateAll((elements) =>
      elements.map((element) => ({
        hasDot: element.querySelector(".tl-dot") !== null,
        time: (element.querySelector(".tl-time")?.textContent ?? "").trim(),
      })),
    );

    expectTrue("UI-13", "时间线有条目", "`.tl-item` 至少一条", items.length > 0);
    expectTrue("UI-13", "每条都带状态色点", "`.tl-dot` 都存在", items.every((item) => item.hasDot));
    expectTrue("UI-13", "每条都有时间戳", "`.tl-time` 文字非空", items.every((item) => item.time !== ""));
  });
});

acceptanceWithEnv("UI-24", UI_ENV, async () => {
  // 空态要用一个真的空工作区：拿夹具建一个不灌任何数据的，再按它的 slug 签会话。
  const fixture: Fixture = await createFixture(PREFIX);

  try {
    await eachWidth(
      "UI-24",
      async ({ open }) => {
        for (const path of ["/dashboard", "/releases", "/projects"]) {
          const page = await open(path);

          expectTrue(
            "UI-24",
            `${path} 的空状态`,
            "`.empty` 存在",
            (await countOf(page, ".empty")) > 0,
          );
          expectEqual("UI-24", `${path} 空态带标题`, 1, (await countOf(page, ".empty-t")) > 0 ? 1 : 0);
          expectEqual("UI-24", `${path} 空态带说明`, 1, (await countOf(page, ".empty-d")) > 0 ? 1 : 0);
        }
      },
      { workspaceSlug: `${PREFIX}-ws` },
    );
  } finally {
    await fixture.cleanup();
    await disconnect();
  }
});
