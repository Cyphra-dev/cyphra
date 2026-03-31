# @cyphra/schema

Parser, validator, and printer for **`.cyphra`** schema files (node models, relationships, decorators).

## Install

```bash
npm install @cyphra/schema
```

## Usage

```ts
import { parseSchema, validateSchema, printSchemaDocument } from "@cyphra/schema";

const doc = parseSchema(`
  node User {
    id String @id @default(cuid())
  }
`);
validateSchema(doc);
```

## Documentation

**[cyphra.dev — Schema](https://www.cyphra.dev/schema)**

## License

MIT
