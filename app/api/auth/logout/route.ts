/**
 * 退出登录：撤销当前会话并清掉 Cookie。
 *
 * 幂等：没有会话、会话已撤销、Cookie 不存在都返回 204，重复退出不报错。
 */
import { NextResponse } from "next/server";

import { clearSessionCookie, endSession } from "@/lib/auth/server";

export async function POST(request: Request): Promise<NextResponse> {
  await endSession();
  return clearSessionCookie(new NextResponse(null, { status: 204 }), request);
}
