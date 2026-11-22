---
"@cyphra/runtime": patch
---

FalkorDB: a string parameter containing a NUL character (`\u0000`), in a value, a nested list or map, a map key or a parameter name, now throws a clear `CyphraValidationError` before the query is sent, instead of FalkorDB's "Failed to parse query parameter". Shortest paths: the typed path is decoded with schema lookups built once per schema, the path no longer carries node labels (or, on FalkorDB, node properties) it does not need, and `DateTime` values are converted to `Date` from their fields instead of `neo4j-driver`'s text round trip (about 6x faster to decode a row of datetimes).
