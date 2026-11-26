"use client";

/**
 * 项目经理卡片网格（MKACG-971 / MKACG-984 按原型重做，MKACG-1017 第二行改成邮箱）。
 *
 * 结构与 class 名照 `.agents/spec/design/prototype.html` 的项目页与项目经理页：
 * `.manager-grid` → `.manager-card`，卡内是 `.avatar` + `.manager-name` / `.manager-meta` +
 * 右侧 `.manager-n`（名下项目数）。
 *
 * 第二行显示**邮箱**，不再显示「已绑定 / 未绑定平台账号」，也不显示工作区（MKACG-1017）。
 * 没有填邮箱的经理显示「未填写邮箱」，不编一个地址。
 *
 * 项目页用的是 `projects/projectManagerGrid.tsx` 里的另一份同构卡片（门禁只扫每页自己的
 * 目录），两处的结构与文案必须一起改；「名下项目」数两页同源（`listManagers()` 的
 * `projectCount`），不会一边 2 一边 3。
 *
 * 传了 `onEdit` 时卡片是可点的按钮（项目经理页点开编辑弹窗）；不传时是纯展示的 `div`，
 * 项目页那份卡片就是这样 —— 两处的 DOM 与文案仍然逐字一致。
 */

import type { ManagerCardData } from "../../../lib/projects";

export type { ManagerCardData };

export type ManagerGridProps = {
  managers: readonly ManagerCardData[];
  /** 点卡片时打开编辑弹窗；不传就是纯展示。 */
  onEdit?: (manager: ManagerCardData) => void;
};

/** 卡片第二行的文案：有邮箱写邮箱，没有就说清楚没填。 */
export function managerMetaText(manager: Pick<ManagerCardData, "email">): string {
  return manager.email === null || manager.email === "" ? "未填写邮箱" : manager.email;
}

export function ManagerGrid({ managers, onEdit }: ManagerGridProps) {
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
      {managers.map((manager) => {
        const content = (
          <>
            <span className="avatar" aria-hidden="true">
              {manager.name.slice(0, 1)}
            </span>
            <span>
              <span className="manager-name">{manager.name}</span>
              <span className="manager-meta">{managerMetaText(manager)}</span>
            </span>
            <span className="manager-n">
              <b className="num">{manager.projectCount}</b>
              <span>个项目</span>
            </span>
          </>
        );

        return onEdit === undefined ? (
          <div key={manager.id} className="manager-card">
            {content}
          </div>
        ) : (
          <button
            key={manager.id}
            type="button"
            className="manager-card"
            onClick={() => onEdit(manager)}
            aria-label={`编辑项目经理 ${manager.name}`}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
