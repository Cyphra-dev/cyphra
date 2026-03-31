import type { NodeDeclaration, ScalarNodeField, SchemaDocument } from "@cyphra/schema";

export function getNodeDeclaration(doc: SchemaDocument, name: string): NodeDeclaration | undefined {
  const d = doc.declarations.find((x) => x.kind === "Node" && x.name === name);
  return d?.kind === "Node" ? d : undefined;
}

export function getScalarFields(node: NodeDeclaration): ScalarNodeField[] {
  return node.fields.filter((f): f is ScalarNodeField => f.kind === "Scalar");
}

/** First `@id` scalar field, if any. */
export function getIdFieldName(node: NodeDeclaration): string | undefined {
  return getScalarFields(node).find((f) => f.decorators.some((d) => d.name === "id"))?.name;
}

export function getUniqueFieldNames(node: NodeDeclaration): string[] {
  return getScalarFields(node)
    .filter((f) => f.decorators.some((d) => d.name === "unique"))
    .map((f) => f.name);
}
