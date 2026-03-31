/**
 * @packageDocumentation
 * Project configuration: **`cyphra.config.ts`** / **`cyphra.json`** resolution (paths, provider).
 * Shared by **`@cyphra/cli`** and application helpers such as **`loadCyphraWorkspace`** in **`cyphra`**.
 */

export type { CyphraConfig } from "./loadConfig.js";
export { coerceMigrationsPath, loadConfig, loadConfigSync } from "./loadConfig.js";
export { resolveUnderRoot } from "./paths.js";
