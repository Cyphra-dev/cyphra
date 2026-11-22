import { parseSchema, printSchemaDocument, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { schemaFromIntrospection, type IntrospectionResult } from "./introspect.js";
import { labelLayout } from "./labelLayout.js";

const str = (name: string, mandatory = true) => ({
  propertyName: name,
  propertyTypes: ["String"],
  mandatory,
});
const nodes = (...types: [string[], string[]][]): IntrospectionResult => ({
  nodeTypes: types.map(([labels, props]) => ({ labels, properties: props.map((p) => str(p)) })),
  relTypes: [],
  constraints: [],
  indexes: [],
});
const pull = (input: IntrospectionResult, interfaces?: string[]) => {
  const { doc, warnings } = schemaFromIntrospection(input, { interfaces });
  const printed = printSchemaDocument(doc);
  // Every output must resolve.
  resolveSchema(parseSchema(printed));
  return { printed, warnings };
};

describe("cyphra pull: several interfaces per node (#185)", () => {
  const input: IntrospectionResult = {
    ...nodes(
      [
        ["Employee", "Person", "Archivable"],
        ["id", "name", "archivedAt", "salary"],
      ],
      [
        ["Customer", "Person"],
        ["id", "name", "tier"],
      ],
      [
        ["Doc", "Archivable"],
        ["id", "archivedAt", "body"],
      ],
    ),
    relTypes: [
      {
        type: "OWNS",
        properties: [],
        endpoints: [
          { from: ["Employee", "Person", "Archivable"], to: ["Doc", "Archivable"] },
          { from: ["Customer", "Person"], to: ["Doc", "Archivable"] },
        ],
      },
    ],
    constraints: [
      {
        name: "Person_id_unique",
        type: "UNIQUENESS",
        entityType: "NODE",
        labelsOrTypes: ["Person"],
        properties: ["id"],
      },
    ],
  };

  it("makes a node implement two unrelated interfaces", () => {
    const { printed, warnings } = pull(input);
    // id is on every Person and every Archivable: it stays on the interface constraining it.
    expect(printed).toBe(`interface Archivable {
  archivedAt String
}

node Customer implements Person {
  tier String
}

node Doc implements Archivable {
  body String
  id String
  ownsBy Person[] @relationship(type: "OWNS", direction: IN)
}

node Employee implements Archivable, Person {
  salary String
}

interface Person {
  id String @id
  name String
  owns Doc[] @relationship(type: "OWNS", direction: OUT)
}
`);
    expect(warnings).toEqual([]);
    const model = resolveSchema(parseSchema(printed));
    expect(model.nodes.find((n) => n.name === "Employee")?.labels).toEqual([
      "Employee",
      "Archivable",
      "Person",
    ]);
  });

  it("keeps a property both interfaces could hold on the nodes", () => {
    const { printed } = pull({ ...input, constraints: [] });
    expect(printed).toContain("node Doc implements Archivable {\n  body String\n  id String\n");
    expect(printed).toContain("interface Person {\n  name String\n");
    expect(printed).toContain("node Customer implements Person {\n  id String\n");
    expect(printed).toContain("node Employee implements Archivable, Person {\n  id String\n");
  });

  it("supports diamonds: two interfaces extending a third, both on one node", () => {
    const { printed, warnings } = pull(
      nodes(
        [
          ["Engineer", "Staff", "Contact", "Person"],
          ["id", "team", "phone", "level"],
        ],
        [
          ["Manager", "Staff", "Person"],
          ["id", "team"],
        ],
        [
          ["Vendor", "Contact", "Person"],
          ["id", "phone"],
        ],
        [["Guest", "Person"], ["id"]],
      ),
    );
    expect(warnings).toEqual([]);
    expect(printed).toContain("interface Contact extends Person {\n  phone String\n}");
    expect(printed).toContain("interface Staff extends Person {\n  team String\n}");
    expect(printed).toContain("node Engineer implements Contact, Staff {\n  level String\n}");
    expect(printed).toContain("interface Person {\n  id String\n}");
  });

  it("reads a single implementation as an interface when told which label it is", () => {
    const input = nodes(
      [
        ["Employee", "Person"],
        ["id", "name"],
      ],
      [["Team"], ["id"]],
    );
    const ambiguous = pull(input);
    expect(ambiguous.printed).not.toContain("interface");
    expect(ambiguous.warnings).toEqual([
      expect.stringMatching(
        /:Employee:Person became one model per label .*--interface .*candidates: Employee, Person/,
      ),
    ]);
    const { printed, warnings } = pull(input, ["Person"]);
    expect(warnings).toEqual([]);
    expect(printed).toBe(`node Employee implements Person {
}

interface Person {
  id String
  name String
}

node Team {
  id String
}
`);
  });

  it("settles a chain with one implementation per interface with hints", () => {
    const input = nodes(
      [
        ["Intern", "Staff", "Worker"],
        ["id", "school"],
      ],
      [["Boss", "Worker"], ["id"]],
    );
    const { printed, warnings } = pull(input, ["Staff"]);
    expect(warnings).toEqual([]);
    expect(printed).toContain("node Intern implements Staff {");
    expect(printed).toContain("interface Staff extends Worker {");
    expect(printed).toContain("node Boss implements Worker {");
  });

  it("explains hints that cannot apply", () => {
    const { warnings } = pull(nodes([["Team"], ["id"]], [["A", "B"], ["id"]]), ["Team", "Nope"]);
    expect(warnings).toContain("--interface Nope: no node carries the label Nope; ignored.");
    expect(warnings).toContain(
      "--interface Team: some nodes carry :Team alone, so it cannot be an interface; ignored.",
    );
  });
});

describe("cyphra pull: dynamic labels (#184)", () => {
  it("reads labels on some nodes of a model, with no data of their own, as @@labels", () => {
    const { printed, warnings } = pull(
      nodes(
        [["Post"], ["id", "title"]],
        [
          ["Post", "Archived"],
          ["id", "title"],
        ],
        [["Post", "Featured"], ["id"]],
        [
          ["Post", "Archived", "Featured"],
          ["id", "title"],
        ],
        [["User"], ["id"]],
        [["User", "Archived"], ["id"]],
      ),
    );
    expect(warnings).toEqual([]);
    expect(printed).toBe(`node Post {
  id String
  title String?

  @@labels([Archived, Featured])
}

node User {
  id String

  @@labels([Archived])
}
`);
  });

  it("combines interfaces and dynamic labels", () => {
    const { printed, warnings } = pull(
      nodes(
        [
          ["Employee", "Person"],
          ["id", "salary"],
        ],
        [
          ["Employee", "Person", "Archived"],
          ["id", "salary"],
        ],
        [
          ["Customer", "Person"],
          ["id", "tier"],
        ],
      ),
    );
    expect(warnings).toEqual([]);
    expect(printed).toContain(
      "node Employee implements Person {\n  salary String\n\n  @@labels([Archived])\n}",
    );
    expect(printed).not.toContain("node Archived");
  });

  it("keeps labels with data, constraints or no plain nodes as models", () => {
    // :Tagged nodes have a property plain Notes never have: a model of its own.
    const withData = pull(
      nodes(
        [["Note"], ["id"]],
        [
          ["Note", "Tagged"],
          ["id", "tag"],
        ],
      ),
    );
    expect(withData.printed).toContain("node Tagged {");
    expect(withData.warnings[0]).toMatch(/:Note:Tagged became one model per label/);
    // A constraint on :Flagged: Cyphra creates none for dynamic labels.
    const constrained = pull({
      ...nodes([["Note"], ["id"]], [["Note", "Flagged"], ["id"]]),
      constraints: [
        {
          name: "Flagged_id_unique",
          type: "UNIQUENESS",
          entityType: "NODE",
          labelsOrTypes: ["Flagged"],
          properties: ["id"],
        },
      ],
    });
    expect(constrained.printed).toContain("node Flagged {");
    // Every Post is :Draft or :Published: they are the models, Post their interface.
    const states = pull(
      nodes(
        [["Post", "Draft"], ["id"]],
        [
          ["Post", "Published"],
          ["id", "at"],
        ],
      ),
    );
    expect(states.warnings).toEqual([]);
    expect(states.printed).toContain("node Draft implements Post {");
    expect(states.printed).toContain("node Published implements Post {\n  at String\n}");
  });

  it("drops dynamic labels from relation endpoints", () => {
    const { printed } = pull({
      ...nodes([["Post"], ["id"]], [["Post", "Archived"], ["id"]], [["User"], ["id"]]),
      relTypes: [
        {
          type: "WROTE",
          properties: [],
          endpoints: [
            { from: ["User"], to: ["Post", "Archived"] },
            { from: ["User"], to: ["Post"] },
          ],
        },
      ],
    });
    expect(printed).toContain('wrote Post[] @relationship(type: "WROTE", direction: OUT)');
    expect(printed).toContain('wroteBy User[] @relationship(type: "WROTE", direction: IN)');
    expect(printed).not.toContain("Archived[]");
  });
});

describe("labelLayout", () => {
  const combos = (...cs: string[][]) =>
    cs.map((labels) => ({ labels, properties: new Set<string>() }));

  it("leaves single labels alone", () => {
    const l = labelLayout(combos(["A"], ["B"]));
    expect(l.parents.size + l.interfaces.size + l.dynamic.size + l.warnings.length).toBe(0);
  });

  it("gives up on a group too tangled to read, without hanging", () => {
    // 2^12 combinations of 12 labels that are never alone.
    const labels = Array.from({ length: 12 }, (_, i) => `L${i}`);
    const cs: string[][] = [];
    for (let mask = 3; mask < 1 << labels.length; mask += 7) {
      const c = labels.filter((_, i) => mask & (1 << i));
      if (c.length > 1) cs.push(c);
    }
    const started = Date.now();
    const l = labelLayout(combos(...cs));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(l.interfaces.size).toBe(0);
    expect(l.warnings.length).toBeGreaterThan(0);
  });
});
