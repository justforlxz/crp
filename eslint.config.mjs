import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    // Default ignores of eslint-config-next.
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma Client 由 `prisma generate` 生成，不入库也不参与检查。
    "generated/**",
  ]),
]);

export default eslintConfig;
