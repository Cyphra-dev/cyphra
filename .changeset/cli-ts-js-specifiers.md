---
"@cyphra/cli": patch
---

`cyphra graphql …` loads TypeScript config and `--typedefs` modules that import siblings NodeNext style (`./rules.js` for `rules.ts`) without `NODE_OPTIONS="--import tsx"`: the CLI registers module hooks that resolve a missing `./x.js` from a `.ts` module to `./x.ts` and transpile `.ts` / `.mts` files with `typescript`. Nothing is written next to the modules any more.
