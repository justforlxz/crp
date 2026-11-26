/**
 * 项目弹窗里能脱离界面单独验证的那部分：四个 tab 的名字与计数、基本信息的草稿、可选的基线。
 *
 * 纯函数，不碰数据库也不碰 React，单测直接断言「输入什么就得到什么」。
 * 界面（`projectModal.tsx`）只负责把结果画出来，不再自己算一遍。
 */

/** 四个 tab 的标识，同时用作 `aria-selected` 的比较值。 */
export type ProjectTabKey = "basic" | "software" | "releases" | "danger";

export type ProjectTab = {
  key: ProjectTabKey;
  label: string;
  /** 只有软件包清单与提测记录带计数；另外两项不显示数字。 */
  count?: number;
};

/**
 * 四个 tab 的名字与顺序照原型 `drawProjectModal()` 的 `tabDefs`：
 * 基本信息 / 软件包清单（带计数）/ 提测记录（带计数）/ 危险操作。
 */
export function projectTabs(input: {
  softwareCount: number;
  releaseCount: number;
}): ProjectTab[] {
  return [
    { key: "basic", label: "基本信息" },
    { key: "software", label: "软件包清单", count: input.softwareCount },
    { key: "releases", label: "提测记录", count: input.releaseCount },
    { key: "danger", label: "危险操作" },
  ];
}

/**
 * 基本信息 tab 的草稿：名称、标识、项目经理、CRP 基线、说明。
 *
 * 四个输入全程受控于这份草稿，所以「切走再切回不丢」是自然结果 —— 不需要在切 tab 的那一刻
 * 再把值读回来。草稿只在点「保存」时写库（design.md 第九节：草稿态不写库）。
 */
export type BasicDraft = {
  name: string;
  key: string;
  projectManagerId: string;
  baselineId: string;
  description: string;
};

export type ManagerChoice = { id: string; name: string };

export type BaselineChoice = {
  id: string;
  name: string;
  /** 基线同步状态；只有 `synced` 的能选（项目绑定的那一条除外）。 */
  state: string;
  /** 状态的中文名，用在不可选基线的括注里。 */
  stateLabel: string;
};

/** 软件包清单 tab 要用到的软件包字段：`listPackages()` 的一小部分，够画一行就够。 */
export type PackageChoice = {
  id: string;
  name: string;
  repoPath: string;
  currentVersion: string | null;
  defaultBranch: string;
};

/** 提测记录 tab 的一行：`loadReleaseList()` 的一小部分。 */
export type ProjectRelease = {
  id: string;
  version: string;
  revision: number;
  status: string;
  createdByName: string;
  createdAt: Date;
};

/** 编辑时把项目现值填进草稿。 */
export type DraftSource = {
  name: string;
  key: string;
  description: string | null;
  manager: { id: string };
  baseline: { id: string };
};

export function draftOf(project: DraftSource): BasicDraft {
  return {
    name: project.name,
    key: project.key,
    projectManagerId: project.manager.id,
    baselineId: project.baseline.id,
    description: project.description ?? "",
  };
}

/**
 * 新建项目的草稿：项目经理取第一位，基线取第一条可用基线，名称与标识留空由用户填。
 *
 * 没有项目经理或没有可用基线时对应字段留空串 —— 保存会被服务端校验挡下并给出可读提示，
 * 不在这里猜一个默认值填进去。
 */
export function emptyDraft(
  managers: readonly ManagerChoice[],
  baselines: readonly BaselineChoice[],
): BasicDraft {
  return {
    name: "",
    key: "",
    projectManagerId: managers[0]?.id ?? "",
    baselineId: baselines.find((baseline) => baseline.state === "synced")?.id ?? "",
    description: "",
  };
}

/**
 * 弹窗里可选的基线：已同步的，加上项目当前绑定的那一条。
 *
 * 后半个条件不能省 —— 项目绑定的基线如果正好没同步，下拉里看不到当前值，一保存就被悄悄换成别的。
 * 与 `app/(app)/projects/[id]/page.tsx` 的取值口径一致。
 */
export function baselineChoicesFor(
  baselines: readonly BaselineChoice[],
  currentBaselineId: string,
): BaselineChoice[] {
  return baselines.filter(
    (baseline) => baseline.state === "synced" || baseline.id === currentBaselineId,
  );
}

/**
 * 弹窗的界面状态：当前 tab + 基本信息草稿。
 *
 * 把这两样放在同一个对象里，是为了让「切 tab 不丢输入」成为一条可断言的性质：
 * `switchTab()` 只换 tab，草稿原样带走；`editDraft()` 只改草稿，tab 不动。
 * 组件里改为一份 state，切 tab 不再是「先读回输入、再切」的顺序问题。
 */
export type ModalState = {
  tab: ProjectTabKey;
  draft: BasicDraft;
};

/** 打开弹窗时的初始状态：新建从空草稿开始，编辑从项目现值开始，都停在基本信息 tab。 */
export function initialModalState(
  project: DraftSource | null,
  managers: readonly ManagerChoice[],
  baselines: readonly BaselineChoice[],
): ModalState {
  return {
    tab: "basic",
    draft: project === null ? emptyDraft(managers, baselines) : draftOf(project),
  };
}

/** 切 tab：草稿原样保留（design.md 第九节「切走再切回不丢」）。 */
export function switchTab(state: ModalState, tab: ProjectTabKey): ModalState {
  return { ...state, tab };
}

/** 改草稿：只改点到的字段，其余原样保留。 */
export function editDraft(state: ModalState, patch: Partial<BasicDraft>): ModalState {
  return { ...state, draft: { ...state.draft, ...patch } };
}

/**
 * 提测记录按项目分组：提测记录 tab 只拿自己那一组，tab 上的计数也数这一组。
 *
 * `projectId` 只用于分组，不进结果 —— 一组里所有行的项目都是同一个，留在每一行只是噪音。
 */
export function groupReleasesByProject(
  rows: readonly (ProjectRelease & { projectId: string })[],
): Record<string, ProjectRelease[]> {
  const grouped: Record<string, ProjectRelease[]> = {};

  for (const row of rows) {
    (grouped[row.projectId] ??= []).push({
      id: row.id,
      version: row.version,
      revision: row.revision,
      status: row.status,
      createdByName: row.createdByName,
      createdAt: row.createdAt,
    });
  }

  return grouped;
}
