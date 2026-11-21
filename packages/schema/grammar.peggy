start
  = _ decls:(_ @declaration)* _ {
      // A field typed with an enum name parses like a relation field (`role Role`); now that every
      // enum is known, turn those into scalar fields of that enum type.
      const enums = new Set(decls.filter((d) => d.kind === "Enum").map((d) => d.name));
      const resolveField = (f) =>
        f.kind === "Relational" && enums.has(f.target)
          ? {
              kind: "Scalar",
              name: f.name,
              type:
                f.cardinality === "many"
                  ? { name: "Enum", optional: false, list: true, enum: f.target }
                  : { name: "Enum", optional: f.optional, enum: f.target },
              decorators: f.decorators,
            }
          : f;
      const declarations = enums.size
        ? decls.map((d) => (d.kind === "Node" ? { ...d, fields: d.fields.map(resolveField) } : d))
        : decls;
      return { kind: "Document", declarations };
    }

declaration
  = nodeDeclaration
  / relationshipDeclaration
  / enumDeclaration

// `enum Role { ADMIN USER }`: values separated by whitespace (or commas).
enumDeclaration
  = "enum" __ name:identifier _ "{" _ values:(@identifier _ ("," _)?)* "}" {
      return { kind: "Enum", name, values };
    }

nodeDeclaration
  = "node" __ name:identifier _ "{" _ items:nodeItem* _ "}" {
      const fields = items.filter((i) => i.kind !== "ModelAttribute");
      const attributes = items.filter((i) => i.kind === "ModelAttribute");
      // `attributes` only when present, so schemas without `@@…` parse to the same AST as before.
      return attributes.length
        ? { kind: "Node", name, fields, attributes }
        : { kind: "Node", name, fields };
    }

nodeItem
  = modelAttribute
  / nodeField

relationshipDeclaration
  = "relationship" __ name:identifier _ "{" _ body:relationshipBody _ "}" {
      return {
        kind: "Relationship",
        name,
        relType: body.relType,
        from: body.from,
        to: body.to,
        fields: body.fields,
        ...(body.attributes ? { attributes: body.attributes } : {}),
      };
    }

relationshipBody
  = "type" __ rt:stringLiteral _ fromLine:fromLine _ toLine:toLine _ items:relationshipItem* {
      const fields = items.filter((i) => i.kind !== "ModelAttribute");
      const attributes = items.filter((i) => i.kind === "ModelAttribute");
      return attributes.length
        ? { relType: rt, from: fromLine, to: toLine, fields, attributes }
        : { relType: rt, from: fromLine, to: toLine, fields };
    }

relationshipItem
  = modelAttribute
  / scalarFieldInRel

// Model-level attribute: `@@name`, `@@name([a, b])`, `@@name([a, b], key: value, …)` or
// `@@name(key: value, …)`. The optional leading list names fields of the enclosing model.
modelAttribute
  = "@@" name:identifier "(" _ body:modelAttributeBody _ ")" _ {
      return body.fields
        ? { kind: "ModelAttribute", name, fields: body.fields, args: body.args }
        : { kind: "ModelAttribute", name, args: body.args };
    }
  / "@@" name:identifier _ {
      return { kind: "ModelAttribute", name, args: [] };
    }

modelAttributeBody
  = fields:fieldList args:(_ "," _ @decoratorArg)* {
      return { fields, args };
    }
  / args:decoratorArgs {
      return { fields: null, args };
    }

fieldList
  = "[" _ head:identifier tail:(_ "," _ @identifier)* _ "]" {
      return [head, ...tail];
    }
  / "[" _ "]" { return []; }

fromLine
  = "from" __ id:identifier _ { return id; }

toLine
  = "to" __ id:identifier _ { return id; }

scalarFieldInRel
  = name:identifier __ type:relFieldType decs:(_ @decorator)* _ {
      return { kind: "Scalar", name, type, decorators: decs };
    }

nodeField
  = scalarNodeField
  / relationalNodeField

// Also matches enum-typed fields (`role Role`, `roles Role[]`), which `start` turns into scalars.
// A relation field without `@relationship(...)` is rejected when the schema is resolved.
relationalNodeField
  = name:identifier __ target:relationalTarget decs:(_ @decorator)* _ {
      return {
        kind: "Relational",
        name,
        target: target.target,
        cardinality: target.cardinality,
        optional: target.optional,
        decorators: decs,
      };
    }

relationalTarget
  = t:identifier "[]" { return { target: t, cardinality: "many", optional: false }; }
  / t:identifier "?" { return { target: t, cardinality: "one", optional: true }; }
  / t:identifier { return { target: t, cardinality: "one", optional: false }; }

scalarNodeField
  = name:identifier __ type:fieldType decs:(_ @decorator)* _ {
      return { kind: "Scalar", name, type, decorators: decs };
    }

// Relationship properties are always scalars, so any other type name is an enum.
relFieldType
  = fieldType
  / n:identifier "[]" { return { name: "Enum", optional: false, list: true, enum: n }; }
  / n:identifier opt:"?"? { return { name: "Enum", optional: opt === "?", enum: n }; }

fieldType
  = "Vector" _ "(" _ d:$([0-9]+) _ ")" opt:"?"? {
      return { name: "Vector", optional: opt === "?", dimensions: Number(d) };
    }
  / n:scalarTypeName "[]" {
      return { name: n, optional: false, list: true };
    }
  / n:scalarTypeName opt:"?"? {
      return { name: n, optional: opt === "?" };
    }

scalarTypeName
  = n:("String" / "Int" / "Float" / "Boolean" / "DateTime" / "Date" / "BigInt" / "Json") ![a-zA-Z0-9_] { return n; }

decorator
  = "@" "default" "(" _ id:identifier "(" _ ")" _ ")" {
      return { name: "default", args: [{ key: "fn", value: { kind: "identifier", value: id } }] };
    }
  / "@" "default" "(" _ v:literalValue _ ")" {
      return { name: "default", args: [{ key: "value", value: v }] };
    }
  / "@" "default" "(" _ id:identifier _ ")" {
      return { name: "default", args: [{ key: "value", value: { kind: "identifier", value: id } }] };
    }
  / "@" name:identifier "(" _ args:decoratorArgs _ ")" {
      return { name, args };
    }
  / "@" name:identifier {
      return { name, args: [] };
    }

decoratorArgs
  = head:decoratorArg tail:(_ "," _ @decoratorArg)* {
      return [head, ...tail];
    }
  / "" { return []; }

decoratorArg
  = key:identifier _ ":" _ val:decoratorValue {
      return { key, value: val };
    }

decoratorValue
  = literalValue
  / id:identifier {
      return { kind: "identifier", value: id };
    }

literalValue
  = s:stringLiteral {
      return { kind: "string", value: s };
    }
  / b:("true" / "false") ![a-zA-Z0-9_] {
      return { kind: "boolean", value: b === "true" };
    }
  / n:$("-"? [0-9]+ ("." [0-9]+)?) {
      // Integers beyond 2^53 keep their exact digits in `raw` (for BigInt defaults).
      const value = Number(n);
      return Number.isSafeInteger(value) || n.includes(".")
        ? { kind: "number", value }
        : { kind: "number", value, raw: n };
    }

stringLiteral
  = '"' chars:char* '"' { return chars.join(""); }

char
  = [^"\\]
  / "\\" '"' { return '"'; }
  / "\\" "\\" { return "\\"; }
  / "\\" "n" { return "\n"; }

identifier "identifier"
  = first:[a-zA-Z_] rest:[a-zA-Z0-9_]* { return first + rest.join(""); }

_
  = (whitespace / lineComment)*

__
  = (whitespace / lineComment)+

whitespace
  = [ \t\n\r]+

lineComment
  = "//" (![\n\r] .)*
