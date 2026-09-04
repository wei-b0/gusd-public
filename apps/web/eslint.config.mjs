import { config } from "@gusd/eslint-config/base";

export default [
  ...config,
  {
    ignores: [".next/**", "next-env.d.ts", ".impeccable/**"],
  },
];
