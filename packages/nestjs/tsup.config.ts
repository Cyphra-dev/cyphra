import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@nestjs/common", "@nestjs/core", "@nestjs/terminus", "cyphra", "reflect-metadata"],
});
