/**
 * Scalars of the v7 API. Same names, descriptions and input/output formats as `@neo4j/graphql`:
 * `BigInt` is returned as a string, `Date` as `yyyy-mm-dd`, `DateTime` as an ISO-8601 string.
 *
 * @packageDocumentation
 */

import { GraphQLError, GraphQLScalarType, Kind } from "graphql";
import neo4j, { isDate, isDateTime, isInt } from "neo4j-driver";

export const GraphQLBigInt = new GraphQLScalarType({
  name: "BigInt",
  description:
    "A BigInt value up to 64 bits in size, which can be a number or a string if used inline, or a string only if used as a variable. Always returned as a string.",
  serialize(value) {
    if (isInt(value)) return value.toString(10);
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return value.toString(10);
    throw new GraphQLError(`BigInt cannot represent value: ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value !== "string") {
      throw new GraphQLError(
        "BigInt values are not JSON serializable. Please pass as a string in variables, or inline in the GraphQL query.",
      );
    }
    try {
      return neo4j.int(value, { strictStringValidation: true });
    } catch {
      throw new GraphQLError(
        "Value must be either a BigInt, or a string representing a BigInt value.",
      );
    }
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.INT || ast.kind === Kind.STRING) {
      try {
        return neo4j.int(ast.value, { strictStringValidation: true });
      } catch {
        // fall through
      }
    }
    throw new GraphQLError(
      "Value must be either a BigInt, or a string representing a BigInt value.",
    );
  },
});

const formatDate = (s: string): string => new Date(s).toISOString().split("T")[0]!;

export const GraphQLDate = new GraphQLScalarType({
  name: "Date",
  description: "A date, represented as a 'yyyy-mm-dd' string",
  serialize(value) {
    if (typeof value === "string") return formatDate(value);
    if (isDate(value as object)) return formatDate(String(value));
    throw new GraphQLError(`Date cannot represent value: ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value === "string") {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        throw new GraphQLError(`Date cannot represent non temporal value: ${value}`);
      }
      return neo4j.types.Date.fromStandardDate(d);
    }
    if (isDate(value as object)) return value;
    throw new GraphQLError(`Date cannot represent non string value: ${String(value)}`);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) throw new GraphQLError("Date cannot represent non string value.");
    return neo4j.types.Date.fromStandardDate(new Date(ast.value));
  },
});

export const GraphQLDateTime = new GraphQLScalarType({
  name: "DateTime",
  description: "A date and time, represented as an ISO-8601 string",
  serialize(value) {
    if (typeof value === "string") return new Date(value).toISOString();
    if (isDateTime(value as object)) return new Date(String(value)).toISOString();
    if (value instanceof Date) return value.toISOString();
    throw new GraphQLError(`DateTime cannot represent value: ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value === "string") {
      if (Number.isNaN(new Date(value).getTime())) {
        throw new GraphQLError(`DateTime cannot represent non temporal value: ${value}`);
      }
      return value;
    }
    throw new GraphQLError(`DateTime cannot represent non string value: ${String(value)}`);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING)
      throw new GraphQLError("DateTime cannot represent non string value.");
    return ast.value;
  },
});
