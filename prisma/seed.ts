/**
 * 种子数据：把数据结构演示用的一套固定数据灌进空库。
 *
 * 设计为可重复执行：除 `sync_run` 与 `webhook_delivery` 这两张只记过程的日志表外，
 * 其余表都按业务唯一键 upsert，所以 `pnpm db:reset` 连续跑两次，
 * 每张表的记录数不变。
 *
 * 数据规模按任务要求：3 个工作区、4 个项目、12 个软件包、4 个基线，外加若干提测记录。
 *
 * 每条提测的状态、它下面各轮快照的状态、仓库记录与构建任务三处互相对得上：
 * 提测整体成功的，快照与构建任务都是 success；快照停在 pending 的，就是还没投递。
 *
 * 提测记录里刻意留了两处需要看明白的地方：
 * - `desktop-v25 / 25.0.1`：同一个软件包（kwin）提了两轮，第一轮标 `superseded` 并指向第二轮。
 * - `desktop-v25 / 25.0.2`：上游 `dde-file-manager` 构建失败，下游 `dde-dock` 停在 `pending`，没有被投递。
 */

import "dotenv/config";

import { prisma } from "../lib/db";
import type { WebhookEventType } from "../lib/webhook/events";
import { computeWebhookSignature } from "../lib/webhook/signature";

/** 把 ISO 字符串换成 UTC 时间对象，种子里的时间全部写死，保证每次生成的数据一致。 */
function at(iso: string): Date {
  return new Date(iso);
}

// ---------------------------------------------------------------------------
// 固定种子数据
// ---------------------------------------------------------------------------

/**
 * 四条基线，`crpBranchId` 一律用 CRP `/branches` 返回的真实 ID。
 *
 * 不能用「分支名里的数字」凑：CRP 的 ID 与分支名无关（`eagle-1071` 的 ID 是 108），
 * 基线同步按 `crpBranchId` 幂等写入，凑出来的 ID 会让同一分支在库里出现两条 ——
 * 一条真的、一条被标成「已消失」的假记录。
 */
const BASELINES = [
  {
    crpBranchId: "108",
    name: "eagle-1071",
    description: "V20 桌面交付分支",
    repoType: "deb",
    isCheck: true,
    syncedAt: at("2026-11-18T01:00:00Z"),
  },
  {
    crpBranchId: "126",
    name: "eagle-1076",
    description: "V20 安全组件交付分支",
    repoType: "deb",
    isCheck: true,
    syncedAt: at("2026-11-18T01:00:00Z"),
  },
  {
    crpBranchId: "123",
    name: "snipe-2500u1",
    description: "V25 首轮交付分支",
    repoType: "deb",
    isCheck: false,
    syncedAt: at("2026-11-17T22:00:00Z"),
  },
  {
    crpBranchId: "128",
    name: "snipe-2500u2",
    description: "V25 第二轮交付分支",
    repoType: "deb",
    isCheck: false,
    syncedAt: at("2026-11-18T01:00:00Z"),
  },
] as const;

const WORKSPACES = [
  { slug: "desktop-core", name: "桌面核心组" },
  { slug: "system-apps", name: "系统应用组" },
  { slug: "security", name: "安全组" },
] as const;

const USERS = [
  {
    email: "admin@uniontech.com",
    displayName: "系统管理员",
    passwordHash: "seed-not-a-real-hash-admin",
    isPlatformAdmin: true,
  },
  {
    email: "liwei@uniontech.com",
    displayName: "李伟",
    passwordHash: "seed-not-a-real-hash-liwei",
    isPlatformAdmin: false,
  },
  {
    email: "chenhao@uniontech.com",
    displayName: "陈浩",
    passwordHash: "seed-not-a-real-hash-chenhao",
    isPlatformAdmin: false,
  },
  {
    email: "zhangmin@uniontech.com",
    displayName: "张敏",
    passwordHash: "seed-not-a-real-hash-zhangmin",
    isPlatformAdmin: false,
  },
  {
    email: "wangfang@uniontech.com",
    displayName: "王芳",
    passwordHash: "seed-not-a-real-hash-wangfang",
    isPlatformAdmin: false,
  },
] as const;

/** 项目经理：刘洋没有平台账号，`user_email` 为空，用来演示「未开通账号的项目经理」。 */
const PROJECT_MANAGERS = [
  { name: "李伟", workspaceSlug: "desktop-core", userEmail: "liwei@uniontech.com" },
  { name: "陈浩", workspaceSlug: "system-apps", userEmail: "chenhao@uniontech.com" },
  { name: "刘洋", workspaceSlug: "security", userEmail: null },
] as const;

/** 工作区成员。平台管理员不进 membership。 */
const MEMBERSHIPS = [
  { workspaceSlug: "desktop-core", userEmail: "liwei@uniontech.com", role: "project_manager" },
  { workspaceSlug: "desktop-core", userEmail: "zhangmin@uniontech.com", role: "developer" },
  { workspaceSlug: "desktop-core", userEmail: "wangfang@uniontech.com", role: "reader" },
  { workspaceSlug: "system-apps", userEmail: "chenhao@uniontech.com", role: "project_manager" },
  { workspaceSlug: "system-apps", userEmail: "zhangmin@uniontech.com", role: "developer" },
  { workspaceSlug: "security", userEmail: "zhangmin@uniontech.com", role: "developer" },
  { workspaceSlug: "security", userEmail: "wangfang@uniontech.com", role: "reader" },
] as const;

const PACKAGES = [
  // kwin 在 CRP 里的项目名不是包名（带下划线），显式登记；其余包留空走「与包名相同」。
  { name: "kwin", repoPath: "deepin-kde/kwin", defaultBranch: "develop/eagle", currentVersion: "5.27.11.1", crpProjectName: "v25_kwin" },
  { name: "dde-file-manager", repoPath: "dde-file-manager/dde-file-manager", defaultBranch: "develop/eagle", currentVersion: "6.5.12" },
  { name: "dde-dock", repoPath: "dde-dock/dde-dock", defaultBranch: "develop/eagle", currentVersion: "5.12.0" },
  { name: "dde-launchpad", repoPath: "dde-launchpad/dde-launchpad", defaultBranch: "develop/eagle", currentVersion: "1.2.0" },
  { name: "dde-control-center", repoPath: "dde-control-center/dde-control-center", defaultBranch: "develop/eagle", currentVersion: "6.0.18" },
  { name: "dde-session-shell", repoPath: "dde-session-shell/dde-session-shell", defaultBranch: "develop/eagle", currentVersion: "6.0.33" },
  { name: "dde-appearance", repoPath: "dde-appearance/dde-appearance", defaultBranch: "develop/eagle", currentVersion: "1.0.9" },
  { name: "deepin-terminal", repoPath: "deepin-terminal/deepin-terminal", defaultBranch: "develop/eagle", currentVersion: "5.6.1" },
  { name: "deepin-editor", repoPath: "deepin-editor/deepin-editor", defaultBranch: "develop/eagle", currentVersion: "6.0.21" },
  { name: "deepin-system-monitor", repoPath: "deepin-system-monitor/deepin-system-monitor", defaultBranch: "develop/eagle", currentVersion: "6.0.14" },
  { name: "deepin-polkit-agent", repoPath: "deepin-polkit-agent/deepin-polkit-agent", defaultBranch: "develop/eagle", currentVersion: "0.0.12" },
  { name: "deepin-deb-installer", repoPath: "deepin-deb-installer/deepin-deb-installer", defaultBranch: "develop/eagle", currentVersion: "6.0.7" },
] as const;

/** 上游依赖：`name` 依赖 `upstream`，上游构建成功才投下游。 */
const PACKAGE_DEPENDENCIES = [
  { name: "dde-session-shell", upstream: "deepin-polkit-agent" },
  { name: "dde-dock", upstream: "dde-session-shell" },
  { name: "dde-launchpad", upstream: "dde-session-shell" },
  { name: "dde-control-center", upstream: "dde-appearance" },
] as const;

const PROJECTS = [
  {
    workspaceSlug: "desktop-core",
    key: "desktop-v25",
    name: "桌面专业版 V25",
    description: "V25 桌面版本，跟随 snipe-2500u2 交付",
    managerName: "李伟",
    baselineName: "snipe-2500u2",
    software: ["kwin", "dde-file-manager", "dde-dock", "dde-session-shell", "deepin-polkit-agent"],
  },
  {
    workspaceSlug: "desktop-core",
    key: "desktop-v20",
    name: "桌面专业版 V20",
    description: "V20 维护版本，跟随 eagle-1071 交付",
    managerName: "李伟",
    baselineName: "eagle-1071",
    software: ["kwin", "dde-file-manager", "dde-dock"],
  },
  {
    workspaceSlug: "system-apps",
    key: "system-tools",
    name: "系统工具套件",
    description: "系统工具类软件包合集",
    managerName: "陈浩",
    baselineName: "snipe-2500u1",
    software: ["deepin-terminal", "deepin-editor", "deepin-system-monitor", "dde-launchpad"],
  },
  {
    workspaceSlug: "security",
    key: "security-suite",
    name: "安全组件",
    description: "安全授权与外观相关组件",
    managerName: "刘洋",
    baselineName: "eagle-1076",
    software: ["deepin-polkit-agent", "dde-control-center", "dde-appearance"],
  },
] as const;

/** 基线内软件包版本：取自 Shuttle 基线交付仓库索引，每个基线放几条。 */
const BASELINE_PACKAGE_VERSIONS = [
  { baselineName: "eagle-1071", packageName: "kwin", version: "5.27.10.2-1" },
  { baselineName: "eagle-1071", packageName: "dde-file-manager", version: "6.5.10-1" },
  { baselineName: "eagle-1071", packageName: "dde-dock", version: "5.11.9-1" },
  { baselineName: "eagle-1076", packageName: "deepin-polkit-agent", version: "0.0.11-1" },
  { baselineName: "eagle-1076", packageName: "dde-appearance", version: "1.0.8-1" },
  { baselineName: "eagle-1076", packageName: "dde-control-center", version: "6.0.16-1" },
  { baselineName: "snipe-2500u1", packageName: "deepin-terminal", version: "5.6.0-1" },
  { baselineName: "snipe-2500u1", packageName: "deepin-editor", version: "6.0.20-1" },
  { baselineName: "snipe-2500u1", packageName: "deepin-system-monitor", version: "6.0.13-1" },
  { baselineName: "snipe-2500u2", packageName: "kwin", version: "5.27.11.0-1" },
  { baselineName: "snipe-2500u2", packageName: "dde-file-manager", version: "6.5.11-1" },
  { baselineName: "snipe-2500u2", packageName: "dde-session-shell", version: "6.0.32-1" },
] as const;

type SeedSnapshot = {
  packageName: string;
  attempt: number;
  branch: string;
  commitSha: string;
  codeVersion: string;
  repoVersion: string | null;
  releaseVersion: string;
  status: "pending" | "dispatching" | "building" | "success" | "failed" | "abandoned" | "superseded";
  statusChangedAt?: Date;
  /** 被哪一轮替换：`packageName@attempt`。 */
  supersededBy?: string;
  supersededAt?: Date;
};

type SeedRelease = {
  projectName: string;
  version: string;
  /**
   * 提测创建时间。**必须写死**：详情页把它渲染成「创建时间」，默认值取播种那一刻，
   * 换一台机、换一次播种就是另一个值，整页截图基线会带上一个与本单无关的基础差异。
   */
  createdAt: Date;
  revision: number;
  status: "pending" | "dispatching" | "building" | "success" | "partial_failure" | "failed" | "abandoned";
  description: string;
  createdByEmail: string;
  crpTopicId?: string;
  crpBranchId?: string;
  crpTopicState?: number;
  crpTopicAbandoned?: boolean;
  crpTopicCompleted?: boolean;
  crpWorkProgress?: number;
  crpWorkProgressLabel?: string;
  crpWorkProgressSyncedAt?: Date;
  submittedAt?: Date;
  finishedAt?: Date;
  snapshots: SeedSnapshot[];
  /** 已投递到 CRP 的轮次：`packageName@attempt`，外加 CRP 侧编号。 */
  repositoryRecords?: {
    snapshot: string;
    crpReleaseId: string;
    crpBuildId: string | null;
    repositoryUrl: string | null;
    crpReleaseState: number | null;
    crpStatusName: string | null;
  }[];
  buildTasks?: {
    snapshot: string;
    shuttleTaskId: string | null;
    status: "pending" | "building" | "success" | "failed" | "canceled";
    lastPolledAt?: Date;
    startedAt?: Date;
    finishedAt?: Date;
    jobs: {
      shuttleJobId: string;
      arch: string;
      status: "pending" | "building" | "success" | "failed" | "canceled";
      startedAt?: Date;
      finishedAt?: Date;
    }[];
  }[];
};

const RELEASES: SeedRelease[] = [
  {
    projectName: "桌面专业版 V25",
    version: "25.0.1",
    createdAt: at("2026-11-18T02:10:00Z"),
    revision: 2,
    status: "success",
    description: "V25 首个正式提测：kwin 换了一轮包，其余按依赖顺序投递",
    createdByEmail: "liwei@uniontech.com",
    crpTopicId: "8841",
    crpBranchId: "128",
    crpTopicState: 1,
    crpTopicAbandoned: false,
    crpTopicCompleted: true,
    crpWorkProgress: 20,
    crpWorkProgressLabel: "转测试中（无法更新包）",
    crpWorkProgressSyncedAt: at("2026-11-18T03:10:00Z"),
    submittedAt: at("2026-11-18T02:20:00Z"),
    finishedAt: at("2026-11-18T02:58:00Z"),
    snapshots: [
      {
        packageName: "kwin",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "4f0b1d2e8c9a7b6d5e4f3a2b1c0d9e8f7a6b5c4d",
        codeVersion: "5.27.11.1-1",
        repoVersion: "5.27.11.0-1",
        releaseVersion: "5.27.11.1",
        status: "superseded",
        supersededBy: "kwin@2",
        supersededAt: at("2026-11-18T02:26:00Z"),
      },
      {
        packageName: "kwin",
        attempt: 2,
        branch: "develop/eagle",
        commitSha: "9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
        codeVersion: "5.27.11.2-1",
        repoVersion: "5.27.11.0-1",
        releaseVersion: "5.27.11.2",
        status: "success",
        statusChangedAt: at("2026-11-18T02:41:00Z"),
      },
      {
        packageName: "deepin-polkit-agent",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        codeVersion: "0.0.12-1",
        repoVersion: "0.0.11-1",
        releaseVersion: "0.0.12",
        status: "success",
        statusChangedAt: at("2026-11-18T02:33:00Z"),
      },
      {
        packageName: "dde-session-shell",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
        codeVersion: "6.0.33-1",
        repoVersion: "6.0.32-1",
        releaseVersion: "6.0.33",
        status: "success",
        statusChangedAt: at("2026-11-18T02:47:00Z"),
      },
      {
        packageName: "dde-dock",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
        codeVersion: "5.12.0-1",
        repoVersion: null,
        releaseVersion: "5.12.0",
        status: "success",
        statusChangedAt: at("2026-11-18T02:56:00Z"),
      },
      {
        packageName: "dde-file-manager",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
        codeVersion: "6.5.12-1",
        repoVersion: "6.5.11-1",
        releaseVersion: "6.5.12",
        status: "success",
        statusChangedAt: at("2026-11-18T02:39:00Z"),
      },
    ],
    repositoryRecords: [
      {
        snapshot: "deepin-polkit-agent@1",
        crpReleaseId: "51204",
        crpBuildId: "710041",
        repositoryUrl: "https://crp.uniontech.com/repo/snipe-2500u2/pool/main/d/deepin-polkit-agent/",
        crpReleaseState: 3,
        crpStatusName: "构建成功",
      },
      {
        snapshot: "dde-session-shell@1",
        crpReleaseId: "51203",
        crpBuildId: "710042",
        repositoryUrl: "https://crp.uniontech.com/repo/snipe-2500u2/pool/main/d/dde-session-shell/",
        crpReleaseState: 3,
        crpStatusName: "构建成功",
      },
      {
        snapshot: "kwin@2",
        crpReleaseId: "51201",
        crpBuildId: "710043",
        repositoryUrl: "https://crp.uniontech.com/repo/snipe-2500u2/pool/main/k/kwin/",
        crpReleaseState: 3,
        crpStatusName: "构建成功",
      },
      {
        snapshot: "dde-file-manager@1",
        crpReleaseId: "51202",
        crpBuildId: "710044",
        repositoryUrl: "https://crp.uniontech.com/repo/snipe-2500u2/pool/main/d/dde-file-manager/",
        crpReleaseState: 3,
        crpStatusName: "构建成功",
      },
      {
        snapshot: "dde-dock@1",
        crpReleaseId: "51205",
        crpBuildId: "710045",
        repositoryUrl: "https://crp.uniontech.com/repo/snipe-2500u2/pool/main/d/dde-dock/",
        crpReleaseState: 3,
        crpStatusName: "构建成功",
      },
    ],
    buildTasks: [
      {
        snapshot: "deepin-polkit-agent@1",
        shuttleTaskId: "710041",
        status: "success",
        lastPolledAt: at("2026-11-18T02:33:00Z"),
        startedAt: at("2026-11-18T02:22:00Z"),
        finishedAt: at("2026-11-18T02:33:00Z"),
        jobs: [
          { shuttleJobId: "9100410", arch: "amd64", status: "success", startedAt: at("2026-11-18T02:23:00Z"), finishedAt: at("2026-11-18T02:31:00Z") },
          { shuttleJobId: "9100411", arch: "arm64", status: "success", startedAt: at("2026-11-18T02:24:00Z"), finishedAt: at("2026-11-18T02:33:00Z") },
        ],
      },
      {
        snapshot: "dde-session-shell@1",
        shuttleTaskId: "710042",
        status: "success",
        lastPolledAt: at("2026-11-18T02:47:00Z"),
        startedAt: at("2026-11-18T02:35:00Z"),
        finishedAt: at("2026-11-18T02:47:00Z"),
        jobs: [
          { shuttleJobId: "9100420", arch: "amd64", status: "success", startedAt: at("2026-11-18T02:36:00Z"), finishedAt: at("2026-11-18T02:44:00Z") },
          { shuttleJobId: "9100421", arch: "arm64", status: "success", startedAt: at("2026-11-18T02:37:00Z"), finishedAt: at("2026-11-18T02:47:00Z") },
        ],
      },
      {
        snapshot: "kwin@2",
        shuttleTaskId: "710043",
        status: "success",
        lastPolledAt: at("2026-11-18T02:41:00Z"),
        startedAt: at("2026-11-18T02:27:00Z"),
        finishedAt: at("2026-11-18T02:41:00Z"),
        jobs: [
          { shuttleJobId: "9100430", arch: "amd64", status: "success", startedAt: at("2026-11-18T02:28:00Z"), finishedAt: at("2026-11-18T02:39:00Z") },
          { shuttleJobId: "9100431", arch: "arm64", status: "success", startedAt: at("2026-11-18T02:29:00Z"), finishedAt: at("2026-11-18T02:41:00Z") },
        ],
      },
      {
        snapshot: "dde-file-manager@1",
        shuttleTaskId: "710044",
        status: "success",
        lastPolledAt: at("2026-11-18T02:39:00Z"),
        startedAt: at("2026-11-18T02:22:00Z"),
        finishedAt: at("2026-11-18T02:39:00Z"),
        jobs: [
          { shuttleJobId: "9100440", arch: "amd64", status: "success", startedAt: at("2026-11-18T02:23:00Z"), finishedAt: at("2026-11-18T02:31:00Z") },
          { shuttleJobId: "9100441", arch: "arm64", status: "success", startedAt: at("2026-11-18T02:24:00Z"), finishedAt: at("2026-11-18T02:39:00Z") },
        ],
      },
      {
        snapshot: "dde-dock@1",
        shuttleTaskId: "710045",
        status: "success",
        lastPolledAt: at("2026-11-18T02:56:00Z"),
        startedAt: at("2026-11-18T02:48:00Z"),
        finishedAt: at("2026-11-18T02:56:00Z"),
        jobs: [
          { shuttleJobId: "9100450", arch: "amd64", status: "success", startedAt: at("2026-11-18T02:49:00Z"), finishedAt: at("2026-11-18T02:54:00Z") },
          { shuttleJobId: "9100451", arch: "arm64", status: "success", startedAt: at("2026-11-18T02:50:00Z"), finishedAt: at("2026-11-18T02:56:00Z") },
        ],
      },
    ],
  },
  {
    projectName: "桌面专业版 V25",
    version: "25.0.2",
    createdAt: at("2026-11-18T06:05:00Z"),
    revision: 1,
    status: "failed",
    description: "上游 dde-file-manager 构建失败，下游 dde-dock 未投递",
    createdByEmail: "zhangmin@uniontech.com",
    crpTopicId: "8867",
    crpBranchId: "128",
    crpTopicState: 1,
    crpTopicAbandoned: false,
    crpTopicCompleted: false,
    crpWorkProgress: 0,
    crpWorkProgressLabel: "未开始",
    crpWorkProgressSyncedAt: at("2026-11-18T06:30:00Z"),
    submittedAt: at("2026-11-18T06:05:00Z"),
    finishedAt: at("2026-11-18T06:28:00Z"),
    snapshots: [
      {
        packageName: "kwin",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
        codeVersion: "5.27.11.2-1",
        repoVersion: "5.27.11.0-1",
        releaseVersion: "5.27.11.2",
        status: "success",
        statusChangedAt: at("2026-11-18T06:19:00Z"),
      },
      {
        packageName: "dde-file-manager",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a",
        codeVersion: "6.5.13-1",
        repoVersion: "6.5.11-1",
        releaseVersion: "6.5.13",
        status: "failed",
        statusChangedAt: at("2026-11-18T06:28:00Z"),
      },
      {
        packageName: "dde-dock",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
        codeVersion: "5.12.0-1",
        repoVersion: null,
        releaseVersion: "5.12.0",
        status: "pending",
      },
    ],
    repositoryRecords: [
      {
        snapshot: "kwin@1",
        crpReleaseId: "51301",
        crpBuildId: "710101",
        repositoryUrl: "https://crp.uniontech.com/repo/snipe-2500u2/pool/main/k/kwin/",
        crpReleaseState: 3,
        crpStatusName: "构建成功",
      },
      {
        snapshot: "dde-file-manager@1",
        crpReleaseId: "51302",
        crpBuildId: "710102",
        repositoryUrl: "https://crp.uniontech.com/repo/snipe-2500u2/pool/main/d/dde-file-manager/",
        crpReleaseState: 4,
        crpStatusName: "构建失败",
      },
    ],
    buildTasks: [
      {
        snapshot: "kwin@1",
        shuttleTaskId: "710101",
        status: "success",
        lastPolledAt: at("2026-11-18T06:19:00Z"),
        startedAt: at("2026-11-18T06:07:00Z"),
        finishedAt: at("2026-11-18T06:19:00Z"),
        jobs: [
          { shuttleJobId: "9101010", arch: "amd64", status: "success", startedAt: at("2026-11-18T06:08:00Z"), finishedAt: at("2026-11-18T06:19:00Z") },
        ],
      },
      {
        snapshot: "dde-file-manager@1",
        shuttleTaskId: "710102",
        status: "failed",
        lastPolledAt: at("2026-11-18T06:28:00Z"),
        startedAt: at("2026-11-18T06:21:00Z"),
        finishedAt: at("2026-11-18T06:28:00Z"),
        jobs: [
          { shuttleJobId: "9101020", arch: "amd64", status: "failed", startedAt: at("2026-11-18T06:22:00Z"), finishedAt: at("2026-11-18T06:28:00Z") },
        ],
      },
    ],
  },
  {
    projectName: "系统工具套件",
    version: "1.4.0",
    createdAt: at("2026-11-18T06:45:00Z"),
    revision: 1,
    status: "pending",
    description: "配置完成，尚未提交到 CRP",
    createdByEmail: "chenhao@uniontech.com",
    snapshots: [
      {
        packageName: "deepin-terminal",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9",
        codeVersion: "5.6.1-1",
        repoVersion: "5.6.0-1",
        releaseVersion: "5.6.1",
        status: "pending",
      },
      {
        packageName: "deepin-editor",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
        codeVersion: "6.0.21-1",
        repoVersion: "6.0.20-1",
        releaseVersion: "6.0.21",
        status: "pending",
      },
    ],
  },
  {
    projectName: "安全组件",
    version: "2.1.0",
    createdAt: at("2026-11-18T07:55:00Z"),
    revision: 1,
    status: "dispatching",
    description: "正在按依赖顺序投递，polkit 已发出，其余等上游",
    createdByEmail: "zhangmin@uniontech.com",
    crpTopicId: "8901",
    crpBranchId: "126",
    crpTopicState: 1,
    crpTopicAbandoned: false,
    crpTopicCompleted: false,
    crpWorkProgress: 0,
    crpWorkProgressLabel: "未开始",
    crpWorkProgressSyncedAt: at("2026-11-18T08:15:00Z"),
    submittedAt: at("2026-11-18T08:05:00Z"),
    snapshots: [
      {
        packageName: "deepin-polkit-agent",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1",
        codeVersion: "0.0.13-1",
        repoVersion: "0.0.11-1",
        releaseVersion: "0.0.13",
        status: "dispatching",
        statusChangedAt: at("2026-11-18T08:06:00Z"),
      },
      {
        packageName: "dde-appearance",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2",
        codeVersion: "1.0.10-1",
        repoVersion: "1.0.8-1",
        releaseVersion: "1.0.10",
        status: "pending",
      },
      {
        packageName: "dde-control-center",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3",
        codeVersion: "6.0.19-1",
        repoVersion: "6.0.16-1",
        releaseVersion: "6.0.19",
        status: "pending",
      },
    ],
    repositoryRecords: [
      {
        snapshot: "deepin-polkit-agent@1",
        crpReleaseId: "51401",
        crpBuildId: null,
        repositoryUrl: null,
        crpReleaseState: 1,
        crpStatusName: "等待构建",
      },
    ],
  },
  {
    projectName: "桌面专业版 V20",
    version: "20.9.0",
    createdAt: at("2026-11-17T09:20:00Z"),
    revision: 1,
    status: "abandoned",
    description: "基线切错，建好 Topic 后发现并放弃",
    createdByEmail: "liwei@uniontech.com",
    crpTopicId: "8777",
    crpBranchId: "108",
    crpTopicState: 2,
    crpTopicAbandoned: true,
    crpTopicCompleted: false,
    crpWorkProgress: 0,
    crpWorkProgressLabel: "未开始",
    crpWorkProgressSyncedAt: at("2026-11-17T09:40:00Z"),
    snapshots: [
      {
        packageName: "kwin",
        attempt: 1,
        branch: "develop/eagle",
        commitSha: "f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4",
        codeVersion: "5.27.10.3-1",
        repoVersion: "5.27.10.2-1",
        releaseVersion: "5.27.10.3",
        status: "abandoned",
        statusChangedAt: at("2026-11-17T09:40:00Z"),
      },
    ],
  },
];

/** 端点订阅必须落在 A8 的事件清单里：这里写错类型名，`pnpm typecheck` 就会失败。 */
type WebhookEndpointSeed = {
  workspaceSlug: string;
  name: string;
  url: string;
  secret: string;
  eventTypes: WebhookEventType[];
  enabled: boolean;
  description: string;
};

const WEBHOOK_ENDPOINTS: readonly WebhookEndpointSeed[] = [
  {
    workspaceSlug: "desktop-core",
    name: "桌面核心组提测结果",
    url: "https://hooks.example.com/crp/desktop-core",
    secret: "seed-webhook-secret-desktop-core",
    eventTypes: ["release.created", "build.succeeded", "build.failed"],
    enabled: true,
    description: "桌面核心组的提测结果通知",
  },
  {
    workspaceSlug: "system-apps",
    name: "系统应用组构建失败",
    url: "https://hooks.example.com/crp/system-apps",
    secret: "seed-webhook-secret-system-apps",
    eventTypes: ["build.failed"],
    enabled: false,
    description: "系统应用组只订阅失败事件",
  },
];

/** 日志类数据每次重建：这两张表只记过程，没有业务唯一键可以 upsert。 */
/** 投递记录：签名在写入时按 A8 的公开算法现算，库里存的就是当时发出去的那一份。 */
const WEBHOOK_DELIVERIES = [
  {
    endpointUrl: "https://hooks.example.com/crp/desktop-core",
    eventType: "build.succeeded",
    payload: { releaseId: "seed", version: "25.0.1", status: "success" },
    status: "success" as const,
    attempts: 1,
    lastError: null,
    createdAt: at("2026-11-18T02:58:10Z"),
    deliveredAt: at("2026-11-18T02:58:11Z"),
  },
  {
    endpointUrl: "https://hooks.example.com/crp/desktop-core",
    eventType: "build.failed",
    payload: { releaseId: "seed", version: "25.0.2", status: "failed" },
    status: "failed" as const,
    attempts: 3,
    lastError: "第三次投递仍返回 502",
    createdAt: at("2026-11-18T06:28:10Z"),
    deliveredAt: null,
  },
  {
    endpointUrl: "https://hooks.example.com/crp/system-apps",
    eventType: "build.failed",
    payload: { releaseId: "seed", version: "1.4.0", status: "failed" },
    status: "pending" as const,
    attempts: 0,
    lastError: null,
    createdAt: at("2026-11-18T07:00:00Z"),
    deliveredAt: null,
  },
];

/** 同步范围指向哪张表的哪一行；插入时换成真实的 id，不往库里写拼接串。 */
type SeedSyncTarget =
  | null
  | { baselineName: string }
  | { releaseKey: string };

const SYNC_RUNS = [
  {
    kind: "baseline_list" as const,
    status: "success" as const,
    trigger: "schedule" as const,
    target: null,
    itemCount: 108,
    startedAt: at("2026-11-18T01:00:00Z"),
    finishedAt: at("2026-11-18T01:00:07Z"),
    errorMessage: null,
  },
  {
    kind: "baseline_packages" as const,
    status: "success" as const,
    trigger: "schedule" as const,
    target: { baselineName: "snipe-2500u2" } as SeedSyncTarget,
    itemCount: 488,
    startedAt: at("2026-11-18T01:05:00Z"),
    finishedAt: at("2026-11-18T01:06:12Z"),
    errorMessage: null,
  },
  {
    kind: "release_status" as const,
    status: "success" as const,
    trigger: "schedule" as const,
    target: { releaseKey: "桌面专业版 V25@25.0.1" } as SeedSyncTarget,
    itemCount: 6,
    startedAt: at("2026-11-18T03:10:00Z"),
    finishedAt: at("2026-11-18T03:10:04Z"),
    errorMessage: null,
  },
  {
    kind: "baseline_list" as const,
    status: "failed" as const,
    trigger: "manual" as const,
    target: null,
    itemCount: 0,
    startedAt: at("2026-11-18T07:30:00Z"),
    finishedAt: at("2026-11-18T07:30:31Z"),
    errorMessage: "CRP 返回 502 Bad Gateway，本次同步放弃，等待下一轮定时任务",
  },
];

/**
 * 各表应有的记录数，种子跑完逐条核对；不一致就直接失败，不让脏数据进入后续节点。
 *
 * 每个模型显式写 count，不动态取 Prisma Client 的属性：模型名写错时类型检查就能发现，
 * 不必等运行时才报错。
 */
const EXPECTED_COUNTS: { table: string; expected: number; count: () => Promise<number> }[] = [
  { table: "workspace", expected: 3, count: () => prisma.workspace.count() },
  { table: "app_user", expected: 5, count: () => prisma.user.count() },
  { table: "membership", expected: 7, count: () => prisma.membership.count() },
  { table: "project_manager", expected: 3, count: () => prisma.projectManager.count() },
  { table: "baseline", expected: 4, count: () => prisma.baseline.count() },
  { table: "baseline_package_version", expected: 12, count: () => prisma.baselinePackageVersion.count() },
  { table: "package", expected: 12, count: () => prisma.package.count() },
  { table: "package_dependency", expected: 4, count: () => prisma.packageDependency.count() },
  { table: "project", expected: 4, count: () => prisma.project.count() },
  { table: "project_software", expected: 15, count: () => prisma.projectSoftware.count() },
  { table: "release", expected: 5, count: () => prisma.release.count() },
  { table: "release_package_snapshot", expected: 15, count: () => prisma.releasePackageSnapshot.count() },
  { table: "release_repository_record", expected: 8, count: () => prisma.releaseRepositoryRecord.count() },
  { table: "build_task", expected: 7, count: () => prisma.buildTask.count() },
  { table: "build_job", expected: 12, count: () => prisma.buildJob.count() },
  { table: "webhook_endpoint", expected: 2, count: () => prisma.webhookEndpoint.count() },
  { table: "webhook_delivery", expected: 3, count: () => prisma.webhookDelivery.count() },
  { table: "sync_run", expected: 4, count: () => prisma.syncRun.count() },
];

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

async function seedBaselines(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const item of BASELINES) {
    const row = await prisma.baseline.upsert({
      where: { crpBranchId: item.crpBranchId },
      update: item,
      create: item,
    });
    ids.set(item.name, row.id);
  }

  return ids;
}

async function seedWorkspaces(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const item of WORKSPACES) {
    const row = await prisma.workspace.upsert({
      where: { slug: item.slug },
      update: { name: item.name },
      create: item,
    });
    ids.set(item.slug, row.id);
  }

  return ids;
}

async function seedUsers(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const item of USERS) {
    const row = await prisma.user.upsert({
      where: { email: item.email },
      update: item,
      create: item,
    });
    ids.set(item.email, row.id);
  }

  return ids;
}

async function seedMemberships(
  workspaceIds: Map<string, string>,
  userIds: Map<string, string>,
): Promise<void> {
  for (const item of MEMBERSHIPS) {
    const workspaceId = requireId(workspaceIds, item.workspaceSlug);
    const userId = requireId(userIds, item.userEmail);

    await prisma.membership.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      update: { role: item.role },
      create: { workspaceId, userId, role: item.role },
    });
  }
}

async function seedProjectManagers(
  workspaceIds: Map<string, string>,
  userIds: Map<string, string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const item of PROJECT_MANAGERS) {
    const workspaceId = requireId(workspaceIds, item.workspaceSlug);
    const userId = item.userEmail ? requireId(userIds, item.userEmail) : null;

    const row = await prisma.projectManager.upsert({
      where: { workspaceId_name: { workspaceId, name: item.name } },
      update: { userId },
      create: { workspaceId, name: item.name, userId },
    });
    ids.set(item.name, row.id);
  }

  return ids;
}

async function seedPackages(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const item of PACKAGES) {
    const row = await prisma.package.upsert({
      where: { name: item.name },
      update: item,
      create: item,
    });
    ids.set(item.name, row.id);
  }

  for (const item of PACKAGE_DEPENDENCIES) {
    const packageId = requireId(ids, item.name);
    const upstreamPackageId = requireId(ids, item.upstream);

    await prisma.packageDependency.upsert({
      where: { packageId_upstreamPackageId: { packageId, upstreamPackageId } },
      update: {},
      create: { packageId, upstreamPackageId },
    });
  }

  return ids;
}

async function seedBaselinePackageVersions(
  baselineIds: Map<string, string>,
): Promise<void> {
  for (const item of BASELINE_PACKAGE_VERSIONS) {
    const baselineId = requireId(baselineIds, item.baselineName);

    await prisma.baselinePackageVersion.upsert({
      where: {
        baselineId_packageName: { baselineId, packageName: item.packageName },
      },
      update: {
        version: item.version,
        fetchedAt: at("2026-11-18T01:06:12Z"),
      },
      create: {
        baselineId,
        packageName: item.packageName,
        version: item.version,
        fetchedAt: at("2026-11-18T01:06:12Z"),
      },
    });
  }
}

async function seedProjects(
  workspaceIds: Map<string, string>,
  baselineIds: Map<string, string>,
  managerIds: Map<string, string>,
  packageIds: Map<string, string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const item of PROJECTS) {
    const workspaceId = requireId(workspaceIds, item.workspaceSlug);
    const baselineId = requireId(baselineIds, item.baselineName);
    const projectManagerId = requireId(managerIds, item.managerName);
    const fields = {
      workspaceId,
      projectManagerId,
      baselineId,
      key: item.key,
      name: item.name,
      description: item.description,
    };

    const row = await prisma.project.upsert({
      where: { workspaceId_name: { workspaceId, name: item.name } },
      update: fields,
      create: fields,
    });
    ids.set(item.name, row.id);

    for (const packageName of item.software) {
      const packageId = requireId(packageIds, packageName);
      const pkg = PACKAGES.find((entry) => entry.name === packageName);

      await prisma.projectSoftware.upsert({
        where: { projectId_packageId: { projectId: row.id, packageId } },
        update: { trackedBranch: pkg?.defaultBranch ?? "develop/eagle" },
        create: {
          projectId: row.id,
          packageId,
          trackedBranch: pkg?.defaultBranch ?? "develop/eagle",
        },
      });
    }
  }

  return ids;
}

/** 提测记录在种子里的引用键：项目名 + 版本号。 */
function releaseKey(projectName: string, version: string): string {
  return `${projectName}@${version}`;
}

async function upsertRelease(
  item: SeedRelease,
  projectId: string,
  createdById: string,
) {
  const fields = {
    projectId,
    version: item.version,
    revision: item.revision,
    status: item.status,
    description: item.description,
    createdById,
    crpTopicId: item.crpTopicId ?? null,
    crpBranchId: item.crpBranchId ?? null,
    crpTopicState: item.crpTopicState ?? null,
    crpTopicAbandoned: item.crpTopicAbandoned ?? null,
    crpTopicCompleted: item.crpTopicCompleted ?? null,
    crpWorkProgress: item.crpWorkProgress ?? null,
    createdAt: item.createdAt,
    crpWorkProgressLabel: item.crpWorkProgressLabel ?? null,
    crpWorkProgressSyncedAt: item.crpWorkProgressSyncedAt ?? null,
    submittedAt: item.submittedAt ?? null,
    finishedAt: item.finishedAt ?? null,
  };

  return prisma.release.upsert({
    where: { projectId_version: { projectId, version: item.version } },
    update: fields,
    create: fields,
  });
}

/** 写一轮快照，返回 `包名@轮次` → 快照 id 的映射，后面几件事都按它定位。 */
async function upsertSnapshots(
  releaseId: string,
  snapshots: SeedSnapshot[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const snapshot of snapshots) {
    const fields = {
      releaseId,
      packageName: snapshot.packageName,
      attempt: snapshot.attempt,
      branch: snapshot.branch,
      commitSha: snapshot.commitSha,
      codeVersion: snapshot.codeVersion,
      repoVersion: snapshot.repoVersion,
      releaseVersion: snapshot.releaseVersion,
      status: snapshot.status,
      statusChangedAt: snapshot.statusChangedAt ?? null,
      supersededAt: snapshot.supersededAt ?? null,
    };

    const row = await prisma.releasePackageSnapshot.upsert({
      where: {
        releaseId_packageName_attempt: {
          releaseId,
          packageName: snapshot.packageName,
          attempt: snapshot.attempt,
        },
      },
      update: fields,
      create: fields,
    });

    ids.set(`${snapshot.packageName}@${snapshot.attempt}`, row.id);
  }

  return ids;
}

/** 被替换的轮次指向新轮：两行都写完之后再回填 supersededById。 */
async function linkSupersededSnapshots(
  snapshots: SeedSnapshot[],
  snapshotIds: Map<string, string>,
): Promise<void> {
  for (const snapshot of snapshots) {
    if (!snapshot.supersededBy) {
      continue;
    }

    const id = requireId(snapshotIds, `${snapshot.packageName}@${snapshot.attempt}`);
    const supersededById = requireId(snapshotIds, snapshot.supersededBy);

    await prisma.releasePackageSnapshot.update({
      where: { id },
      data: {
        supersededById,
        supersededAt: snapshot.supersededAt ?? at("2026-11-18T02:26:00Z"),
      },
    });
  }
}

async function upsertRepositoryRecords(
  releaseId: string,
  records: NonNullable<SeedRelease["repositoryRecords"]>,
  snapshotIds: Map<string, string>,
): Promise<void> {
  for (const record of records) {
    const snapshotId = requireId(snapshotIds, record.snapshot);
    const fields = {
      releaseId,
      snapshotId,
      crpReleaseId: record.crpReleaseId,
      crpBuildId: record.crpBuildId,
      repositoryUrl: record.repositoryUrl,
      crpReleaseState: record.crpReleaseState,
      crpStatusName: record.crpStatusName,
      lastSyncedAt: at("2026-11-18T03:10:00Z"),
    };

    await prisma.releaseRepositoryRecord.upsert({
      where: { snapshotId },
      update: fields,
      create: fields,
    });
  }
}

async function upsertBuildTasks(
  releaseId: string,
  tasks: NonNullable<SeedRelease["buildTasks"]>,
  snapshotIds: Map<string, string>,
): Promise<void> {
  for (const task of tasks) {
    const snapshotId = requireId(snapshotIds, task.snapshot);
    const taskFields = {
      releaseId,
      snapshotId,
      shuttleTaskId: task.shuttleTaskId,
      status: task.status,
      lastPolledAt: task.lastPolledAt ?? null,
      startedAt: task.startedAt ?? null,
      finishedAt: task.finishedAt ?? null,
    };

    const buildTask = await prisma.buildTask.upsert({
      where: { snapshotId },
      update: taskFields,
      create: taskFields,
    });

    for (const job of task.jobs) {
      const jobFields = {
        buildTaskId: buildTask.id,
        arch: job.arch,
        status: job.status,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
      };

      await prisma.buildJob.upsert({
        where: { shuttleJobId: job.shuttleJobId },
        update: jobFields,
        create: { ...jobFields, shuttleJobId: job.shuttleJobId },
      });
    }
  }
}

async function seedReleases(
  projectIds: Map<string, string>,
  userIds: Map<string, string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const item of RELEASES) {
    const release = await upsertRelease(
      item,
      requireId(projectIds, item.projectName),
      requireId(userIds, item.createdByEmail),
    );

    const snapshotIds = await upsertSnapshots(release.id, item.snapshots);
    await linkSupersededSnapshots(item.snapshots, snapshotIds);
    await upsertRepositoryRecords(release.id, item.repositoryRecords ?? [], snapshotIds);
    await upsertBuildTasks(release.id, item.buildTasks ?? [], snapshotIds);

    ids.set(releaseKey(item.projectName, item.version), release.id);
  }

  return ids;
}

async function seedWebhooks(workspaceIds: Map<string, string>): Promise<void> {
  const endpointIds = new Map<string, string>();
  const secretByUrl = new Map<string, string>();

  for (const item of WEBHOOK_ENDPOINTS) {
    const workspaceId = requireId(workspaceIds, item.workspaceSlug);
    const fields = {
      workspaceId,
      name: item.name,
      url: item.url,
      secret: item.secret,
      eventTypes: [...item.eventTypes],
      enabled: item.enabled,
      description: item.description,
    };

    const row = await prisma.webhookEndpoint.upsert({
      where: { workspaceId_url: { workspaceId, url: item.url } },
      update: fields,
      create: fields,
    });
    endpointIds.set(item.url, row.id);
    secretByUrl.set(item.url, item.secret);
  }

  // 投递记录只记过程，没有业务唯一键，每次重建。
  await prisma.webhookDelivery.deleteMany();

  for (const item of WEBHOOK_DELIVERIES) {
    // 签名按 A8 的公开算法现算：时间戳取这条记录的时间，正文就是入库的那份 JSON。
    const secret = requireId(secretByUrl, item.endpointUrl);
    const timestamp = Math.floor(item.createdAt.getTime() / 1000).toString();
    const signature = computeWebhookSignature(secret, timestamp, JSON.stringify(item.payload));

    await prisma.webhookDelivery.create({
      data: {
        endpointId: requireId(endpointIds, item.endpointUrl),
        eventType: item.eventType,
        payload: item.payload,
        signature,
        status: item.status,
        attempts: item.attempts,
        lastError: item.lastError,
        createdAt: item.createdAt,
        deliveredAt: item.deliveredAt,
      },
    });
  }
}

async function seedSyncRuns(
  baselineIds: Map<string, string>,
  releaseIds: Map<string, string>,
): Promise<void> {
  // 同步记录只记过程，没有业务唯一键，每次重建。
  await prisma.syncRun.deleteMany();

  for (const item of SYNC_RUNS) {
    const targetId = resolveSyncTarget(item.target, baselineIds, releaseIds);

    await prisma.syncRun.create({
      data: {
        kind: item.kind,
        status: item.status,
        trigger: item.trigger,
        targetId,
        itemCount: item.itemCount,
        startedAt: item.startedAt,
        finishedAt: item.finishedAt,
        errorMessage: item.errorMessage,
      },
    });
  }
}

/** 把种子里的同步范围换成真实 id；基线类指向 baseline.id，提测类指向 release.id。 */
function resolveSyncTarget(
  target: SeedSyncTarget,
  baselineIds: Map<string, string>,
  releaseIds: Map<string, string>,
): string | null {
  if (target === null) {
    return null;
  }

  if ("baselineName" in target) {
    return requireId(baselineIds, target.baselineName);
  }

  return requireId(releaseIds, target.releaseKey);
}

/** 从映射里取值，取不到直接抛错，避免静默写入空数据。 */
function requireId(ids: Map<string, string>, key: string): string {
  const id = ids.get(key);

  if (!id) {
    throw new Error(`种子数据引用了不存在的记录：${key}`);
  }

  return id;
}

async function reportCounts(): Promise<void> {
  const actual: { table: string; expected: number; actual: number }[] = [];

  for (const item of EXPECTED_COUNTS) {
    actual.push({ table: item.table, expected: item.expected, actual: await item.count() });
  }

  console.log("表名                          期望   实际");
  for (const row of actual) {
    const mark = row.expected === row.actual ? "✅" : "❌";
    console.log(`${row.table.padEnd(28)} ${String(row.expected).padStart(4)} ${String(row.actual).padStart(5)} ${mark}`);
  }

  const mismatched = actual.filter((row) => row.expected !== row.actual);

  if (mismatched.length > 0) {
    throw new Error(
      `种子记录数与声明不一致：${mismatched.map((row) => `${row.table} 期望 ${row.expected} 实际 ${row.actual}`).join("；")}`,
    );
  }

  console.log(`种子数据写入完成，共 ${actual.length} 张表全部与声明一致。`);
}

async function seed(): Promise<void> {
  const baselineIds = await seedBaselines();
  const workspaceIds = await seedWorkspaces();
  const userIds = await seedUsers();

  await seedMemberships(workspaceIds, userIds);
  const managerIds = await seedProjectManagers(workspaceIds, userIds);
  const packageIds = await seedPackages();

  await seedBaselinePackageVersions(baselineIds);

  const projectIds = await seedProjects(workspaceIds, baselineIds, managerIds, packageIds);
  const releaseIds = await seedReleases(projectIds, userIds);

  await seedWebhooks(workspaceIds);
  await seedSyncRuns(baselineIds, releaseIds);

  await reportCounts();
}

async function main(): Promise<void> {
  try {
    await seed();
  } finally {
    await prisma.$disconnect();
  }
}

// 种子与断开连接的任何失败都落到同一个 catch，避免出现无人处理的 Promise 拒绝。
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
