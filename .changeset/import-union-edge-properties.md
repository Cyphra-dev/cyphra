---
"@cyphra/graphql": patch
"@cyphra/cli": patch
---

`cyphra import graphql` converts `properties` on a `@relationship` to a union: they become a `relationship` model with the union at that end, shared by the members' inverse fields with the same properties type (no longer reported as not converted).
