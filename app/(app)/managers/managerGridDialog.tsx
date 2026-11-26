"use client";

/**
 * 项目经理页的经理卡与编辑弹窗（MKACG-1017）。
 *
 * 卡片本身是纯展示的 `ManagerGrid`（项目页也用它那份同构卡）；「点卡片打开编辑弹窗」是纯客户端
 * 状态，所以在这一层接上。改名以前是清单表里的一列输入框，现在收进这个弹窗
 * （`design.md` 第九节：项目经理卡（项目经理页）打开「编辑项目经理」弹窗）。
 */

import { useState } from "react";

import type { ManagerCardData } from "@/lib/projects";

import { ManagerGrid } from "./managerGrid";
import { EditManagerDialog } from "./newManagerDialog";

export type ManagerGridWithDialogProps = {
  managers: readonly ManagerCardData[];
  workspaceId: string;
  workspaceSlug: string;
};

export function ManagerGridWithDialog({
  managers,
  workspaceId,
  workspaceSlug,
}: ManagerGridWithDialogProps) {
  const [editing, setEditing] = useState<ManagerCardData | null>(null);

  return (
    <>
      <ManagerGrid managers={managers} onEdit={setEditing} />

      {editing === null ? null : (
        <EditManagerDialog
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          manager={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
