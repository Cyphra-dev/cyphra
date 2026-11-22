/**
 * Types shared by the studio server (Node) and the studio UI (browser). No imports: the UI
 * bundle compiles this file with the DOM lib only.
 */

/** The database's Cypher flavour (`dialect` in `cyphra.json`, else detected from the server). */
export type StudioDialect = "neo4j" | "memgraph";

/** A scalar field as the UI sees it (a subset of `ResolvedScalarField`). */
export type StudioScalarField = {
  readonly kind: "scalar";
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly list: boolean;
  readonly id: boolean;
  readonly unique: boolean;
  /** `true` when the schema fills the value on create (`@default(…)`). */
  readonly hasDefault: boolean;
  readonly enumValues?: readonly string[];
  readonly dimensions?: number;
  /** Validation rules, printed (`@length(min: 3)`). */
  readonly rules?: readonly string[];
  readonly inheritedFrom?: string;
  /**
   * Why the database cannot store values of this field (a `Time` on Memgraph): the UI disables
   * it, and the API refuses to write it.
   */
  readonly unsupported?: string;
};

export type StudioRelationField = {
  readonly kind: "relation";
  readonly name: string;
  readonly target: string;
  readonly relType: string;
  readonly direction: "OUT" | "IN";
  readonly many: boolean;
  readonly optional: boolean;
  readonly edge?: string;
  readonly onDelete: "Cascade" | "Restrict" | "SetNull";
};

export type StudioField = StudioScalarField | StudioRelationField;

/** How a record of a model is addressed in `where` (`findUnique`, `update`, `delete`). */
export type StudioKey =
  | { readonly kind: "field"; readonly field: string }
  | { readonly kind: "compound"; readonly key: string; readonly fields: readonly string[] };

export type StudioNodeModel = {
  readonly name: string;
  readonly label: string;
  readonly abstract: boolean;
  readonly implementations?: readonly string[];
  readonly interfaces?: readonly string[];
  readonly fields: readonly StudioField[];
  /** `null` when the model has no `@id` / `@unique` / `@@unique`: its records cannot be edited. */
  readonly key: StudioKey | null;
};

export type StudioRelationshipModel = {
  readonly name: string;
  readonly relType: string;
  readonly from: string;
  readonly to: string;
  readonly properties: readonly StudioScalarField[];
  /**
   * Relation field of `from` (pointing OUT to `to`) through which the edge properties can be
   * written, if any.
   */
  readonly via?: string;
};

export type StudioMeta = {
  readonly nodes: readonly StudioNodeModel[];
  readonly relationships: readonly StudioRelationshipModel[];
  readonly readOnly: boolean;
  /** Database address without credentials (`bolt://127.0.0.1:7687`). */
  readonly connection: string;
  readonly database?: string;
  readonly version: string;
  /** The database's dialect: the UI hides what it cannot run. */
  readonly dialect: StudioDialect;
};

/** Body of a list request on a node model. */
export type FindRequest = {
  readonly where?: Record<string, unknown>;
  readonly orderBy?: Record<string, "asc" | "desc">;
  readonly skip?: number;
  readonly take?: number;
};

export type FindResponse = {
  readonly rows: readonly Record<string, unknown>[];
  readonly total: number;
};

export type RelatedRequest = {
  /** Key of the record whose relation is followed (`{ id: "…" }`). */
  readonly where: Record<string, unknown>;
  readonly relation: string;
  readonly orderBy?: Record<string, "asc" | "desc">;
  readonly skip?: number;
  readonly take?: number;
};

/** One relation in a delete preview. */
export type DeleteEffect = {
  readonly relation: string;
  readonly target: string;
  readonly rule: "Cascade" | "Restrict" | "SetNull";
  /** Linked nodes through this relation. */
  readonly count: number;
};

export type DeletePreview = {
  readonly effects: readonly DeleteEffect[];
  /** `true` when an `onDelete: Restrict` relation still has linked nodes. */
  readonly blocked: boolean;
};

export type EdgeRow = {
  readonly from: Record<string, unknown>;
  readonly to: Record<string, unknown>;
  readonly properties: Record<string, unknown>;
};

export type EdgeFindRequest = {
  readonly orderBy?: Record<string, "asc" | "desc">;
  readonly skip?: number;
  readonly take?: number;
};

export type EdgeFindResponse = {
  readonly rows: readonly EdgeRow[];
  readonly total: number;
};

export type EdgeUpdateRequest = {
  /** Key of the `from` node (`{ id: "…" }`). */
  readonly from: Record<string, unknown>;
  /** Key of the `to` node. */
  readonly to: Record<string, unknown>;
  readonly data: Record<string, unknown>;
};

export type CypherRequest = {
  readonly query: string;
  readonly params?: Record<string, unknown>;
  /** Run in a write transaction (refused in read-only mode). */
  readonly write?: boolean;
};

export type CypherResponse = {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  /** `true` when more rows were returned than shown. */
  readonly truncated: boolean;
};

/** An error answer of the API. */
export type ApiError = {
  readonly error: string;
  /** Validation issues (`CyphraValidationError.issues`), field by field. */
  readonly issues?: readonly { readonly field: string; readonly message: string }[];
  /** Fields of a broken uniqueness constraint. */
  readonly fields?: readonly string[];
  /** Set when the database's dialect cannot run the operation (`UnsupportedFeatureError`). */
  readonly unsupported?: { readonly feature: string; readonly dialect: string };
};

/** Header every API request carries (forces a CORS preflight for cross-site requests). */
export const STUDIO_HEADER = "x-cyphra-studio";
