/**
 * 模块对照脚本（MKACG-966 / MKACG-969）。
 *
 * 这里锁住的是判定口径本身：**只认 `className` 上下文里的字符串**。全文搜字符串会让
 * `listHref(filters)` 里的 `filters` 顶替掉 `.filters` 模块，检查就失去意义；注释里
 * 注释掉的 `className="tip"` 同样不算数。四种写法（直写、模板、三元、`clsx`）都要认全，
 * 少认一种就会把已具备的模块报成缺失。
 *
 * 样式表一侧同理：只认规则头的选择器，声明块里的 `content: ".tip"` 与注释掉的规则都不算。
 *
 * 「当前 main 上退 1 并列出缺失」是验收在真实仓库上跑出来的，不在这里伪造。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  allModules,
  classSelectorsOfCss,
  classTokensOfSource,
  collectSourceFiles,
  compareModules,
  exitCodeFor,
  formatReport,
  type ModuleSpec,
} from "../scripts/check-modules";

/** 取出排序后的 token，断言顺序稳定，读失败信息也方便。 */
function tokensOf(source: string): string[] {
  return [...classTokensOfSource(source)].sort();
}

/** 取出排序后的类选择器，理由同上。 */
function selectorsOf(css: string): string[] {
  return [...classSelectorsOfCss(css)].sort();
}

/** 把模块名拼成一份最小样式表：每个模块一条规则，用来单独验证页面用法那几条。 */
function stylesheetOf(modules: string[]): string {
  return modules.map((module) => `${module} { color: #202b3c; }`).join("\n");
}

test("className 直写的多个 class 全部认出来", () => {
  assert.deepEqual(tokensOf(`<div className="tip  table-scroll" />`), [
    "table-scroll",
    "tip",
  ]);
});

test("className 单引号写法同样认", () => {
  assert.deepEqual(tokensOf(`<div className='stats stat' />`), [
    "stat",
    "stats",
  ]);
});

test("模板字面量认静态片段与插值里的字符串，插值里的变量名不算 class", () => {
  const source = `<div className={\`stat \${extra} \${"stat-ico"}\`} />`;

  assert.deepEqual(tokensOf(source), ["stat", "stat-ico"]);
});

test("三元的两支都算已具备", () => {
  const source = `<span className={variant === "danger" ? "badge danger" : "badge"} />`;

  assert.deepEqual(tokensOf(source), ["badge", "danger"]);
});

test("clsx 调用里的字符串参数算，传进去的变量不算", () => {
  const source = `<div className={clsx("queue-item", active && "queue-item-active", extra)} />`;

  assert.deepEqual(tokensOf(source), ["queue-item", "queue-item-active"]);
});

test("对象字面量里的 className 也认", () => {
  const source = `const props = { className: "summary-cell", children: null };`;

  assert.deepEqual(tokensOf(source), ["summary-cell"]);
});

test("className 之外的同一串文字不让模块变成已具备", () => {
  const source = `
    const filters = ["a"];
    function tip() { return filters; }
    <div id="tip" data-class="manager-grid" aria-label="queue-list">
      tips 与 timeline 都只是正文里出现的字
    </div>
  `;

  assert.deepEqual(tokensOf(source), []);
});

test("注释掉的 className 不算已具备", () => {
  const source = `
    // <div className="tip" />
    /* <p className="dep-flow"></p> */
    <div className="stat" />
  `;

  assert.deepEqual(tokensOf(source), ["stat"]);
});

test("字符串里的注释符号不会把后面的代码当注释切掉", () => {
  const source = `
    const url = "https://example.com/a/*b*/";
    <div className="tip" />
  `;

  assert.deepEqual(tokensOf(source), ["tip"]);
});

test("模板插值里的引号与花括号不会让取值提前结束", () => {
  const source = '<div className={`queue-item ${ok ? "queue-item ok" : ""}`} />';

  assert.deepEqual(tokensOf(source), ["ok", "queue-item"]);
});

test("成员访问拿不到真实 class 名，按缺失算", () => {
  const source = `<div className={styles.tip} />`;

  assert.deepEqual(tokensOf(source), []);
});

test("比对按页面自己的 sources 判定，页面之间不互相顶替", () => {
  const spec: ModuleSpec = {
    global: [".toast"],
    pages: {
      dashboard: {
        route: "/dashboard",
        sources: ["dashboard.tsx"],
        modules: [".stats", ".tip"],
      },
      releases: {
        route: "/releases",
        sources: ["releases.tsx"],
        modules: [".stats", ".filters"],
      },
    },
  };

  const report = compareModules(
    spec,
    {
      dashboard: [{ path: "dashboard.tsx", content: `<div className="stats" />` }],
      releases: [{ path: "releases.tsx", content: `<div className="stats filters" />` }],
    },
    stylesheetOf([".toast", ".stats", ".tip", ".filters"]),
  );

  assert.deepEqual(report.pages[0]?.missing, [".tip"]);
  assert.deepEqual(report.pages[0]?.present, [".stats"]);
  assert.deepEqual(report.pages[1]?.missing, []);
  assert.equal(report.pagesWithMissing, 1);
  assert.equal(report.pageMissingTotal, 1);
});

test("全局模块看所有页面合起来，跨页面复用算已具备", () => {
  const spec: ModuleSpec = {
    global: [".toast", ".modal"],
    pages: {
      dashboard: {
        route: "/dashboard",
        sources: ["dashboard.tsx"],
        modules: [],
      },
      releases: {
        route: "/releases",
        sources: ["releases.tsx"],
        modules: [],
      },
    },
  };

  const report = compareModules(
    spec,
    {
      dashboard: [{ path: "dashboard.tsx", content: `<div className="toast" />` }],
      releases: [{ path: "releases.tsx", content: `<div className="modal" />` }],
    },
    stylesheetOf([".toast", ".modal"]),
  );

  assert.deepEqual(report.globalMissing, []);
  assert.deepEqual(report.globalPresent, [".toast", ".modal"]);
});

test("报告逐页列出缺失与已具备，末尾给总数", () => {
  const spec: ModuleSpec = {
    global: [".toast"],
    pages: {
      releases: {
        route: "/releases",
        sources: ["releases.tsx"],
        modules: [".page-tabs", ".filters", ".empty"],
      },
    },
  };

  const report = compareModules(
    spec,
    {
      releases: [{ path: "releases.tsx", content: `<p className="empty" />` }],
    },
    stylesheetOf([".toast", ".page-tabs", ".filters", ".empty"]),
  );
  const text = formatReport(report);

  assert.match(text, /页面：\/releases/);
  assert.match(text, /缺失：\.page-tabs {3}\.filters/);
  assert.match(text, /已具备：\.empty/);
  assert.match(text, /全局模块缺失：\.toast/);
  assert.match(text, /样式表缺失：无/);
  assert.match(
    text,
    /结论：1 个页面里 1 个有缺失，共缺 3 个模块（页面 2 个 \+ 全局 1 个 \+ 样式表 0 个）/,
  );
});

test("全部齐备时结论写明齐备，默认模式也不退 1", () => {
  const spec: ModuleSpec = {
    global: [".toast"],
    pages: {
      releases: {
        route: "/releases",
        sources: ["releases.tsx"],
        modules: [".empty"],
      },
    },
  };

  const report = compareModules(
    spec,
    {
      releases: [
        { path: "releases.tsx", content: `<div className="toast"><p className="empty" /></div>` },
      ],
    },
    stylesheetOf([".toast", ".empty"]),
  );

  assert.match(formatReport(report), /结论：1 个页面全部齐备，全局模块齐备，样式表齐备/);
  assert.equal(exitCodeFor(report, false), 0);
});

test("--report 有缺失也退 0，默认模式退 1", () => {
  const spec: ModuleSpec = {
    global: [],
    pages: {
      releases: {
        route: "/releases",
        sources: ["releases.tsx"],
        modules: [".page-tabs"],
      },
    },
  };

  const report = compareModules(spec, { releases: [] }, stylesheetOf([".page-tabs"]));

  assert.equal(exitCodeFor(report, true), 0);
  assert.equal(exitCodeFor(report, false), 1);
});

test("sources 里的目录展开成 .tsx 文件，测试文件不收", () => {
  const files = collectSourceFiles(process.cwd(), ["app/(app)/releases/"]);

  assert.ok(files.includes("app/(app)/releases/page.tsx"));
  assert.ok(files.includes("app/(app)/releases/[id]/page.tsx"));
  assert.ok(files.every((file) => file.endsWith(".tsx")));
  assert.ok(files.every((file) => !/\.test\.tsx?$/.test(file)));
});

test("sources 写错位置时直接报错，不静默当作已具备", () => {
  assert.throws(
    () => collectSourceFiles(process.cwd(), ["app/(app)/不存在/"]),
    /modules.json 里的来源不存在/,
  );
});

test("样式表只认规则头的选择器，声明与注释里的同名文字不算", () => {
  const css = `
    /* .risk-box { padding: 13px; } */
    .tip {
      content: ".modal";
      background: url(.toast);
    }

    .card .project-card:hover,
    .tl-item:not(:last-child)::before {
      color: #202b3c;
    }
  `;

  assert.deepEqual(selectorsOf(css), ["card", "project-card", "tip", "tl-item"]);
});

test("@media 里的规则同样算数，@keyframes 里的关键帧名字不算", () => {
  const css = `
    @media (max-width: 1100px) {
      .manager-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    @keyframes rise {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  `;

  assert.deepEqual(selectorsOf(css), ["manager-grid"]);
});

test("清单里的模块去重后按全局在前、页面在后的顺序排列", () => {
  const spec: ModuleSpec = {
    global: [".modal", ".toast"],
    pages: {
      detail: {
        route: "/releases/[id]",
        sources: ["detail.tsx"],
        modules: [".modal", ".summary-strip"],
      },
    },
  };

  assert.deepEqual(allModules(spec), [".modal", ".toast", ".summary-strip"]);
});

test("样式表里缺任意一个模块都算缺失，退出码非 0", () => {
  const spec: ModuleSpec = {
    global: [".modal"],
    pages: {
      detail: {
        route: "/releases/[id]",
        sources: ["detail.tsx"],
        modules: [".summary-strip", ".risk-box"],
      },
    },
  };

  const report = compareModules(
    spec,
    { detail: [] },
    stylesheetOf([".modal", ".summary-strip"]),
  );

  assert.deepEqual(report.styleMissing, [".risk-box"]);
  assert.deepEqual(report.stylePresent, [".modal", ".summary-strip"]);
  assert.match(formatReport(report), /样式表缺失：\.risk-box/);
  assert.equal(exitCodeFor(report, false), 1);
  assert.equal(exitCodeFor(report, true), 0);
});

test("样式表齐备时样式表一项为空，默认模式退 0", () => {
  const spec: ModuleSpec = {
    global: [".modal"],
    pages: {
      detail: {
        route: "/releases/[id]",
        sources: ["detail.tsx"],
        modules: [".summary-strip"],
      },
    },
  };

  const report = compareModules(
    spec,
    { detail: [{ path: "detail.tsx", content: `<div className="summary-strip modal" />` }] },
    stylesheetOf([".modal", ".summary-strip"]),
  );

  assert.deepEqual(report.styleMissing, []);
  assert.match(formatReport(report), /样式表已具备：\.modal {3}\.summary-strip/);
  assert.equal(exitCodeFor(report, false), 0);
});
