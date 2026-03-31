/**
 * Chaîne de lecture fluent (`match` → `optionalOut` → `return` → `limit` → `first` / `many`).
 *
 * **Compilation uniquement** jusqu’à `CompiledCypher` ; l’exécution est injectée via {@link FluentReadClient.readQuery}.
 *
 * **Forme des lignes** : {@link FluentReadClient.readQuery} doit renvoyer des objets par alias `RETURN`.
 * Pour chaque alias qui désigne un nœud, la valeur peut être un objet avec une propriété **`properties`**
 * (comme les nœuds Neo4j dans `Record#toObject()` après passage par le driver), afin que {@link createFluentQueryRoot}
 * puisse aplatir en objet plain ; les autres shapes ne sont pas interprétés comme nœuds.
 */

import type { CompiledCypher } from "./cypher.js";
import { eq, prop, select, type WherePredicate } from "./builder.js";

/** Client minimal pour exécuter une requête compilée en lecture. */
export type FluentReadClient = {
  readQuery(compiled: CompiledCypher): Promise<Record<string, unknown>[]>;
};

/**
 * Variable de **`match((p) => …)`** — fixe l’alias (défaut **`p`**).
 */
export class MatchVar {
  readonly alias: string;
  labelName: string | null = null;
  readonly predicates: WherePredicate[] = [];

  constructor(alias: string) {
    this.alias = alias;
  }

  label(name: string): this {
    this.labelName = name;
    return this;
  }

  prop(name: string): {
    eq: (value: unknown) => MatchVar;
  } {
    return {
      eq: (value: unknown) => {
        this.predicates.push(eq(prop(this.alias, name), value));
        return this;
      },
    };
  }

  assertReady(): void {
    if (this.labelName === null) {
      throw new Error('Cyphra fluent query: call .label("NodeName") on the match variable');
    }
  }
}

function relationFieldName(targetLabel: string): string {
  return targetLabel.charAt(0).toLowerCase() + targetLabel.slice(1);
}

function nodeProperties(v: unknown): Record<string, unknown> | null {
  if (v == null) {
    return null;
  }
  if (typeof v === "object" && v !== null && "properties" in v) {
    const props = (v as { properties: unknown }).properties;
    if (props !== null && typeof props === "object" && !Array.isArray(props)) {
      return { ...(props as Record<string, unknown>) };
    }
  }
  return null;
}

function flattenRow(
  row: Record<string, unknown>,
  rootAlias: string,
  optional: { targetAlias: string; targetLabel: string } | undefined,
  returnAliases: readonly string[],
): Record<string, unknown> {
  const root = nodeProperties(row[rootAlias]);
  if (root === null) {
    return {};
  }
  if (!optional || !returnAliases.includes(optional.targetAlias)) {
    return root;
  }
  const relKey = relationFieldName(optional.targetLabel);
  const inc = nodeProperties(row[optional.targetAlias]);
  return {
    ...root,
    [relKey]: inc != null && Object.keys(inc).length > 0 ? inc : null,
  };
}

class AfterMatch {
  constructor(
    private readonly client: FluentReadClient,
    private readonly root: MatchVar,
    private optional:
      | { relType: string; targetLabel: string; relAlias: string; targetAlias: string }
      | undefined,
  ) {}

  /**
   * `OPTIONAL MATCH (root)-[r:TYPE]->(a:Target)` — alias rel **`r`**, cible **`a`** par défaut.
   */
  optionalOut(
    relType: string,
    targetLabel: string,
    opts?: { readonly relAlias?: string; readonly targetAlias?: string },
  ): this {
    this.optional = {
      relType,
      targetLabel,
      relAlias: opts?.relAlias ?? "r",
      targetAlias: opts?.targetAlias ?? "a",
    };
    return this;
  }

  /**
   * Colonnes `RETURN` : noms de variables Cypher (ex. **`"p"`**).
   * Si un **`optionalOut`** est défini et que tu ne passes que la racine (ex. **`"p"`**), la cible optionnelle est ajoutée automatiquement au `RETURN`.
   */
  return(...varNames: string[]): AfterReturn {
    if (varNames.length === 0) {
      throw new Error("Cyphra fluent query: pass at least one variable to .return(...)");
    }
    return new AfterReturn(this.client, this.root, this.optional, varNames);
  }
}

class AfterReturn {
  private limitN: number | undefined;

  constructor(
    private readonly client: FluentReadClient,
    private readonly root: MatchVar,
    private readonly optional:
      | { relType: string; targetLabel: string; relAlias: string; targetAlias: string }
      | undefined,
    private returnVars: readonly string[],
  ) {}

  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("Cyphra fluent query: limit must be a non-negative integer");
    }
    this.limitN = n;
    return this;
  }

  private resolvedReturnVars(): readonly string[] {
    return varsForReturn(this.root, this.optional, this.returnVars);
  }

  private compile(): CompiledCypher {
    this.root.assertReady();
    const label = this.root.labelName!;
    let q = select().match(`(${this.root.alias}:${label})`);
    if (this.optional !== undefined) {
      const o = this.optional;
      q = q.optionalMatch(
        `(${this.root.alias})-[${o.relAlias}:${o.relType}]->(${o.targetAlias}:${o.targetLabel})`,
      );
    }
    if (this.root.predicates.length > 0) {
      q = q.where(...this.root.predicates);
    }

    const vars = this.resolvedReturnVars();
    const rawFields: Record<string, string> = {};
    for (const v of vars) {
      rawFields[v] = v;
    }
    q = q.returnRawFields(rawFields);
    if (this.limitN !== undefined) {
      q = q.limit(this.limitN);
    }
    return q.toCypher();
  }

  /** Première ligne, ou `undefined`. */
  async first(): Promise<Record<string, unknown> | undefined> {
    const rows = await this.client.readQuery(this.compile());
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return flattenRow(row, this.root.alias, this.optional, this.resolvedReturnVars());
  }

  /** Toutes les lignes (même aplatissement que {@link first} par ligne). */
  async many(): Promise<Record<string, unknown>[]> {
    const rows = await this.client.readQuery(this.compile());
    const v = this.resolvedReturnVars();
    return rows.map((row) => flattenRow(row, this.root.alias, this.optional, v));
  }
}

function varsForReturn(
  root: MatchVar,
  optional: { targetAlias: string } | undefined,
  returnVars: readonly string[],
): readonly string[] {
  if (optional !== undefined && returnVars.length === 1 && returnVars[0] === root.alias) {
    return [root.alias, optional.targetAlias];
  }
  return returnVars;
}

export type FluentQueryRoot = {
  /**
   * @param fn - Configure la racine (alias **`p`**), ex. `p.label("Post").prop("slug").eq(slug)`.
   */
  match(fn: (p: MatchVar) => void): AfterMatch;
};

export function createFluentQueryRoot(client: FluentReadClient): FluentQueryRoot {
  return {
    match(fn: (p: MatchVar) => void): AfterMatch {
      const root = new MatchVar("p");
      fn(root);
      return new AfterMatch(client, root, undefined);
    },
  };
}
