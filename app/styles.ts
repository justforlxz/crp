/**
 * 页面共用的一点内联样式。
 *
 * 仓库里没有 CSS 框架，也没有全局样式表；这一版只有登录、注册、工作台三个页面，
 * 用内联样式把这些页面拼起来就够了，不为它引入样式方案。
 */
import type { CSSProperties } from "react";

export const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    margin: 0,
    padding: "48px 24px",
    fontFamily: "system-ui, -apple-system, 'Noto Sans CJK SC', sans-serif",
    background: "#f5f6f8",
    color: "#1f2329",
  },
  card: {
    maxWidth: 420,
    margin: "0 auto",
    padding: 24,
    background: "#ffffff",
    borderRadius: 8,
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.12)",
  },
  wideCard: {
    maxWidth: 760,
    margin: "0 auto",
    padding: 24,
    background: "#ffffff",
    borderRadius: 8,
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.12)",
  },
  title: { margin: "0 0 8px", fontSize: 20 },
  hint: { margin: "12px 0 0", fontSize: 13, color: "#646a73" },
  label: { display: "block", margin: "16px 0 6px", fontSize: 13, color: "#646a73" },
  input: {
    width: "100%",
    padding: "8px 10px",
    fontSize: 14,
    border: "1px solid #d0d3d9",
    borderRadius: 4,
    boxSizing: "border-box",
  },
  button: {
    marginTop: 20,
    padding: "9px 16px",
    fontSize: 14,
    color: "#ffffff",
    background: "#1664ff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
  },
  smallButton: {
    padding: "4px 10px",
    fontSize: 13,
    color: "#1664ff",
    background: "#eef3ff",
    border: "1px solid #c5d8ff",
    borderRadius: 4,
    cursor: "pointer",
  },
  error: {
    margin: "16px 0 0",
    padding: "8px 10px",
    fontSize: 13,
    color: "#b3261e",
    background: "#fdeceb",
    borderRadius: 4,
  },
  row: { display: "flex", gap: 8, alignItems: "center", padding: "8px 0" },
  section: { marginTop: 24 },
  list: { margin: 0, padding: 0, listStyle: "none" },
};
