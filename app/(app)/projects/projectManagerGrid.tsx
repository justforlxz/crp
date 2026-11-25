/**
 * 项目页顶部的经理卡网格（MKACG-984）。
 *
 * 与项目经理页的 `managers/managerGrid.tsx` 是同一张卡、同一份数据源（`listManagers()` 的
 * `projectCount`），这里另起一份而不是共用组件，是因为 `pnpm check:modules` 只从每页
 * `modules.json` 里列出的目录读 `className`：`/projects` 只扫 `app/(app)/projects/`，
 * 复用别的目录里的组件会让 `.manager-grid` `.manager-card` 这些模块在门禁里显示成缺失。
 *
 * 两处的卡片结构与文案必须一起改：改这里时同步改 `app/(app)/managers/managerGrid.tsx`。
 */
import type { ManagerCardData } from "../managers/managerGrid";

export function ProjectManagerGrid({ managers }: { managers: readonly ManagerCardData[] }) {
  if (managers.length === 0) {
    return (
      <div className="empty">
        <div className="empty-ico" aria-hidden="true">◇</div>
        <div className="empty-t">这个工作区还没有项目经理</div>
        <div className="empty-d">先到「项目经理」页新建一位，再把它分配给项目。</div>
      </div>
    );
  }

  return (
    <div className="manager-grid">
      {managers.map((manager) => (
        <div key={manager.id} className="manager-card">
          <span className="avatar" aria-hidden="true">
            {manager.name.slice(0, 1)}
          </span>
          <span>
            <span className="manager-name">{manager.name}</span>
            <span className="manager-meta">
              {manager.userId === null ? "未绑定平台账号" : "已绑定平台账号"}
            </span>
          </span>
          <span className="manager-n">
            <b className="num">{manager.projectCount}</b>
            <span>个项目</span>
          </span>
        </div>
      ))}
    </div>
  );
}
