/**
 * 样式检查覆盖的页面清单（A20）。
 *
 * 这里的清单与 `docs/STYLE-VERIFICATION.md` 的「覆盖页面」一节必须逐条一致：加页面要同时改
 * 这里、补文档、`--update` 抓基线，三者缺一不算覆盖。
 *
 * 为什么把工作区与提测记录钉在清单里：页面读的是当前会话里的工作区，不同工作区的记录条数不一样，
 * 表格行数一变，锚点数量、几何、截图都跟着变。工作区与种子记录固定之后，同一份代码每次量到的是
 * 同一个页面状态，基线才有意义。
 *
 * 提测详情的 ID 是播种时生成的 uuid，不能写进基线文件名，所以按「项目名 + 版本」在库里定位，
 * 路径在运行时拼出来。
 */

/** 会话记住的工作区：工作台、提测记录、软件包、创建提测用它。 */
export const SESSION_WORKSPACE = "desktop-core";

/**
 * 构建队列页的工作区。
 *
 * 队列页只列未完结的提测，`desktop-core` 的提测都已完结，任务表不会出现；`system-apps` 有一条
 * 停在 `pending` 的提测，任务表才有内容可量。
 */
export const QUEUE_WORKSPACE = "system-apps";

/** 提测详情覆盖的种子记录：种子里的项目名 + 版本。 */
export const DETAIL_RELEASE = {
  projectName: "桌面专业版 V25",
  version: "25.0.1",
} as const;

export type CoveredPage = {
  /** 基线文件名（不含扩展名），也是报告里的页面标识。 */
  name: string;
  /** 报告里给人看的页面名。 */
  title: string;
  /** 访问路径，原样拼在 `CRP_STYLE_BASE_URL` 后面。 */
  path: string;
  /**
   * 写进基线文件的路径写法。
   *
   * 提测详情的 ID 是播种时生成的 uuid，换一个库就换一个值：把它写进基线只会让 diff 里多一行噪音。
   * 这里用 `<id>` 占位，人看得出来覆盖的是哪一页，机器不依赖它。
   */
  template: string;
  /**
   * 是否保留侧栏锚点（`nav.*` 与 `sidebar.*`）。
   *
   * 侧栏由 `components/page-shell.tsx` 里的 `AppNav` 在每个受保护页面上挂一次，六个页面各存一份
   * 完全是重复：既让基线变胖，也让一次侧栏改动的 diff 分散在六个文件里。只留工作台一份，
   * 侧栏坏了照样能挡住。
   */
  keepsSharedAnchors: boolean;
};

export function coveredPages(releaseId: string): CoveredPage[] {
  const desktop = `?workspace=${SESSION_WORKSPACE}`;

  return [
    {
      name: "dashboard",
      title: "工作台",
      path: "/dashboard",
      template: "/dashboard",
      keepsSharedAnchors: true,
    },
    {
      name: "releases",
      title: "提测记录",
      path: `/releases${desktop}`,
      template: `/releases${desktop}`,
      keepsSharedAnchors: false,
    },
    {
      name: "release-detail",
      title: "提测详情",
      path: `/releases/${releaseId}${desktop}`,
      template: `/releases/<id>${desktop}`,
      keepsSharedAnchors: false,
    },
    {
      name: "release-new",
      title: "创建提测",
      path: `/releases/new${desktop}`,
      template: `/releases/new${desktop}`,
      keepsSharedAnchors: false,
    },
    {
      name: "queue",
      title: "构建队列",
      path: `/queue?workspace=${QUEUE_WORKSPACE}`,
      template: `/queue?workspace=${QUEUE_WORKSPACE}`,
      keepsSharedAnchors: false,
    },
    {
      name: "packages",
      title: "软件包",
      path: "/packages",
      template: "/packages",
      keepsSharedAnchors: false,
    },
  ];
}
