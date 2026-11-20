/**
 * 样式回归门禁（A20）：L1 静态结构 + L2 计算样式快照 + L3 几何与整页截图。
 *
 * 用法（在仓库根执行，需要 `.env` 里的 `DATABASE_URL` 与一个 `pnpm db:seed` 过的库）：
 *
 *   pnpm test:style            # 比对当前代码与基线
 *   pnpm test:style --update   # 重写基线（页面 JSON/PNG 与 globals.css 规则数一起刷新）
 *
 * `--update` 在 CI 里被拒绝：CI 只负责比对，基线更新必须由人显式发起，并与引发它的样式改动同源。
 *
 * 容差、基线目录、端口都能用环境变量覆盖，默认值同步写在 `docs/STYLE-VERIFICATION.md`：
 *
 * | 变量 | 默认 | 含义 |
 * | --- | --- | --- |
 * | `CRP_STYLE_BASELINE_DIR` | `tests/visual/baseline` | 基线目录 |
 * | `CRP_STYLE_DIFF_DIR` | `tests/visual/diff` | 差异图输出目录（超阈值才写） |
 * | `CRP_STYLE_GEOMETRY_TOLERANCE_PX` | `2` | 锚点几何容差（CSS 像素） |
 * | `CRP_STYLE_PIXEL_RATIO` | `0.005` | 整页截图像素差比例上限（0.5%） |
 * | `CRP_STYLE_BASE_URL` | 空 | 有值时复用已有服务，不自己构建并起服务 |
 * | `CRP_STYLE_PORT` | `3100` | 自己起服务时监听的端口 |
 * | `CRP_STYLE_EMAIL` | `admin@uniontech.com` | 取样用的种子账号 |
 * | `CRP_STYLE_SKIP_BUILD` | 空 | 设为 `1` 时跳过一次 `next build`（仅调脚本时用） |
 *
 * 走容器时（`scripts/style-check/container.sh`）这些变量按原样透传；目录类变量必须在仓库内。
 * 取样的输入由门禁自己固定：容器用一份只含 `DATABASE_URL` 的文件盖住仓库根的 `.env`，
 * 免得页面内容随操作者有没有配 CRP / Gerrit 凭据变化（详见 `docs/STYLE-VERIFICATION.md`）。
 */
import "dotenv/config";

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { prisma } from "../../lib/db";
import {
  STYLE_PROPERTIES,
  compareAnchors,
  comparePng,
  formatFinding,
  type AnchorMap,
  type Finding,
} from "./compare";
import { runLint, type LintCheck } from "./lint";
import {
  capturePages,
  mintStyleSession,
  resolveReleaseId,
  startStyleServer,
} from "./measure";
import { SESSION_WORKSPACE, coveredPages } from "./pages";

/** 采集与截图的视口：固定 1280×900，见文档「L3」一节。 */
const VIEWPORT = { width: 1280, height: 900 } as const;

const BASELINE_DIR = process.env.CRP_STYLE_BASELINE_DIR ?? "tests/visual/baseline";
const DIFF_DIR = process.env.CRP_STYLE_DIFF_DIR ?? "tests/visual/diff";
const GEOMETRY_TOLERANCE_PX = Number(
  process.env.CRP_STYLE_GEOMETRY_TOLERANCE_PX ?? "2",
);
const PIXEL_RATIO = Number(process.env.CRP_STYLE_PIXEL_RATIO ?? "0.005");
const PORT = Number(process.env.CRP_STYLE_PORT ?? "3100");
const EMAIL = process.env.CRP_STYLE_EMAIL ?? "admin@uniontech.com";

/** L1 的基线：规则数与设计变量值。其余三条是「必须为 0」的绝对判据，不需要基线。 */
type LintBaseline = {
  globalsRuleCount: number;
  variables: Record<string, string>;
};

/** 一页的基线文件内容。截图基线是同名的 `.png`。 */
type PageBaseline = {
  page: string;
  path: string;
  viewport: { width: number; height: number };
  anchors: AnchorMap;
};

/** CI 判定：GitHub Actions 设 `CI=true`；其它 CI 也有设 `1` 或不设的，这里宽松一点也算。 */
function isCi(): boolean {
  const value = (process.env.CI ?? "").trim().toLowerCase();
  return value !== "" && value !== "false" && value !== "0";
}

/**
 * 把环境变量里的目录解析成仓库内的绝对路径。
 *
 * `CRP_STYLE_DIFF_DIR` 写错一个值就会让下面的 `rmSync` 删到别处，所以先落成绝对路径再验一次：
 * 不在仓库里就直接报错退出，不删任何东西。
 */
function directoryInsideRoot(root: string, configured: string): string {
  const absolute = resolve(root, configured);
  const prefix = resolve(root) + sep;

  if (!absolute.startsWith(prefix)) {
    throw new Error(`目录必须在仓库内：${configured} 解析成 ${absolute}`);
  }

  return absolute;
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readFileBuffer(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** 格式化成百分比，报告里用。 */
function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function printChecks(checks: readonly LintCheck[]): number {
  let failed = 0;

  for (const check of checks) {
    console.log(`  ${check.ok ? "通过" : "不通过"}：${check.description}`);

    if (!check.ok) {
      failed += 1;
    }
  }

  return failed;
}

/** 把像素差折算成一条与其它差异同格式的记录，贴日志时不用另学一种写法。 */
function pixelFindings(page: string, input: {
  ratio: number;
  diffPixels: number;
  totalPixels: number;
  sameSize: boolean;
  expectedSize: string;
  actualSize: string;
}): Finding[] {
  if (!input.sameSize) {
    return [
      {
        page,
        anchor: "整页截图",
        property: "图片尺寸",
        expected: input.expectedSize,
        actual: input.actualSize,
      },
    ];
  }

  if (input.ratio <= PIXEL_RATIO) {
    return [];
  }

  return [
    {
      page,
      anchor: "整页截图",
      property: "像素差",
      expected: `≤ ${percent(PIXEL_RATIO)}（≤ ${Math.floor(input.totalPixels * PIXEL_RATIO)} 像素）`,
      actual: `${input.diffPixels} 像素（${percent(input.ratio)}）`,
    },
  ];
}

async function main(): Promise<number> {
  const update = process.argv.includes("--update");

  if (process.argv.includes("--help")) {
    console.log("用法：pnpm test:style [--update]");
    return 0;
  }

  if (update && isCi()) {
    console.error(
      "拒绝执行：CI 里不允许 --update。基线更新只能由人在本地显式发起，并与引发它的样式改动放在同一个 PR。",
    );
    console.error("CI 里只允许 pnpm test:style（比对）。");
    return 2;
  }

  const root = process.cwd();

  console.log("样式回归检查（A20）");
  console.log(`仓库：${root}`);
  console.log(
    `模式：${update ? "写基线（--update）" : "比对基线"}　视口：${String(VIEWPORT.width)}×${String(VIEWPORT.height)}　` +
      `几何容差：${String(GEOMETRY_TOLERANCE_PX)}px　像素差上限：${percent(PIXEL_RATIO)}`,
  );

  const baselineDir = directoryInsideRoot(root, BASELINE_DIR);
  const diffDir = directoryInsideRoot(root, DIFF_DIR);

  mkdirSync(baselineDir, { recursive: true });
  // 上一轮的差异图会误导人：它们和本次结果无关。
  rmSync(diffDir, { recursive: true, force: true });

  let failures = 0;

  section("L1 静态结构");
  const lintBaseline = readJson<LintBaseline>(join(baselineDir, "lint.json"));
  const lint = runLint({
    root,
    globalsRuleBaseline: lintBaseline?.globalsRuleCount ?? null,
    variableBaseline: lintBaseline?.variables ?? null,
    update,
  });
  const lintFailures = printChecks(lint.checks);

  for (const finding of lint.variableFindings) {
    console.log(`     ${formatFinding(finding)}`);
  }

  // 结构类失败与模式无关：`--update` 只放宽「规则数」与「设计变量」这两条依赖基线的判据
  // （它们在 runLint 里已按通过返回）。这里若无条件累加，结构坏了却因为写基线而报成功，
  // 就会先把一棵有问题的树当成基线存下来。
  failures += lintFailures;

  if (update) {
    // 结构坏了就不写任何基线：`--update` 的承诺是「一次刷新全部」，写到一半停下的部分更新
    // 比不更新更危险，而按一棵结构有问题的树写盘会把问题直接存进基线。
    if (lintFailures > 0) {
      section("结论");
      console.log(`  失败 ${String(failures)} 项：L1 结构检查没通过，本次没有写入任何基线。`);
      console.log("  先把上面的结构问题修掉，再跑 pnpm test:style --update。");
      return 1;
    }

    writeJson(join(baselineDir, "lint.json"), {
      globalsRuleCount: lint.globalsRuleCount,
      variables: lint.variables,
    });
  }

  const server = await startStyleServer(PORT);

  try {
    const session = await mintStyleSession(EMAIL, SESSION_WORKSPACE);

    try {
      const pages = coveredPages(await resolveReleaseId());
      const captured = await capturePages({
        baseUrl: server.baseUrl,
        sessionToken: session.token,
        pages,
        viewport: VIEWPORT,
        properties: STYLE_PROPERTIES,
      });

      section(`L2/L3 页面快照（${String(pages.length)} 页）`);

      for (const item of captured) {
        const jsonFile = join(baselineDir, `${item.page.name}.json`);
        const pngFile = join(baselineDir, `${item.page.name}.png`);
        const instanceCount = Object.values(item.anchors).reduce(
          (total, samples) => total + samples.length,
          0,
        );
        const shape = `${String(Object.keys(item.anchors).length)} 个锚点 / ${String(instanceCount)} 个实例`;

        if (update) {
          writeJson(jsonFile, {
            page: item.page.name,
            path: item.page.template,
            viewport: VIEWPORT,
            anchors: item.anchors,
          } satisfies PageBaseline);
          writeFileSync(pngFile, item.screenshot);
          console.log(`  已写入：${item.page.title}（${item.page.template}），${shape}`);
          continue;
        }

        const baseline = readJson<PageBaseline>(jsonFile);

        if (baseline === null) {
          const finding: Finding = {
            page: item.page.title,
            anchor: join(BASELINE_DIR, `${item.page.name}.json`),
            property: "基线",
            expected: "存在",
            actual: "缺失（先跑 pnpm test:style --update）",
          };
          console.log(`  ✗ ${item.page.title}（${item.page.template}）`);
          console.log(`     ${formatFinding(finding)}`);
          failures += 1;
          continue;
        }

        const pageFindings = compareAnchors({
          page: item.page.title,
          expected: baseline.anchors,
          actual: item.anchors,
          geometryTolerancePx: GEOMETRY_TOLERANCE_PX,
        });

        const expectedScreenshot = readFileBuffer(pngFile);

        if (expectedScreenshot === null) {
          const finding: Finding = {
            page: item.page.title,
            anchor: join(BASELINE_DIR, `${item.page.name}.png`),
            property: "基线",
            expected: "存在",
            actual: "缺失（先跑 pnpm test:style --update）",
          };
          console.log(`  ✗ ${item.page.title}（${item.page.template}），${shape}`);
          console.log(`     ${formatFinding(finding)}`);
          failures += pageFindings.length + 1;
          continue;
        }

        const pixelDiff = comparePng(expectedScreenshot, item.screenshot);
        const pixel = pixelFindings(item.page.title, {
          ratio: pixelDiff.ratio,
          diffPixels: pixelDiff.diffPixels,
          totalPixels: pixelDiff.totalPixels,
          sameSize: pixelDiff.sameSize,
          expectedSize: `${String(pixelDiff.expectedWidth)}×${String(pixelDiff.expectedHeight)}`,
          actualSize: `${String(pixelDiff.width)}×${String(pixelDiff.height)}`,
        });

        const all = [...pageFindings, ...pixel];

        if (all.length === 0) {
          console.log(`  通过：${item.page.title}（${item.page.template}），${shape}`);
          continue;
        }

        mkdirSync(diffDir, { recursive: true });
        writeFileSync(join(diffDir, `${item.page.name}.png`), pixelDiff.diffPng);

        console.log(`  ✗ ${item.page.title}（${item.page.template}），${shape}`);
        for (const finding of all) {
          console.log(`     ${formatFinding(finding)}`);
        }

        failures += all.length;
      }
    } finally {
      await session.cleanup();
    }
  } finally {
    await server.stop();
    await prisma.$disconnect();
  }

  section("结论");
  console.log(`  失败 ${String(failures)} 项`);
  console.log("  样式来源唯一：app/globals.css（改动基线请用 pnpm test:style --update，并在 PR 里说明变了哪些锚点与属性）");

  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
