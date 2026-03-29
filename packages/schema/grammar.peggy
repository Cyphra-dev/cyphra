start
  = _ decls:(_ @declaration)* _ {
      return { kind: "Document", declarations: decls };
    }

declaration
  = nodeDeclaration
  / relationshipDeclaration

nodeDeclaration
  = "node" __ name:identifier _ "{" _ fields:nodeField* _ "}" {
      return { kind: "Node", name, fields };
    }

relationshipDeclaration
  = "relationship" __ name:identifier _ "{" _ body:relationshipBody _ "}" {
      return {
        kind: "Relationship",
        name,
        relType: body.relType,
        from: body.from,
        to: body.to,
        fields: body.fields,
      };
    }

relationshipBody
  = "type" __ rt:stringLiteral _ fromLine:fromLine _ toLine:toLine _ fields:scalarFieldInRel* {
      return { relType: rt, from: fromLine, to: toLine, fields };
    }

fromLine
  = "from" __ id:identifier _ { return id; }

toLine
  = "to" __ id:identifier _ { return id; }

scalarFieldInRel
  = name:identifier __ type:fieldType decs:(_ @decorator)* _ {
      return { kind: "Scalar", name, type, decorators: decs };
    }

nodeField
  = scalarNodeField
  / relationalNodeField

relationalNodeField
  = name:identifier __ target:relationalTarget decs:(_ @decorator)+ _ {
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

fieldType
  = n:scalarTypeName opt:"?"? {
      return { name: n, optional: opt === "?" };
    }

scalarTypeName
  = "String" { return "String"; }
  / "Int" { return "Int"; }
  / "Float" { return "Float"; }
  / "Boolean" { return "Boolean"; }
  / "DateTime" { return "DateTime"; }

decorator
  = "@" "default" "(" _ id:identifier "(" _ ")" _ ")" {
      return { name: "default", args: [{ key: "fn", value: { kind: "identifier", value: id } }] };
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
  = s:stringLiteral {
      return { kind: "string", value: s };
    }
  / id:identifier {
      return { kind: "identifier", value: id };
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
