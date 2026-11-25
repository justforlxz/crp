"use client";

/**
 * 「新建项目经理」改成弹窗（MKACG-1002）。
 *
 * MKACG-984 把新建做成了 `.panel-bd` 里的内嵌表单，与端点页同一个毛病：页面上摊着一个没套
 * `.field` / `.label` / `.input` 的表单，看起来像没排版。这里按界面规范 v2 的弹层模块
 * （`design.md` 第七节 `.scrim` / `.modal` 一族）挪进弹窗，复用 `components/modal.tsx`：
 *
 *   `.panel-hd` 右侧的「新建项目经理」按钮 → `Modal`（遮罩、×、Esc 三种关闭）
 *   → `.field` + `.label` + `.input` 的姓名输入
 *
 * 原型的项目经理页没有新建入口（它只有经理卡与清单表）。这里的按钮是现有能力的入口，位置沿用
 * 同页清单面板的头部动作位（与基线页的「立即同步」、端点页的「新增端点」一致），不新造模块。
 */

import { useState } from "react";

import { Icon } from "@/components/icons";
import { Modal } from "@/components/modal";

import { createManagerAction } from "./actions";

/** 表单与底部「保存」按钮靠 `form` 属性配对：按钮在 `.modal-ft` 里，不在 `<form>` 里。 */
const FORM_ID = "new-manager-form";

export type ManagerFormProps = {
  workspaceId: string;
  workspaceSlug: string;
};

/** 新建项目经理的表单本体。单独导出是为了能直接渲染它做结构断言。 */
export function ManagerForm({ workspaceId, workspaceSlug }: ManagerFormProps) {
  return (
    <form id={FORM_ID} action={createManagerAction}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />

      <div className="field">
        <label className="label" htmlFor="manager-name">
          姓名
        </label>
        <input
          id="manager-name"
          className="input"
          name="name"
          required
          placeholder="李伟"
        />
        <div className="note">同一个工作区内不能重名；改名只改姓名，不动工作区归属与名下项目。</div>
      </div>
    </form>
  );
}

export type NewManagerDialogProps = ManagerFormProps;

/** 「新建项目经理」按钮 + 点开后挂载的弹窗。 */
export function NewManagerDialog({ workspaceId, workspaceSlug }: NewManagerDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        新建项目经理
      </button>

      {open ? (
        // `.modal-root` 是原型里的弹层容器（固定定位 + `z-index: 100`）。少了它，`.scrim`
        // 的 `z-index` 是 auto，会被这块清单表的吸顶表头（`table.grid th` 是 `z-index: 1`）
        // 压在下面：实测弹窗顶部那一带点不动，× 与表单控件都被表头截走。
        <div className="modal-root">
          <Modal
            className="modal"
            title="新建项目经理"
            onClose={() => setOpen(false)}
            footer={
              <>
                <div className="spacer" />
                <button type="button" className="btn" onClick={() => setOpen(false)}>
                  取消
                </button>
                <button type="submit" form={FORM_ID} className="btn btn-primary">
                  保存
                </button>
              </>
            }
          >
            <ManagerForm workspaceId={workspaceId} workspaceSlug={workspaceSlug} />
          </Modal>
        </div>
      ) : null}
    </>
  );
}
