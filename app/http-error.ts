/**
 * 从接口响应里取错误文案。
 *
 * 登录、注册、工作台三处都要做同一件事，抽到这里，避免同一段判空逻辑抄三份。
 * 响应不是约定的 `{error:{message}}` 形状时返回兜底文案。
 */
export async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);

  if (typeof body === "object" && body !== null && "error" in body) {
    return (body.error as { message?: string }).message ?? fallback;
  }

  return fallback;
}
