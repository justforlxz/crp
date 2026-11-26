"use client";

/**
 * 「新建 / 编辑项目经理」弹窗（MKACG-1002 从内嵌表单改成弹窗，MKACG-1017 补邮箱、去掉工作区）。
 *
 * 按界面规范 v2 的弹层模块（`design.md` 第七节 `.scrim` / `.modal` 一族）与第九节交互契约：
 *
 *   `.panel-hd` 右侧的「新建项目经理」按钮 → `Modal`（遮罩、×、Esc 三种关闭）
 *   → `.field` + `.label` + `.input` 的姓名与邮箱两个输入
 *
 * 表单只有姓名与邮箱，**没有工作区选择**（MKACG-1017）：工作区是数据层的多租户边界，
 * 不是界面上的分组维度。提示写清「姓名在当前工作区内唯一，其他组的人在他们自己的工作区里添加」。
 *
 * 新建与编辑共用同一个表单，只是提交的服务端动作不同：新建走 `createManagerAction`，
 * 编辑走 `updateManagerAction` 并带上 `managerId`。
 */

import { useState } from "react";

import { Icon } from "@/components/icons";
import { Modal } from "@/components/modal";
import type { ManagerCardData } from "@/lib/projects";

import { createManagerAction, updateManagerAction } from "./actions";

/** 表单与底部「保存」按钮靠 `form` 属性配对：按钮在 `.modal-ft` 里，不在 `<form>` 里。 */
const FORM_ID = "manager-form";

export type ManagerFormProps = {
  workspaceId: string;
  workspaceSlug: string;
  /** 编辑时传当前经理；不传就是新建。 */
  manager?: Pick<ManagerCardData, "id" | "name" | "email">;
};

/** 新建 / 编辑项目经理的表单本体。单独导出是为了能直接渲染它做结构断言。 */
export function ManagerForm({ workspaceId, workspaceSlug, manager }: ManagerFormProps) {
  const editing = manager !== undefined;

  return (
    <form id={FORM_ID} action={editing ? updateManagerAction : createManagerAction}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="workspaceSlug" value={workspaceSlug} />
      {editing ? <input type="hidden" name="managerId" value={manager.id} /> : null}

      <div className="form-row2">
        <div className="field">
          <label className="label" htmlFor="manager-name">
            姓名
          </label>
          <input
            id="manager-name"
            className="input"
            name="name"
            required
            defaultValue={manager?.name ?? ""}
            placeholder="李伟"
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="manager-email">
            邮箱
          </label>
          <input
            id="manager-email"
            className="input"
            name="email"
            type="email"
            defaultValue={manager?.email ?? ""}
            placeholder="name@uniontech.com"
          />
        </div>
      </div>

      <div className="tip">
        <span aria-hidden="true">ⓘ</span>
        <div>
          <b>姓名在当前工作区内唯一。</b>
          其他组的人在他们自己的工作区里添加，这里看不到。
        </div>
      </div>
    </form>
  );
}

export type NewManagerDialogProps = {
  workspaceId: string;
  workspaceSlug: string;
};

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

export type EditManagerDialogProps = {
  workspaceId: string;
  workspaceSlug: string;
  manager: Pick<ManagerCardData, "id" | "name" | "email">;
  onClose: () => void;
};

/** 点经理卡打开的编辑弹窗。 */
export function EditManagerDialog({
  workspaceId,
  workspaceSlug,
  manager,
  onClose,
}: EditManagerDialogProps) {
  return (
    <div className="modal-root">
      <Modal
        className="modal"
        title="编辑项目经理"
        onClose={onClose}
        footer={
          <>
            <div className="spacer" />
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" form={FORM_ID} className="btn btn-primary">
              保存
            </button>
          </>
        }
      >
        <ManagerForm workspaceId={workspaceId} workspaceSlug={workspaceSlug} manager={manager} />
      </Modal>
    </div>
  );
}
