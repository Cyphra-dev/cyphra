/**
 * What the v7 → native migration tools know of both APIs: the v7 model and schema (from the type
 * definitions) and the native schema (from `schema.cyphra` and the config), with the names that
 * link them (a v7 type to its Cyphra model, a v7 field to the Cyphra field it became).
 *
 * @packageDocumentation
 */

import { buildSchema, type GraphQLSchema } from "graphql";
import type {
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedScalarField,
  SchemaModel,
} from "@cyphra/schema";
import { resolveSchema } from "@cyphra/schema";
import { convertGraphQLTypeDefs, type GraphQLImportOptions } from "../import/index.js";
import { buildV7Schema } from "../v7/sdl.js";
import {
  readTypeDefs,
  type Attribute,
  type NodeType,
  type Relationship,
  type V7Model,
} from "../v7/model.js";
import { printSchema } from "../native/index.js";
import {
  READ_OPERATIONS,
  WRITE_OPERATIONS,
  type GraphQLConfig,
  type RootOperation,
} from "../native/config.js";

/** Options of {@link createMigrationContext}. */
export type MigrationContextOptions = {
  /** The v7 type definitions (several files are joined, like one `makeSchema` call). */
  readonly typeDefs: string | readonly { readonly name: string; readonly body: string }[];
  /**
   * The schema model of the native API (`schema.cyphra`). Default: the one `cyphra import
   * graphql` converts from `typeDefs`.
   */
  readonly schema?: SchemaModel;
  /** Options of the conversion when `schema` is not given (as `cyphra import graphql` takes them). */
  readonly importOptions?: GraphQLImportOptions;
  /**
   * The native API's config (`defineGraphQL`). Default: every operation of every model on
   * (reads and writes), so that every v7 operation has a native counterpart to translate to.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any type map and context
  readonly config?: GraphQLConfig<any, any>;
};

/** The default config of the migration tools: every operation on. */
const ALL_OPERATIONS: GraphQLConfig = {
  defaults: { operations: { read: true, create: true, update: true, delete: true } },
};

/** Both APIs, for the codemod, the dual-run check and the rules drafter. */
export class MigrationContext {
  readonly v7: V7Model;
  readonly v7Schema: GraphQLSchema;
  readonly model: SchemaModel;
  readonly config: GraphQLConfig;
  /** The native API's schema (built from its printed SDL: types only, no resolvers). */
  readonly nativeSchema: GraphQLSchema;
  /** Whether `config` was given (otherwise every operation is assumed on). */
  readonly configGiven: boolean;
  private readonly nodes: Map<string, ResolvedNodeModel>;

  constructor(options: MigrationContextOptions) {
    const sources =
      typeof options.typeDefs === "string"
        ? [{ name: "typeDefs.graphql", body: options.typeDefs }]
        : options.typeDefs;
    this.v7 = readTypeDefs(sources.map((s) => s.body).join("\n"));
    this.v7Schema = buildV7Schema(this.v7);
    this.model =
      options.schema ??
      resolveSchema(convertGraphQLTypeDefs([...sources], options.importOptions).document);
    this.configGiven = options.config !== undefined;
    this.config = (options.config as GraphQLConfig | undefined) ?? ALL_OPERATIONS;
    this.nativeSchema = buildSchema(printSchema(this.model, this.config));
    this.nodes = new Map(this.model.nodes.map((n) => [n.name, n]));
  }

  /** A v7 `@node` type, interface or union by name (`undefined` for other types). */
  v7Node(name: string): NodeType | undefined {
    if (this.v7.interfaces.has(name)) return this.v7.interfaces.get(name);
    return this.v7.nodes.find((n) => n.name === name);
  }

  /**
   * The Cyphra model a v7 type became: the model named after its main label (`cyphra import
   * graphql` names models after labels), else the one with its name.
   */
  nativeModel(v7Type: string): ResolvedNodeModel | undefined {
    const n = this.v7.nodes.find((x) => x.name === v7Type);
    const label = n?.labels[0];
    return (label ? this.nodes.get(label) : undefined) ?? this.nodes.get(v7Type);
  }

  /** The Cyphra scalar field a v7 attribute became (`@alias` renames it to the property). */
  nativeScalar(v7Type: string, attr: Attribute): ResolvedScalarField | undefined {
    const m = this.nativeModel(v7Type);
    const scalars = (m?.fields ?? []).filter((f): f is ResolvedScalarField => f.kind === "scalar");
    return (
      scalars.find((f) => f.name === attr.property) ?? scalars.find((f) => f.name === attr.name)
    );
  }

  /** The Cyphra relation a v7 relationship field became (same name, else same type and direction). */
  nativeRelation(v7Type: string, rel: Relationship): ResolvedRelationField | undefined {
    const m = this.nativeModel(v7Type);
    const rels = (m?.fields ?? []).filter((f): f is ResolvedRelationField => f.kind === "relation");
    return (
      rels.find((f) => f.name === rel.name) ??
      rels.find((f) => f.relType === rel.type && f.direction === rel.direction)
    );
  }

  /** The name of an edge property in the native `_edge` type. */
  nativeEdgeProperty(propertiesType: string, name: string): string {
    const props = this.v7.properties.get(propertiesType);
    const attr = props?.attributes.find((a) => a.name === name);
    return attr?.property ?? name;
  }

  /** The native root field of `operation` on `model` (`naming` overrides applied). */
  rootField(model: string, operation: RootOperation): string {
    const override = (this.config.naming as Record<string, Record<string, string>> | undefined)?.[
      model
    ]?.[operation];
    return override ?? `${model.charAt(0).toLowerCase()}${model.slice(1)}${capitalize(operation)}`;
  }

  /**
   * When `name` is a root field the native API generates (`thingCount`), the operation it is
   * (`Thing count`); otherwise `undefined`.
   */
  generatedRoot(name: string): string | undefined {
    for (const m of this.model.nodes) {
      for (const op of [
        ...READ_OPERATIONS,
        ...WRITE_OPERATIONS,
        "findSimilar",
        "traverse",
        "traversePaths",
        "shortestPath",
      ] as const) {
        if (this.rootField(m.name, op as RootOperation) === name) return `${m.name} ${op}`;
      }
    }
    return undefined;
  }

  /** Whether the native API serves the root field (`Query` or `Mutation`). */
  hasRoot(kind: "query" | "mutation", name: string): boolean {
    const type =
      kind === "query" ? this.nativeSchema.getQueryType() : this.nativeSchema.getMutationType();
    return Boolean(type?.getFields()[name]);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Read both APIs. Throws when the type definitions are not served by `compat.v7`. */
export function createMigrationContext(options: MigrationContextOptions): MigrationContext {
  return new MigrationContext(options);
}
