import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 根路径只做重定向：用户从 base URL 打开时直接进工作台。
   *
   * 只写 `/` 这一条，不写 `/:path*` 之类的通配；登录判断仍然只由 `/dashboard` 的
   * `requirePageAuth` 负责，未登录时由它跳登录页并带上 `next=/dashboard`。
   * 必须用临时重定向（307）：目标以后可能变，不能让浏览器把 308 缓存下来。
   */
  async redirects() {
    return [{ source: "/", destination: "/dashboard", permanent: false }];
  },
};

export default nextConfig;
