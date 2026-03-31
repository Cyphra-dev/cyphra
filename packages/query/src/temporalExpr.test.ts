import { describe, expect, it } from "vitest";
import {
  currentDateExpr,
  currentDateTimeExpr,
  currentLocalDateTimeExpr,
  currentLocalTimeExpr,
  currentTimeExpr,
} from "./temporalExpr.js";

describe("temporalExpr", () => {
  it("current instant expressions", () => {
    expect(currentDateExpr()).toBe("date()");
    expect(currentDateTimeExpr()).toBe("datetime()");
    expect(currentTimeExpr()).toBe("time()");
    expect(currentLocalDateTimeExpr()).toBe("localdatetime()");
    expect(currentLocalTimeExpr()).toBe("localtime()");
  });
});
