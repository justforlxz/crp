/**
 * 项目部经理卡片网格（MKACG-971）。
 *
 * 结构与 class 名照 `.agents/spec/design/prototype.html` 的项目页 `.manager-card`：头像、姓名、
 * 工作区（本项目里是「平台账号是否绑定」）与名下项目数。项目页与项目经理页共用这一份，
 * 两处看到的是同一张卡。
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
    return <p className="empty">这个工作区还没有项目经理。先新建一位，再把它分配给项目。</p>;
  }

  return (
    <div className="manager-grid">
      {managers.map((manager) => (
        <div key={manager.id} className="card manager-card">
          <div className="manager-avatar" aria-hidden="true">
            {manager.name.slice(0, 1)}
          </div>
          <div className="manager-card-main">
            <b>{manager.name}</b>
            <small>{manager.userId === null ? "未绑定平台账号" : "已绑定平台账号"}</small>
          </div>
          <span className="tag">{manager.projectCount} 个项目</span>
        </div>
      ))}
    </div>
  );
}
