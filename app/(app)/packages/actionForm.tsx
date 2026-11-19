"use client";

/**
 * 带提交状态与错误提示的表单。
 *
 * 唯一的客户端组件：表单本身还是普通的 HTML 表单，这里只负责把服务端动作返回的
 * 错误贴回页面上，并在提交期间禁用按钮。依赖成环的拒绝信息就是靠它显示出来的。
 */

import { useActionState } from "react";
import type { ReactNode } from "react";

import type { ActionState } from "./actionState";

type FormAction = (
  previous: ActionState,
  formData: FormData,
) => Promise<ActionState>;

export function ActionForm({
  action,
  submitLabel,
  variant = "primary",
  children,
}: {
  action: FormAction;
  submitLabel: string;
  /** 按钮档位：默认主按钮，删除这类不可逆操作传 `danger`。 */
  variant?: "primary" | "danger";
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction}>
      {children}
      {state?.error ? <p className="alert alert--error" role="alert">{state.error}</p> : null}
      {state?.message ? <p className="alert alert--info" role="status">{state.message}</p> : null}
      <button
        type="submit"
        className={variant === "danger" ? "btn btn-danger" : "btn btn-primary"}
        disabled={pending}
      >
        {pending ? "处理中…" : submitLabel}
      </button>
    </form>
  );
}
