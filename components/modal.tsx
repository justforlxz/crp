"use client";

/**
 * 原型的 `.modal` 结构（MKACG-972）：外层 + 头部 + 主体 + 底部操作区。
 *
 * 为什么 `className` 由调用方给：`.modal` 是 `.agents/spec/design/modules.json` 里的**全局模块**，
 * 而 `pnpm check:modules` 只从页面源码里读 `className`。模块名藏在组件内部，门禁就看不到它。
 * 所以模块名写在页面文件里，宽版传 `"modal wide"`（原型 `.modal.wide`），普通版传 `"modal"`。
 *
 * 关闭行为照原型：点遮罩、点右上角 ×、按 Esc 都走 `onClose`。遮罩只在「点在遮罩本身」时关闭，
 * 点内容里冒泡上来的不算 —— 与原型 `data-action="backdrop"` 的判断一致。
 *
 * 不加动画（design.md 第九节）。样式只从 `app/globals.css` 来，这里不写内联 `style`；
 * 视觉沿用已有的 `.card` / `.panel-head`，模块本身只表达结构。
 */

import { useEffect, useId, type ReactNode } from "react";

export type ModalProps = {
  /** 原型模块名，由页面给出：`"modal"` 或 `"modal wide"`。 */
  className: string;
  /** 头部标题，同时作为对话框的无障碍名字。 */
  title: ReactNode;
  children: ReactNode;
  /** 底部操作区；不传就只出头部与主体。 */
  footer?: ReactNode;
  /** 关闭：遮罩点击、× 按钮、Esc 都调它。 */
  onClose: () => void;
};

export function Modal({ className, title, children, footer, onClose }: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className={`${className} card`} role="dialog" aria-labelledby={titleId}>
        <div className="modal-head panel-head">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="close btn btn-secondary btn-sm"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer === undefined ? null : <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
