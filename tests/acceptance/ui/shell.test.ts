/**
 * 界面组：外壳与通用件（UI-02 ~ UI-04、UI-06 ~ UI-08、UI-20 ~ UI-23、UI-25）。
 *
 * 全部是「量出来的数」，数值来自 `design.md` 第五到第七节与原型：侧栏 216、顶栏 56、
 * 内容区最大宽 1400、卡片圆角 12 与边框 1px `#e3e8ef`、表头吸顶 12px、命中区 ≥40、
 * 正文对比度 ≥4.5:1、控件边框 ≥3:1、除按压缩放外没有动效。
 *
 * 页面还没按原型重做时这些会红：那是本单预期内的状态（用例集描述的是新原型）。
 */

import { acceptanceWithEnv } from "../support/case";
import { eachWidth } from "../support/browser";
import { FIXTURE_ENV } from "../support/fixtures";
import { expectBetween, expectEqual, expectTrue } from "../support/report";
import {
  contrastRatio,
  countOf,
  hitBoxOf,
  overflowOf,
  rectOf,
  styleOf,
  textsOf,
} from "../support/ui";

/** 界面组要浏览器 + 会话：`BASE_URL` 与 `DATABASE_URL` 都要。 */
const UI_ENV = [...FIXTURE_ENV, "baseUrl"] as const;

acceptanceWithEnv("UI-02", UI_ENV, async () => {
  await eachWidth("UI-02", async ({ open }) => {
    const page = await open("/dashboard");
    const sidebar = await rectOf(page, ".sidebar");
    const topbar = await rectOf(page, ".topbar");
    const wrap = await styleOf(page, ".wrap", ["maxWidth"]);

    expectBetween("UI-02", "侧栏宽度", 215, 217, sidebar?.width ?? 0);
    expectBetween("UI-02", "顶栏高度", 55, 57, topbar?.height ?? 0);
    expectEqual("UI-02", "内容区最大宽", "1400px", wrap?.maxWidth);
  });
});

acceptanceWithEnv("UI-03", UI_ENV, async () => {
  await eachWidth("UI-03", async ({ open }) => {
    for (const path of ["/dashboard", "/releases", "/projects"]) {
      const page = await open(path);
      const title = (await textsOf(page, ".topbar-title"))[0] ?? "";

      expectTrue("UI-03", `${path} 的顶栏标题非空`, "有标题", title !== "");
      // 内容区不再放大标题：h1 出现两次就是「顶栏 + 内容区」重复。
      expectEqual("UI-03", `${path} 内容区的大标题数量`, 0, await countOf(page, ".canvas h1"));
    }
  });
});

acceptanceWithEnv("UI-04", UI_ENV, async () => {
  await eachWidth("UI-04", async ({ open }) => {
    const page = await open("/dashboard");
    const panel = await styleOf(page, ".panel", [
      "borderRadius",
      "borderTopWidth",
      "borderTopColor",
      "boxShadow",
    ]);

    expectEqual("UI-04", "`.panel` 圆角", "12px", panel?.borderRadius);
    expectEqual("UI-04", "`.panel` 边框宽度", "1px", panel?.borderTopWidth);
    expectEqual("UI-04", "`.panel` 边框颜色", "rgb(227, 232, 239)", panel?.borderTopColor);

    const shadow = panel?.boxShadow ?? "";
    expectTrue(
      "UI-04",
      "`.panel` 阴影不超过 `0 1px 2px rgba(16,24,40,.04)`",
      "无阴影或等同于 0 1px 2px rgba(16, 24, 40, 0.04)",
      shadow === "none" || shadow === "rgba(16, 24, 40, 0.04) 0px 1px 2px 0px",
    );
  });
});

acceptanceWithEnv("UI-06", UI_ENV, async () => {
  await eachWidth("UI-06", async ({ open }) => {
    const page = await open("/releases");
    const head = await styleOf(page, ".table-scroll thead th", [
      "position",
      "backgroundColor",
      "fontSize",
    ]);

    expectEqual("UI-06", "表头的定位方式", "sticky", head?.position);
    expectEqual("UI-06", "表头底色", "rgb(250, 251, 252)", head?.backgroundColor);
    expectEqual("UI-06", "表头字号", "12px", head?.fontSize);
  });
});

acceptanceWithEnv("UI-07", UI_ENV, async () => {
  await eachWidth("UI-07", async ({ open }) => {
    const page = await open("/releases");
    const cell = await styleOf(page, ".num", ["textAlign", "fontVariantNumeric"]);

    expectEqual("UI-07", "数值列的对齐", "right", cell?.textAlign);
    expectTrue(
      "UI-07",
      "数值列使用等宽数字",
      "font-variant-numeric 含 tabular-nums",
      (cell?.fontVariantNumeric ?? "").includes("tabular-nums"),
    );
  });
});

acceptanceWithEnv("UI-08", UI_ENV, async () => {
  await eachWidth("UI-08", async ({ open }) => {
    const page = await open("/releases");

    // 状态不能只用颜色表达：每个 `.dot` 的父元素里必须有文字。
    const dotsWithoutText = await page.evaluate(() => {
      const problems: string[] = [];

      for (const dot of document.querySelectorAll(".dot")) {
        const parent = dot.parentElement;
        const text = (parent?.textContent ?? "").trim();

        if (text === "") {
          problems.push(dot.outerHTML.slice(0, 80));
        }
      }

      return problems;
    });

    expectEqual("UI-08", "只有色点、没有文字的状态", [], dotsWithoutText);
  });
});

acceptanceWithEnv("UI-20", UI_ENV, async () => {
  await eachWidth("UI-20", async ({ open }) => {
    const page = await open("/releases");

    for (const selector of [".tab", ".nav-item"]) {
      const box = await hitBoxOf(page, selector);

      if (box === null) {
        // 元素不存在由别的用例报，这里只说「量不到」。
        expectTrue("UI-20", `${selector} 的存在性`, "页面上能找到它", false);
        continue;
      }

      expectTrue(
        "UI-20",
        `${selector} 的有效命中区（含伪元素扩展）`,
        "宽高都 ≥40px",
        box.width >= 40 && box.height >= 40,
      );
    }
  });
});

acceptanceWithEnv("UI-21", UI_ENV, async () => {
  await eachWidth("UI-21", async ({ open }) => {
    const page = await open("/dashboard");
    const body = await styleOf(page, ".page-title, .topbar-title", ["color", "backgroundColor"]);
    const pageBackground = await styleOf(page, "body", ["backgroundColor"]);

    const textRatio = contrastRatio(
      body?.color ?? "rgb(0,0,0)",
      pageBackground?.backgroundColor ?? "rgb(255,255,255)",
    );

    expectTrue(
      "UI-21",
      "正文与状态文字的对比度",
      "≥ 4.5:1",
      textRatio >= 4.5,
    );

    const control = await styleOf(page, ".btn, .input", ["borderTopColor", "backgroundColor"]);
    const controlRatio = contrastRatio(
      control?.borderTopColor ?? "rgb(0,0,0)",
      control?.backgroundColor ?? "rgb(255,255,255)",
    );

    expectTrue("UI-21", "控件边框的对比度", "≥ 3:1", controlRatio >= 3);
  });
});

acceptanceWithEnv("UI-22", UI_ENV, async () => {
  await eachWidth(
    "UI-22",
    async ({ open, width }) => {
      const page = await open("/dashboard");
      const overflow = await overflowOf(page);

      expectTrue(
        "UI-22",
        `${String(width)}px 下不横向溢出`,
        "scrollWidth ≤ clientWidth",
        overflow.scrollWidth <= overflow.clientWidth,
      );

      const stats = await rectOf(page, ".stats");
      const sidebar = await rectOf(page, ".sidebar");

      if (width <= 900) {
        // ≤900：侧栏收成图标栏。
        expectTrue(
          "UI-22",
          "≤900 时侧栏收窄",
          "侧栏宽度 < 216",
          (sidebar?.width ?? 216) < 216,
        );
      }

      expectTrue("UI-22", "`stats` 区域存在", "找得到 .stats", stats !== null);
    },
    { widths: [1180, 900, 680] },
  );
});

acceptanceWithEnv("UI-23", UI_ENV, async () => {
  const pages = [
    "/dashboard",
    "/releases",
    "/releases/new",
    "/projects",
    "/managers",
    "/packages",
    "/baselines",
    "/queue",
    "/webhooks",
  ];

  await eachWidth(
    "UI-23",
    async ({ open, width }) => {
      const bad: string[] = [];

      for (const path of pages) {
        const page = await open(path);
        const overflow = await overflowOf(page);

        if (overflow.scrollWidth > overflow.clientWidth) {
          bad.push(
            `${path}：scrollWidth ${String(overflow.scrollWidth)} > clientWidth ${String(overflow.clientWidth)}`,
          );
        }
      }

      expectEqual("UI-23", `${String(width)}px 下横向溢出的页面`, [], bad);
    },
    { widths: [1440, 1280, 375] },
  );
});

acceptanceWithEnv("UI-25", UI_ENV, async () => {
  await eachWidth("UI-25", async ({ open }) => {
    const page = await open("/dashboard");
    const animated: string[] = [];

    for (const selector of [".panel", ".tab", ".nav-item", ".stat"]) {
      const style = await styleOf(page, selector, ["transitionDuration", "animationName"]);

      if (style === null) {
        continue;
      }

      const duration = style.transitionDuration ?? "0s";
      const hasTransition = duration !== "0s" && duration.split(",").some((part) => parseFloat(part) > 0);

      if (hasTransition || (style.animationName ?? "none") !== "none") {
        animated.push(`${selector}：transition ${duration} / animation ${style.animationName}`);
      }
    }

    expectEqual("UI-25", "除按压缩放外不应有动效的元素", [], animated);
  });
});
