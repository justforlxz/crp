"use client";

/**
 * 复制一个值到剪贴板。
 *
 * 详情页的 Topic ID 与 Topic 地址要能一键复制（SHOULD）：这两样都是拿去和别人对话、或者
 * 贴进别的系统里用的，靠手抄容易错。
 *
 * 不用 `navigator.clipboard` 之外的兼容层：平台跑在内网 HTTPS 上，非安全上下文用不了这个 API
 * 时才需要回退，这里不做。
 */

import { useState } from "react";

export function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
          },
          () => {
            // 复制被浏览器拒绝（例如非安全上下文）时保持原样：不谎称成功。
            setCopied(false);
          },
        );
      }}
    >
      {copied ? "已复制" : label}
    </button>
  );
}
