# @cyphra/schema

Parser and AST types for the Cyphra `.cyphra` schema DSL.

## Usage

```ts
import { parseSchema } from "@cyphra/schema";

const doc = parseSchema(`
  node User {
    id String @id @default(cuid())
  }
`);
```

See the main Cyphra documentation site for the full grammar.
