/**
 * Static reader for neogma model definitions: walks the TypeScript / JavaScript syntax tree of the
 * model files (with the TypeScript compiler API, passed in by the caller) and collects the models
 * without running any of the code.
 *
 * Two shapes are read:
 * - neogma 2 decorator classes: `@Node({ label })` on a class, `@PrimaryKey(schema)`,
 *   `@Property(schema)` and `@Relationship({ name, direction, model, properties })` on its fields,
 *   from `neogma` or `neogma/legacy`;
 * - `ModelFactory({ label, schema, primaryKeyField, relationships, statics, methods }, neogma)`
 *   (neogma 1, still accepted by neogma 2), with `addRelationships`, hooks, statics and methods
 *   assigned to the model afterwards.
 *
 * Values are evaluated statically: literals, arrays, objects (with spreads), `as const`, calls
 * (`Type.String({ … })`), and references to top-level `const`s and static class fields, in the same
 * file or another one of the input. Anything else is kept as source text.
 *
 * @packageDocumentation
 */

import type TS from "typescript";

/** The TypeScript compiler API (`import ts from "typescript"`), used to parse the files. */
export type TypeScriptApi = typeof TS;

/** One model file: its name (for messages) and its text. */
export type NeogmaSource = { readonly name: string; readonly body: string };

/** Error for a model file that does not parse, or an input without any model. */
export class NeogmaImportError extends Error {
  override readonly name = "NeogmaImportError";
}

/** A statically evaluated expression. */
export type NeogmaValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" }
  | { readonly kind: "regex"; readonly pattern: string; readonly flags: string }
  | { readonly kind: "array"; readonly items: readonly NeogmaValue[] }
  | {
      readonly kind: "object";
      readonly entries: ReadonlyMap<string, NeogmaValue>;
    }
  | {
      readonly kind: "call";
      /** The function name: `String` for `Type.String(…)`. */
      readonly callee: string;
      /** The object it is called on: `Type` for `Type.String(…)` (absent for a plain call). */
      readonly object?: string;
      readonly args: readonly NeogmaValue[];
    }
  /** A function; `returns` is its returned expression when it has a single one. */
  | { readonly kind: "function"; readonly returns?: NeogmaValue }
  /** An identifier (or `a.b`) that is not a known constant: a class or model name. */
  | { readonly kind: "ref"; readonly name: string }
  /** Anything else, as source text. */
  | { readonly kind: "other"; readonly text: string };

/** The TypeScript type annotation of a class field, when it is a simple one. */
export type NeogmaAnnotation = {
  /** `string`, `number`, `boolean`, `bigint`, or another type's text. */
  readonly type: string;
  readonly list: boolean;
  readonly optional: boolean;
};

/** A stored property of a model. */
export type NeogmaProperty = {
  readonly kind: "property";
  readonly name: string;
  /** Its validation schema (TypeBox or revalidator), absent for a bare `@Property()`. */
  readonly schema?: NeogmaValue;
  /** The field's type annotation (decorator classes only). */
  readonly annotation?: NeogmaAnnotation;
  readonly line: number;
};

/** A relationship of a model (an alias in neogma). */
export type NeogmaRelationship = {
  readonly kind: "relationship";
  readonly alias: string;
  /** Neo4j relationship type (`name` in neogma). */
  readonly type?: NeogmaValue;
  readonly direction?: NeogmaValue;
  /** `"self"`, or the name of the class or model variable it points to. */
  readonly target?: string;
  /** Source text of `model` when it is not a class, a model or `'self'`. */
  readonly targetText?: string;
  readonly properties?: NeogmaValue;
  readonly line: number;
};

export type NeogmaMember = NeogmaProperty | NeogmaRelationship;

/** One model, from a decorator class or a `ModelFactory` call. */
export type NeogmaModel = {
  readonly style: "decorators" | "ModelFactory";
  /** Class name, or the variable holding the `ModelFactory` result (the label without one). */
  readonly id: string;
  readonly file: string;
  readonly line: number;
  /** The label(s); absent when `label` is not a static string. */
  readonly labels?: readonly string[];
  readonly labelText?: string;
  primaryKey?: string;
  /** Properties and relationships in declaration order. */
  readonly members: NeogmaMember[];
  /** Static methods (`statics`), instance methods (`methods`) and hooks, by name. */
  readonly statics: string[];
  readonly methods: string[];
  readonly hooks: string[];
};

/** Everything read from the input files. */
export type NeogmaSchema = {
  readonly models: readonly NeogmaModel[];
};

const HOOKS = new Set(["beforeCreate", "beforeDelete", "beforeSave"]);

type Decl = { readonly file: string; readonly node: TS.Expression };

/**
 * Read the neogma models of the given files.
 *
 * @param ts - The TypeScript compiler API.
 * @throws {NeogmaImportError} When a file has a syntax error.
 */
export function parseNeogmaSources(
  ts: TypeScriptApi,
  sources: readonly NeogmaSource[],
): NeogmaSchema {
  const files = sources.map((s) => {
    const sf = ts.createSourceFile(s.name, s.body, ts.ScriptTarget.Latest, true, scriptKind(ts, s));
    // `parseDiagnostics` holds the syntax errors of a source file (not in the public typings).
    const diags = (sf as unknown as { parseDiagnostics?: readonly TS.Diagnostic[] })
      .parseDiagnostics;
    const first = diags?.[0];
    if (first) {
      const { line, character } = sf.getLineAndCharacterOfPosition(first.start ?? 0);
      throw new NeogmaImportError(
        `${s.name}:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(first.messageText, "\n")}`,
      );
    }
    return sf;
  });

  // Top-level constants (`const x = …`) and classes, by name and by file.
  const consts = new Map<string, Decl[]>();
  const classes = new Map<string, { file: string; node: TS.ClassDeclaration }[]>();
  for (const sf of files) {
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer) {
            push(consts, d.name.text, { file: sf.fileName, node: d.initializer });
          }
        }
      } else if (ts.isClassDeclaration(st) && st.name) {
        push(classes, st.name.text, { file: sf.fileName, node: st });
      }
    }
  }
  const pick = <T extends { file: string }>(list: readonly T[] | undefined, file: string) =>
    list?.find((d) => d.file === file) ?? list?.[0];

  const evaluating = new Set<TS.Node>();
  /** Evaluate an expression statically. */
  const evaluate = (e: TS.Expression, file: string): NeogmaValue => {
    e = unwrap(ts, e);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      return { kind: "string", value: e.text };
    }
    if (ts.isNumericLiteral(e)) return { kind: "number", value: Number(e.text) };
    if (
      ts.isPrefixUnaryExpression(e) &&
      e.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(e.operand)
    ) {
      return { kind: "number", value: -Number(e.operand.text) };
    }
    if (e.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
    if (e.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
    if (e.kind === ts.SyntaxKind.NullKeyword) return { kind: "null" };
    if (ts.isRegularExpressionLiteral(e)) {
      const m = /^\/(.*)\/([a-z]*)$/s.exec(e.text);
      return m ? { kind: "regex", pattern: m[1]!, flags: m[2]! } : other(e);
    }
    if (ts.isArrayLiteralExpression(e)) {
      const items: NeogmaValue[] = [];
      for (const el of e.elements) {
        if (ts.isSpreadElement(el)) {
          const v = evaluate(el.expression, file);
          if (v.kind === "array") items.push(...v.items);
          else items.push(other(el));
        } else {
          items.push(evaluate(el, file));
        }
      }
      return { kind: "array", items };
    }
    if (ts.isObjectLiteralExpression(e)) {
      const entries = new Map<string, NeogmaValue>();
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) {
          const v = evaluate(p.expression, file);
          if (v.kind === "object") for (const [k, x] of v.entries) entries.set(k, x);
          continue;
        }
        const key = p.name ? propertyName(ts, p.name) : undefined;
        if (key === undefined) continue;
        if (ts.isPropertyAssignment(p)) entries.set(key, evaluate(p.initializer, file));
        else if (ts.isShorthandPropertyAssignment(p)) entries.set(key, evaluate(p.name, file));
        else entries.set(key, { kind: "function" }); // methods and accessors
      }
      return { kind: "object", entries };
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      const ret = returnedExpression(ts, e);
      return ret ? { kind: "function", returns: evaluate(ret, file) } : { kind: "function" };
    }
    if (ts.isCallExpression(e)) {
      const callee = unwrap(ts, e.expression);
      const args = e.arguments.map((a) => evaluate(a, file));
      let name: string | undefined;
      let object: string | undefined;
      if (ts.isIdentifier(callee)) name = callee.text;
      else if (ts.isPropertyAccessExpression(callee)) {
        name = callee.name.text;
        object = callee.expression.getText();
      }
      if (name === undefined) return other(e);
      // `defineRelationshipProperties(config)` returns its argument.
      if (name === "defineRelationshipProperties" && args[0]) return args[0];
      return { kind: "call", callee: name, ...(object !== undefined ? { object } : {}), args };
    }
    if (ts.isIdentifier(e)) {
      if (e.text === "undefined") return { kind: "other", text: "undefined" };
      const decl = pick(consts.get(e.text), file);
      if (decl && !evaluating.has(decl.node)) {
        evaluating.add(decl.node);
        try {
          const v = evaluate(decl.node, decl.file);
          // A model variable (`const Users = ModelFactory(…)`) is a reference to that model.
          if (v.kind === "call" && (v.callee === "ModelFactory" || v.callee === "model")) {
            return { kind: "ref", name: e.text };
          }
          return v;
        } finally {
          evaluating.delete(decl.node);
        }
      }
      return { kind: "ref", name: e.text };
    }
    if (ts.isPropertyAccessExpression(e)) {
      // `UserNode.orderRelProps`: a static field of a class, or an entry of a constant object.
      if (ts.isIdentifier(e.expression)) {
        const cls = pick(classes.get(e.expression.text), file);
        const member = cls?.node.members.find(
          (m): m is TS.PropertyDeclaration =>
            ts.isPropertyDeclaration(m) &&
            isStatic(ts, m) &&
            !!m.initializer &&
            propertyName(ts, m.name) === e.name.text,
        );
        if (cls && member?.initializer && !evaluating.has(member)) {
          evaluating.add(member);
          try {
            return evaluate(member.initializer, cls.file);
          } finally {
            evaluating.delete(member);
          }
        }
      }
      const base = evaluate(e.expression, file);
      if (base.kind === "object") return base.entries.get(e.name.text) ?? other(e);
      return { kind: "ref", name: e.getText() };
    }
    return other(e);
  };

  /** The class or model a relationship's `model` points to. */
  const target = (
    v: TS.Expression | undefined,
  ): { target?: string; targetText?: string } | undefined => {
    if (!v) return undefined;
    let e = unwrap(ts, v);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      const ret = returnedExpression(ts, e);
      if (!ret) return { targetText: e.getText() };
      e = unwrap(ts, ret);
    }
    if (ts.isStringLiteral(e) && e.text === "self") return { target: "self" };
    if (ts.isIdentifier(e)) return { target: e.text };
    return { targetText: e.getText() };
  };

  const models: NeogmaModel[] = [];
  /** Model variables: `const Users = ModelFactory(…)` or `neogma.model(UserNode)`. */
  const modelVars = new Map<string, NeogmaModel>();
  const classModels = new Map<string, NeogmaModel>();
  const later: { file: string; node: TS.Node }[] = [];

  const relationshipsOf = (obj: TS.ObjectLiteralExpression, file: string): NeogmaRelationship[] => {
    const out: NeogmaRelationship[] = [];
    for (const p of obj.properties) {
      const alias = p.name ? propertyName(ts, p.name) : undefined;
      if (alias === undefined || !ts.isPropertyAssignment(p)) continue;
      const cfg = unwrap(ts, p.initializer);
      out.push(
        ts.isObjectLiteralExpression(cfg)
          ? relationship(alias, cfg, file, lineOf(p))
          : { kind: "relationship", alias, targetText: cfg.getText(), line: lineOf(p) },
      );
    }
    return out;
  };

  const relationship = (
    alias: string,
    cfg: TS.ObjectLiteralExpression,
    file: string,
    line: number,
  ): NeogmaRelationship => {
    const get = (k: string) => {
      const p = cfg.properties.find(
        (x): x is TS.PropertyAssignment =>
          ts.isPropertyAssignment(x) && propertyName(ts, x.name) === k,
      );
      return p?.initializer;
    };
    const t = target(get("model"));
    const type = get("name");
    const direction = get("direction");
    const properties = get("properties");
    return {
      kind: "relationship",
      alias,
      ...(type ? { type: evaluate(type, file) } : {}),
      ...(direction ? { direction: evaluate(direction, file) } : {}),
      ...t,
      ...(properties ? { properties: evaluate(properties, file) } : {}),
      line,
    };
  };

  const lineOf = (n: TS.Node) => {
    const sf = n.getSourceFile();
    return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  };

  const labelsOf = (v: NeogmaValue | undefined): string[] | undefined => {
    if (v?.kind === "string") return [v.value];
    if (v?.kind === "array" && v.items.length > 0 && v.items.every((i) => i.kind === "string")) {
      return v.items.map((i) => (i as { value: string }).value);
    }
    return undefined;
  };

  const readClass = (cls: TS.ClassDeclaration, file: string) => {
    const nodeDec = decoratorsOf(ts, cls).find((d) => d.name === "Node");
    if (!nodeDec || !cls.name) return;
    const options = nodeDec.args[0] ? evaluate(nodeDec.args[0], file) : undefined;
    const labelValue = options?.kind === "object" ? options.entries.get("label") : undefined;
    const labels = labelValue ? labelsOf(labelValue) : [cls.name.text];
    const model: NeogmaModel = {
      style: "decorators",
      id: cls.name.text,
      file,
      line: lineOf(cls),
      ...(labels ? { labels } : { labelText: nodeDec.args[0]!.getText() }),
      members: [],
      statics: [],
      methods: [],
      hooks: [],
    };
    for (const m of cls.members) {
      const name = m.name ? propertyName(ts, m.name) : undefined;
      if (name === undefined) continue;
      const decs = decoratorsOf(ts, m);
      const rel = decs.find((d) => d.name === "Relationship");
      const prop = decs.filter((d) => d.name === "Property" || d.name === "PrimaryKey");
      if (ts.isPropertyDeclaration(m) && rel) {
        const cfg = rel.args[0] ? unwrap(ts, rel.args[0]) : undefined;
        model.members.push(
          cfg && ts.isObjectLiteralExpression(cfg)
            ? relationship(name, cfg, file, lineOf(m))
            : {
                kind: "relationship",
                alias: name,
                targetText: cfg?.getText() ?? "",
                line: lineOf(m),
              },
        );
      } else if (ts.isPropertyDeclaration(m) && prop.length > 0) {
        if (prop.some((d) => d.name === "PrimaryKey")) model.primaryKey = name;
        const schemaArg = prop.find((d) => d.args[0])?.args[0];
        const annotation = annotationOf(ts, m);
        model.members.push({
          kind: "property",
          name,
          ...(schemaArg ? { schema: evaluate(schemaArg, file) } : {}),
          ...(annotation ? { annotation } : {}),
          line: lineOf(m),
        });
      } else if (
        ts.isMethodDeclaration(m) ||
        ts.isGetAccessorDeclaration(m) ||
        ts.isSetAccessorDeclaration(m) ||
        (ts.isPropertyDeclaration(m) &&
          m.initializer &&
          (ts.isArrowFunction(unwrap(ts, m.initializer)) ||
            ts.isFunctionExpression(unwrap(ts, m.initializer))))
      ) {
        const list = isStatic(ts, m)
          ? HOOKS.has(name)
            ? model.hooks
            : model.statics
          : model.methods;
        if (!list.includes(name)) list.push(name);
      }
    }
    models.push(model);
    classModels.set(cls.name.text, model);
  };

  const readFactory = (call: TS.CallExpression, file: string, variable: string | undefined) => {
    const arg = call.arguments[0] ? unwrap(ts, call.arguments[0]) : undefined;
    if (!arg || !ts.isObjectLiteralExpression(arg)) return;
    const get = (k: string) =>
      arg.properties.find(
        (x): x is TS.PropertyAssignment =>
          ts.isPropertyAssignment(x) && propertyName(ts, x.name) === k,
      )?.initializer;
    const labelNode = get("label");
    const labels = labelNode ? labelsOf(evaluate(labelNode, file)) : undefined;
    const pk = get("primaryKeyField");
    const pkValue = pk ? evaluate(pk, file) : undefined;
    const model: NeogmaModel = {
      style: "ModelFactory",
      id: variable ?? labels?.[0] ?? `ModelFactory@${lineOf(call)}`,
      file,
      line: lineOf(call),
      ...(labels ? { labels } : { labelText: labelNode?.getText() ?? "" }),
      ...(pkValue?.kind === "string" ? { primaryKey: pkValue.value } : {}),
      members: [],
      statics: [],
      methods: [],
      hooks: [],
    };
    const schema = get("schema");
    const schemaObj = schema ? unwrap(ts, schema) : undefined;
    if (schemaObj && ts.isObjectLiteralExpression(schemaObj)) {
      for (const p of schemaObj.properties) {
        const name = p.name ? propertyName(ts, p.name) : undefined;
        if (name === undefined) continue;
        model.members.push({
          kind: "property",
          name,
          ...(ts.isPropertyAssignment(p) ? { schema: evaluate(p.initializer, file) } : {}),
          ...(ts.isShorthandPropertyAssignment(p) ? { schema: evaluate(p.name, file) } : {}),
          line: lineOf(p),
        });
      }
    } else if (schema) {
      const v = evaluate(schema, file);
      if (v.kind === "object") {
        for (const [name, s] of v.entries) {
          model.members.push({ kind: "property", name, schema: s, line: lineOf(schema) });
        }
      }
    }
    const rels = get("relationships");
    const relsObj = rels ? unwrap(ts, rels) : undefined;
    if (relsObj && ts.isObjectLiteralExpression(relsObj)) {
      model.members.push(...relationshipsOf(relsObj, file));
    }
    for (const [key, list] of [
      ["statics", model.statics],
      ["methods", model.methods],
    ] as const) {
      const v = get(key);
      const obj = v ? unwrap(ts, v) : undefined;
      if (!obj || !ts.isObjectLiteralExpression(obj)) continue;
      for (const p of obj.properties) {
        const name = p.name ? propertyName(ts, p.name) : undefined;
        if (name === undefined) continue;
        const into = key === "statics" && HOOKS.has(name) ? model.hooks : list;
        if (!into.includes(name)) into.push(name);
      }
    }
    models.push(model);
    if (variable) modelVars.set(variable, model);
  };

  for (const sf of files) {
    const visit = (n: TS.Node): void => {
      if (ts.isClassDeclaration(n)) {
        readClass(n, sf.fileName);
      } else if (ts.isCallExpression(n) && calleeName(ts, n) === "ModelFactory") {
        readFactory(n, sf.fileName, assignedName(ts, n));
        return;
      } else if (
        ts.isCallExpression(n) &&
        (calleeName(ts, n) === "model" || calleeName(ts, n) === "toModel") &&
        n.arguments[0] &&
        ts.isIdentifier(unwrap(ts, n.arguments[0]))
      ) {
        // `const Users = neogma.model(UserNode)` / `toModel(UserNode, neogma)`.
        const variable = assignedName(ts, n);
        if (variable) {
          later.push({ file: sf.fileName, node: n });
        }
      } else if (ts.isExpressionStatement(n)) {
        later.push({ file: sf.fileName, node: n });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // Model variables of decorator classes.
  for (const { node } of later) {
    if (!ts.isCallExpression(node)) continue;
    const variable = assignedName(ts, node)!;
    const cls = classModels.get((unwrap(ts, node.arguments[0]!) as TS.Identifier).text);
    if (cls) modelVars.set(variable, cls);
  }
  const modelOf = (e: TS.Expression): NeogmaModel | undefined => {
    e = unwrap(ts, e);
    return ts.isIdentifier(e) ? (modelVars.get(e.text) ?? classModels.get(e.text)) : undefined;
  };

  // Assignments and calls after the definition: `Users.beforeCreate = …`, `Users.foo = …`,
  // `Users.prototype.bar = …`, `Users.addRelationships({ … })`.
  for (const { file, node } of later) {
    if (!ts.isExpressionStatement(node)) continue;
    const e = unwrap(ts, node.expression);
    if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(e.left)
    ) {
      const name = e.left.name.text;
      const owner = e.left.expression;
      if (ts.isPropertyAccessExpression(owner) && owner.name.text === "prototype") {
        const model = modelOf(owner.expression);
        if (model && !model.methods.includes(name)) model.methods.push(name);
        continue;
      }
      const model = modelOf(owner);
      if (!model) continue;
      const list = HOOKS.has(name) ? model.hooks : model.statics;
      if (!list.includes(name)) list.push(name);
    } else if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === "addRelationships"
    ) {
      const model = modelOf(e.expression.expression);
      const arg = e.arguments[0] ? unwrap(ts, e.arguments[0]) : undefined;
      if (model && arg && ts.isObjectLiteralExpression(arg)) {
        model.members.push(...relationshipsOf(arg, file));
      }
    }
  }

  return { models };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function other(e: TS.Node): NeogmaValue {
  return { kind: "other", text: e.getText() };
}

function scriptKind(ts: TypeScriptApi, s: NeogmaSource): TS.ScriptKind {
  const ext = /\.[^./\\]+$/.exec(s.name)?.[0].toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Strip parentheses, `as`, `satisfies`, `!` and type assertions. */
function unwrap(ts: TypeScriptApi, e: TS.Expression): TS.Expression {
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e)
    ) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

function propertyName(ts: TypeScriptApi, n: TS.PropertyName): string | undefined {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  if (ts.isPrivateIdentifier(n)) return undefined;
  if (ts.isComputedPropertyName(n) && ts.isStringLiteral(n.expression)) return n.expression.text;
  return undefined;
}

function isStatic(ts: TypeScriptApi, m: TS.Node): boolean {
  return (
    ts.canHaveModifiers(m) &&
    (ts.getModifiers(m) ?? []).some((x) => x.kind === ts.SyntaxKind.StaticKeyword)
  );
}

/** The expression a function returns: its expression body, or its only `return`. */
function returnedExpression(
  ts: TypeScriptApi,
  f: TS.ArrowFunction | TS.FunctionExpression,
): TS.Expression | undefined {
  if (!ts.isBlock(f.body)) return f.body;
  const returns = f.body.statements.filter(ts.isReturnStatement);
  return returns.length === 1 ? returns[0]!.expression : undefined;
}

function calleeName(ts: TypeScriptApi, call: TS.CallExpression): string | undefined {
  const c = unwrap(ts, call.expression);
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return undefined;
}

/** `x` in `const x = call(…)`, `x = call(…)`, `exports.x = call(…)`. */
function assignedName(ts: TypeScriptApi, call: TS.Node): string | undefined {
  let n: TS.Node = call;
  while (
    n.parent &&
    (ts.isParenthesizedExpression(n.parent) ||
      ts.isAsExpression(n.parent) ||
      ts.isSatisfiesExpression(n.parent))
  ) {
    n = n.parent;
  }
  const p = n.parent;
  if (!p) return undefined;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (ts.isIdentifier(p.left)) return p.left.text;
    if (ts.isPropertyAccessExpression(p.left)) return p.left.name.text;
  }
  return undefined;
}

/** Decorators of a node, as `{ name, args }` for `@Name(args)` / `@Name`. */
function decoratorsOf(
  ts: TypeScriptApi,
  n: TS.Node,
): { name: string; args: readonly TS.Expression[] }[] {
  if (!ts.canHaveDecorators(n)) return [];
  return (ts.getDecorators(n) ?? []).flatMap((d) => {
    const e = d.expression;
    const callee = ts.isCallExpression(e) ? e.expression : e;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    return name ? [{ name, args: ts.isCallExpression(e) ? e.arguments : [] }] : [];
  });
}

/** A field's type annotation, when it names a simple type. */
function annotationOf(ts: TypeScriptApi, m: TS.PropertyDeclaration): NeogmaAnnotation | undefined {
  let optional = !!m.questionToken;
  let t = m.type;
  if (!t) return undefined;
  if (ts.isUnionTypeNode(t)) {
    const rest = t.types.filter((x) => {
      const empty =
        x.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword);
      if (empty) optional = true;
      return !empty;
    });
    if (rest.length !== 1) return { type: t.getText(), list: false, optional };
    t = rest[0]!;
  }
  let list = false;
  if (ts.isArrayTypeNode(t)) {
    list = true;
    t = t.elementType;
  } else if (
    ts.isTypeReferenceNode(t) &&
    ts.isIdentifier(t.typeName) &&
    (t.typeName.text === "Array" || t.typeName.text === "ReadonlyArray") &&
    t.typeArguments?.length === 1
  ) {
    list = true;
    t = t.typeArguments[0]!;
  } else if (ts.isTypeOperatorNode(t) && ts.isArrayTypeNode(t.type)) {
    list = true;
    t = t.type.elementType;
  }
  const keyword: Partial<Record<TS.SyntaxKind, string>> = {
    [ts.SyntaxKind.StringKeyword]: "string",
    [ts.SyntaxKind.NumberKeyword]: "number",
    [ts.SyntaxKind.BooleanKeyword]: "boolean",
    [ts.SyntaxKind.BigIntKeyword]: "bigint",
  };
  return { type: keyword[t.kind] ?? t.getText(), list, optional };
}
