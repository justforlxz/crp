/**
 * 项目经理卡片网格（MKACG-971 / MKACG-984 按原型重做）。
 *
 * 结构与 class 名照 `.agents/spec/design/prototype.html` 的项目页与项目经理页：
 * `.manager-grid` → `.manager-card`，卡内是 `.avatar` + `.manager-name` / `.manager-meta` +
 * 右侧 `.manager-n`（名下项目数）。
 *
 * 项目页用的是 `projects/projectManagerGrid.tsx` 里的另一份同构卡片（门禁只扫每页自己的
 * 目录），两处的结构与文案必须一起改；「名下项目」数两页同源（`listManagers()` 的
 * `projectCount`），不会一边 2 一边 3。
 */

/** 一张经理卡需要的最小字段：`listManagers()` 的行就是它。 */
export type ManagerCardData = {
  id: string;
  name: string;
  userId: string | null;
  projectCount: number;
};

export function ManagerGrid({ managers }: { managers: readonly ManagerCardData[] }) {
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
