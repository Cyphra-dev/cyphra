/**
 * Scalars of the native API: Cyphra's scalar types, with the client's value formats (temporal
 * types as ISO 8601 text, `BigInt` as a decimal string, `Json` as any JSON value).
 *
 * @packageDocumentation
 */

import {
  GraphQLError,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  Kind,
  valueFromASTUntyped,
  type GraphQLFieldConfigMap,
} from "graphql";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(name: string, description: string, check?: (s: string) => boolean) {
  const parse = (v: unknown) => {
    if (typeof v !== "string" || (check && !check(v))) {
      throw new GraphQLError(`${name} cannot represent ${JSON.stringify(v)}: ${description}`);
    }
    return v;
  };
  return new GraphQLScalarType({
    name,
    description,
    serialize(value) {
      if (typeof value === "string") return value;
      throw new GraphQLError(`${name} cannot represent value: ${String(value)}`);
    },
    parseValue: parse,
    parseLiteral(ast) {
      if (ast.kind !== Kind.STRING) {
        throw new GraphQLError(`${name} must be a string: ${description}`);
      }
      return parse(ast.value);
    },
  });
}

export const DateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description: "An instant, as an ISO 8601 string (`2026-11-01T09:30:00.000Z`).",
  serialize(value) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") return value;
    throw new GraphQLError(`DateTime cannot represent value: ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw new GraphQLError(
        `DateTime cannot represent ${JSON.stringify(value)}: expected an ISO 8601 date-time string.`,
      );
    }
    return value;
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING || Number.isNaN(Date.parse(ast.value))) {
      throw new GraphQLError("DateTime must be an ISO 8601 date-time string.");
    }
    return ast.value;
  },
});

export const DateScalar = new GraphQLScalarType({
  name: "Date",
  description: "A calendar date, as a `yyyy-mm-dd` string.",
  serialize(value) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === "string") return value;
    throw new GraphQLError(`Date cannot represent value: ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
      throw new GraphQLError(
        `Date cannot represent ${JSON.stringify(value)}: expected a yyyy-mm-dd string.`,
      );
    }
    return value;
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING || !ISO_DATE.test(ast.value)) {
      throw new GraphQLError("Date must be a yyyy-mm-dd string.");
    }
    return ast.value;
  },
});

export const LocalDateTimeScalar = text(
  "LocalDateTime",
  "A date and time without a time zone, as an ISO 8601 string (`2026-11-01T09:30:00`).",
);
export const LocalTimeScalar = text(
  "LocalTime",
  "A time of day without a time zone, as an ISO 8601 string (`09:30:00`).",
);
export const TimeScalar = text(
  "Time",
  "A time of day with a UTC offset, as an ISO 8601 string (`09:30:00+02:00`).",
);
export const DurationScalar = text("Duration", "A duration, as an ISO 8601 string (`P1DT2H`).");

function toBigInt(v: string): bigint {
  if (!/^-?\d+$/.test(v)) throw new GraphQLError(`BigInt cannot represent ${JSON.stringify(v)}.`);
  return BigInt(v);
}

export const BigIntScalar = new GraphQLScalarType({
  name: "BigInt",
  description: "A 64-bit integer, as a decimal string (an integer literal is accepted in queries).",
  serialize(value) {
    if (typeof value === "bigint" || typeof value === "number") return value.toString(10);
    if (typeof value === "string") return value;
    throw new GraphQLError(`BigInt cannot represent value: ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value === "string") return toBigInt(value);
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    throw new GraphQLError("BigInt values are decimal strings.");
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.INT || ast.kind === Kind.STRING) return toBigInt(ast.value);
    throw new GraphQLError("BigInt must be an integer or a decimal string.");
  },
});

export const JsonScalar = new GraphQLScalarType({
  name: "Json",
  description: "Any JSON value.",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast, variables) => valueFromASTUntyped(ast, variables),
});

/** The object type of a point; its fields are read by name (they take no arguments). */
function pointType(name: string, description: string, axes: [string, string, string]) {
  const fields: GraphQLFieldConfigMap<Record<string, unknown>, unknown> = {
    [axes[0]]: { type: new GraphQLNonNull(GraphQLFloat) },
    [axes[1]]: { type: new GraphQLNonNull(GraphQLFloat) },
    [axes[2]]: { type: GraphQLFloat },
  };
  return new GraphQLObjectType({ name, description, fields });
}

function pointInput(name: string, description: string, axes: [string, string, string]) {
  return new GraphQLInputObjectType({
    name,
    description,
    fields: {
      [axes[0]]: { type: new GraphQLNonNull(GraphQLFloat) },
      [axes[1]]: { type: new GraphQLNonNull(GraphQLFloat) },
      [axes[2]]: { type: GraphQLFloat },
    },
  });
}

const WGS = ["longitude", "latitude", "height"] as [string, string, string];
const XYZ = ["x", "y", "z"] as [string, string, string];

export const PointType = pointType("Point", "A WGS-84 point (degrees, height in meters).", WGS);
export const CartesianPointType = pointType("CartesianPoint", "A cartesian point.", XYZ);
export const PointInputType = pointInput("PointInput", "A WGS-84 point.", WGS);
export const CartesianPointInputType = pointInput("CartesianPointInput", "A cartesian point.", XYZ);
