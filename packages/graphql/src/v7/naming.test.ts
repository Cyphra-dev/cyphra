import { describe, expect, it } from "vitest";
import { camelCase, entityPlural } from "./naming.js";

describe("v7 naming", () => {
  it("pluralizes like v7 (camelCase, then pluralize)", () => {
    expect(entityPlural("Movie")).toBe("movies");
    expect(entityPlural("Person")).toBe("people");
    expect(entityPlural("Status")).toBe("statuses");
    expect(entityPlural("Category")).toBe("categories");
    expect(entityPlural("OrderLine")).toBe("orderLines");
  });

  it("uses @plural when given", () => {
    expect(entityPlural("Person", "Persons")).toBe("persons");
  });

  it("camelCases type names", () => {
    expect(camelCase("Movie")).toBe("movie");
    expect(camelCase("HTTPServer")).toBe("httpServer");
    expect(camelCase("my_type")).toBe("myType");
  });
});
