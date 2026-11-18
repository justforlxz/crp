/**
 * 接口用到的小工具：读 JSON 请求体、造错误响应。
 *
 * 请求体只接受 JSON 对象；解析失败或类型不对一律 400，不让 route handler 各自写一套 try/catch。
 */
import { NextResponse } from "next/server";

/** 读请求体；不是 JSON 对象时返回 null。 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }

    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 统一的错误响应，形状与 `server.ts` 的守卫一致。 */
export function errorJson(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** 从请求体里取字符串字段，取不到时返回空串。 */
export function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === "string" ? value : "";
}
