import ts from "typescript";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Compile the app's TypeScript with tsc instead of esbuild: Nest resolves constructor parameters
 * from their design-time types (emitDecoratorMetadata), which esbuild does not emit.
 */
const tscDecorators: Plugin = {
  name: "tsc-decorators",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith(".ts") || id.includes("/node_modules/")) return;
    const out = ts.transpileModule(code, {
      fileName: id,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        sourceMap: true,
      },
    });
    return { code: out.outputText, map: out.sourceMapText };
  },
};

export default defineConfig({
  plugins: [tscDecorators],
  esbuild: false,
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    hookTimeout: 60_000,
  },
});
