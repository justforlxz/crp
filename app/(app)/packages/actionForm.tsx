"use client";

/**
 * 带提交状态与错误提示的表单。
 *
 * 唯一的客户端组件：表单本身还是普通的 HTML 表单，这里只负责把服务端动作返回的
 * 错误贴回页面上，并在提交期间禁用按钮。依赖成环的拒绝信息就是靠它显示出来的。
 *
 * 反馈走原型的全局 `.toast`（MKACG-972）：成功与失败都用轻提示，数秒后自己消失，
 * 不再把一行常驻的 `.alert` 塞在表单里。视觉沿用 `.alert` 的配色，`.toast` 只表达
 * 「这条会消失」。
 */

import { useActionState } from "react";
import type { ReactNode } from "react";

import { Toast } from "@/components/toast";

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
      <Toast
        className="toast alert alert--error"
        role="alert"
        message={state?.error ?? null}
      />
      <Toast className="toast alert alert--info" message={state?.message ?? null} />
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
