// Cyphra schema grammar. `parse(source, { locations: true })` also records source ranges (`loc`,
// `nameLoc`, …) and the document's `//` comments, for editor tooling; without it the AST carries
// no positions, so existing consumers see the same shapes as before.
{
  const LOC = options.locations === true;
  const comments = new Map();
  function pos(p) {
    return { offset: p.offset, line: p.line, column: p.column };
  }
  function here() {
    const l = location();
    return { start: pos(l.start), end: pos(l.end) };
  }
  // Attach source ranges only when asked for.
  function withLoc(node, locs) {
    return LOC ? Object.assign(node, locs) : node;
  }
}

start
  = _ decls:(_ @declaration)* _ {
      // A field typed with an enum name parses like a relation field (`role Role`); now that every
      // enum is known, turn those into scalar fields of that enum type.
      const enums = new Set(decls.filter((d) => d.kind === "Enum").map((d) => d.name));
      const resolveField = (f) => {
        if (f.kind !== "Relational" || !enums.has(f.target)) return f;
        const { kind, name, target, cardinality, optional, decorators, ...locs } = f;
        return {
          kind: "Scalar",
          name,
          type:
            cardinality === "many"
              ? { name: "Enum", optional: false, list: true, enum: target }
              : { name: "Enum", optional, enum: target },
          decorators,
          ...locs,
        };
      };
      const declarations = enums.size
        ? decls.map((d) => (d.kind === "Node" ? { ...d, fields: d.fields.map(resolveField) } : d))
        : decls;
      const doc = { kind: "Document", declarations };
      return withLoc(doc, {
        comments: [...comments.values()].sort((a, b) => a.loc.start.offset - b.loc.start.offset),
      });
    }

declaration
  = nodeDeclaration
  / relationshipDeclaration
  / enumDeclaration

// An identifier with its source range.
nameTok
  = id:identifier { return { id, loc: here() }; }

// `enum Role { ADMIN USER }`: values separated by whitespace (or commas).
enumDeclaration
  = "enum" __ n:nameTok _ "{" _ values:(@nameTok _ ("," _)?)* "}" {
      return withLoc(
        { kind: "Enum", name: n.id, values: values.map((v) => v.id) },
        { loc: here(), nameLoc: n.loc, valueLocs: values.map((v) => v.loc) },
      );
    }

nodeDeclaration
  = "node" __ n:nameTok _ "{" _ items:nodeItem* _ "}" {
      const fields = items.filter((i) => i.kind !== "ModelAttribute");
      const attributes = items.filter((i) => i.kind === "ModelAttribute");
      // `attributes` only when present, so schemas without `@@…` parse to the same AST as before.
      const node = attributes.length
        ? { kind: "Node", name: n.id, fields, attributes }
        : { kind: "Node", name: n.id, fields };
      return withLoc(node, { loc: here(), nameLoc: n.loc });
    }

nodeItem
  = @modelAttribute _
  / @nodeField _

relationshipDeclaration
  = "relationship" __ n:nameTok _ "{" _ body:relationshipBody _ "}" {
      return withLoc(
        {
          kind: "Relationship",
          name: n.id,
          relType: body.relType,
          from: body.from.id,
          to: body.to.id,
          fields: body.fields,
          ...(body.attributes ? { attributes: body.attributes } : {}),
        },
        {
          loc: here(),
          nameLoc: n.loc,
          relTypeLoc: body.relTypeLoc,
          fromLoc: body.from.loc,
          toLoc: body.to.loc,
        },
      );
    }

relationshipBody
  = "type" __ rt:stringTok _ fromLine:fromLine _ toLine:toLine _ items:relationshipItem* {
      const fields = items.filter((i) => i.kind !== "ModelAttribute");
      const attributes = items.filter((i) => i.kind === "ModelAttribute");
      const body = { relType: rt.value, relTypeLoc: rt.loc, from: fromLine, to: toLine, fields };
      return attributes.length ? { ...body, attributes } : body;
    }

relationshipItem
  = @modelAttribute _
  / @scalarFieldInRel _

// Model-level attribute: `@@name`, `@@name([a, b])`, `@@name([a, b], key: value, …)` or
// `@@name(key: value, …)`. The optional leading list names fields of the enclosing model.
modelAttribute
  = "@@" name:identifier "(" _ body:modelAttributeBody _ ")" {
      const attr = body.fields
        ? { kind: "ModelAttribute", name, fields: body.fields.map((f) => f.id), args: body.args }
        : { kind: "ModelAttribute", name, args: body.args };
      return withLoc(attr, {
        loc: here(),
        ...(body.fields ? { fieldLocs: body.fields.map((f) => f.loc) } : {}),
      });
    }
  / "@@" name:identifier {
      return withLoc({ kind: "ModelAttribute", name, args: [] }, { loc: here() });
    }

modelAttributeBody
  = fields:fieldList args:(_ "," _ @decoratorArg)* {
      return { fields, args };
    }
  / args:decoratorArgs {
      return { fields: null, args };
    }

fieldList
  = "[" _ head:nameTok tail:(_ "," _ @nameTok)* _ "]" {
      return [head, ...tail];
    }
  / "[" _ "]" { return []; }

fromLine
  = "from" __ @nameTok

toLine
  = "to" __ @nameTok

scalarFieldInRel
  = n:nameTok __ type:typedRelFieldType decs:(_ @decorator)* {
      return withLoc(
        { kind: "Scalar", name: n.id, type: type.t, decorators: decs },
        { loc: here(), nameLoc: n.loc, typeLoc: type.loc },
      );
    }

// Type expressions with their source range (the name plus any `(N)`, `?` or `[]`).
typedFieldType
  = t:fieldType { return { t, loc: here() }; }

typedRelFieldType
  = t:relFieldType { return { t, loc: here() }; }

typedRelationalTarget
  = t:relationalTarget { return { t, loc: here() }; }

nodeField
  = scalarNodeField
  / relationalNodeField

// Also matches enum-typed fields (`role Role`, `roles Role[]`), which `start` turns into scalars.
// A relation field without `@relationship(...)` is rejected when the schema is resolved.
relationalNodeField
  = n:nameTok __ target:typedRelationalTarget decs:(_ @decorator)* {
      return withLoc(
        {
          kind: "Relational",
          name: n.id,
          target: target.t.target,
          cardinality: target.t.cardinality,
          optional: target.t.optional,
          decorators: decs,
        },
        { loc: here(), nameLoc: n.loc, typeLoc: target.loc },
      );
    }

relationalTarget
  = t:identifier "[]" { return { target: t, cardinality: "many", optional: false }; }
  / t:identifier "?" { return { target: t, cardinality: "one", optional: true }; }
  / t:identifier { return { target: t, cardinality: "one", optional: false }; }

scalarNodeField
  = n:nameTok __ type:typedFieldType decs:(_ @decorator)* {
      return withLoc(
        { kind: "Scalar", name: n.id, type: type.t, decorators: decs },
        { loc: here(), nameLoc: n.loc, typeLoc: type.loc },
      );
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

// Keep in sync with SCALAR_TYPE_NAMES (src/validate.ts); a test checks both lists match.
scalarTypeName
  = n:("String" / "Int" / "Float" / "Boolean" / "DateTime" / "Date" / "BigInt" / "Json") ![a-zA-Z0-9_] { return n; }

decorator
  = d:decoratorBody { return withLoc(d, { loc: here() }); }

decoratorBody
  = "@" "default" "(" _ v:fnCall _ ")" {
      return {
        name: "default",
        args: [
          withLoc(
            { key: "fn", value: { kind: "identifier", value: v.id } },
            { loc: v.loc, valueLoc: v.loc },
          ),
        ],
      };
    }
  / "@" "default" "(" _ v:literalTok _ ")" {
      return {
        name: "default",
        args: [withLoc({ key: "value", value: v.value }, { loc: v.loc, valueLoc: v.loc })],
      };
    }
  / "@" "default" "(" _ id:nameTok _ ")" {
      return {
        name: "default",
        args: [
          withLoc(
            { key: "value", value: { kind: "identifier", value: id.id } },
            { loc: id.loc, valueLoc: id.loc },
          ),
        ],
      };
    }
  / "@" name:identifier "(" _ args:decoratorArgs _ ")" {
      return { name, args };
    }
  / "@" name:identifier {
      return { name, args: [] };
    }

// `cuid()`: a default function call with its source range.
fnCall
  = id:identifier "(" _ ")" { return { id, loc: here() }; }

// Values with their source range.
literalTok
  = value:literalValue { return { value, loc: here() }; }

decoratorValueTok
  = value:decoratorValue { return { value, loc: here() }; }

decoratorArgs
  = head:decoratorArg tail:(_ "," _ @decoratorArg)* {
      return [head, ...tail];
    }
  / "" { return []; }

decoratorArg
  = key:nameTok _ ":" _ val:decoratorValueTok {
      return withLoc({ key: key.id, value: val.value }, { loc: here(), keyLoc: key.loc, valueLoc: val.loc });
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

stringTok
  = value:stringLiteral { return { value, loc: here() }; }

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
  = "//" (![\n\r] .)* {
      if (LOC) comments.set(offset(), { text: text(), loc: here() });
    }
