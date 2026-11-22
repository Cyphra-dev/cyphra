/**
 * How `cyphra pull` reads label combinations: which labels are models (`node`), which are
 * interfaces (`interface`, with `implements` / `extends`) and which are dynamic labels
 * (`@@labels([...])`, flags a node carries or not).
 *
 * The database only reports the distinct label combinations of its nodes (and the properties seen
 * on each). Within a group of labels seen together, every node is taken to have exactly one label
 * of its own (its model's): the models are chosen so that each combination holds exactly one of
 * them. Each other label of a combination is then
 *
 * - an **interface** of every model it is seen with, when it is on all their nodes;
 * - a **dynamic label** of every model it is seen with, when it is on some of their nodes only,
 *   carries no data of its own (its nodes have no property the model's other nodes never have),
 *   has no constraint or index, and the model's nodes are sometimes seen with none of its
 *   dynamic labels.
 *
 * A choice of models that leaves a label neither (on all nodes of one model, on some of
 * another's) is no layout. When exactly one choice is a layout it is used; when several are
 * (`[Employee, Person]` only: which one is the interface?) the group stays one model per label
 * unless hints (`cyphra pull --interface Person`) leave a single one.
 *
 * @packageDocumentation
 */

/** One label combination, with the property names seen on its nodes. */
export type LabelCombination = {
  readonly labels: readonly string[];
  readonly properties: ReadonlySet<string>;
};

/** The roles {@link labelLayout} gives the labels. */
export type LabelLayout = {
  /**
   * The interfaces each label inherits from directly: the ones a node `implements` or an
   * interface `extends` (sorted; absent for a label without any).
   */
  readonly parents: ReadonlyMap<string, readonly string[]>;
  /** Labels that are interfaces. */
  readonly interfaces: ReadonlySet<string>;
  /** The dynamic labels of each model that has some (sorted). */
  readonly dynamic: ReadonlyMap<string, readonly string[]>;
  /** Labels that are only dynamic labels (no model of their own). */
  readonly flags: ReadonlySet<string>;
  readonly warnings: readonly string[];
};

export type LabelLayoutOptions = {
  /** Labels to read as interfaces (`cyphra pull --interface`), to settle an ambiguous group. */
  readonly interfaces?: readonly string[];
  /** Whether a constraint or an index is declared on the label (then it is no dynamic label). */
  readonly hasSchemaObjects?: (label: string) => boolean;
};

/** Most model choices tried per group before giving up (a group this tangled stays per label). */
const MAX_STEPS = 50_000;
/** Valid layouts looked for per group: two are enough to know it is ambiguous. */
const MAX_SOLUTIONS = 16;

type Group = {
  readonly labels: readonly string[];
  readonly combos: readonly LabelCombination[];
};

/** One reading of a group: its models, interfaces (with their implementations) and flags. */
type Reading = {
  readonly models: ReadonlySet<string>;
  /** Interface → the models implementing it. */
  readonly impls: ReadonlyMap<string, ReadonlySet<string>>;
  /** Model → its dynamic labels. */
  readonly dynamic: ReadonlyMap<string, ReadonlySet<string>>;
};

function groupsOf(combos: readonly LabelCombination[]): Group[] {
  const groups: Group[] = [];
  const seen = new Set<string>();
  for (const c of combos) {
    if (c.labels.length < 2 || seen.has(c.labels[0]!)) continue;
    const labels = new Set(c.labels);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of combos) {
        if (x.labels.some((l) => labels.has(l)) && x.labels.some((l) => !labels.has(l))) {
          x.labels.forEach((l) => labels.add(l));
          grew = true;
        }
      }
    }
    labels.forEach((l) => seen.add(l));
    groups.push({
      labels: [...labels].sort(),
      combos: combos.filter((x) => x.labels.some((l) => labels.has(l))),
    });
  }
  return groups;
}

/** Every way (up to the caps) of picking one model label per combination of `group`. */
function modelChoices(group: Group, notModels: ReadonlySet<string>): string[][] | null {
  const { combos } = group;
  const combosOf = new Map<string, number[]>();
  combos.forEach((c, i) => {
    for (const l of c.labels) combosOf.set(l, [...(combosOf.get(l) ?? []), i]);
  });
  const out: string[][] = [];
  let steps = 0;
  const covered = new Array<boolean>(combos.length).fill(false);
  const chosen: string[] = [];
  const search = (): boolean => {
    if (++steps > MAX_STEPS) return false;
    const next = covered.indexOf(false);
    if (next < 0) {
      out.push([...chosen]);
      return out.length < MAX_SOLUTIONS;
    }
    for (const l of combos[next]!.labels) {
      if (notModels.has(l)) continue;
      const mine = combosOf.get(l)!;
      if (mine.some((i) => covered[i])) continue; // two models on one node
      mine.forEach((i) => (covered[i] = true));
      chosen.push(l);
      const go = search();
      chosen.pop();
      mine.forEach((i) => (covered[i] = false));
      if (!go) return false;
    }
    return true;
  };
  const done = search();
  return done || out.length >= MAX_SOLUTIONS ? out : null;
}

/** The roles of the other labels when `models` are the group's models, or `null` if none fit. */
function readingOf(
  group: Group,
  models: readonly string[],
  hinted: ReadonlySet<string>,
  hasSchemaObjects: (label: string) => boolean,
): Reading | null {
  const modelSet = new Set(models);
  const combosOf = (l: string) => group.combos.filter((c) => c.labels.includes(l));
  const impls = new Map<string, Set<string>>();
  const dynamic = new Map<string, Set<string>>();
  for (const x of group.labels) {
    if (modelSet.has(x)) continue;
    const owners = models.filter((m) => combosOf(m).some((c) => c.labels.includes(x)));
    const always = owners.filter((m) => combosOf(m).every((c) => c.labels.includes(x)));
    if (always.length === owners.length) {
      impls.set(x, new Set(owners));
      continue;
    }
    if (always.length > 0 || hinted.has(x) || hasSchemaObjects(x)) return null;
    for (const m of owners) {
      // A flag carries no data of its own: its nodes have no property the model's others lack.
      const withIt = combosOf(m).filter((c) => c.labels.includes(x));
      const without = new Set(
        combosOf(m)
          .filter((c) => !c.labels.includes(x))
          .flatMap((c) => [...c.properties]),
      );
      if (withIt.some((c) => [...c.properties].some((p) => !without.has(p)))) return null;
      dynamic.set(m, (dynamic.get(m) ?? new Set()).add(x));
    }
  }
  // A model's nodes are sometimes seen without any of its dynamic labels (otherwise, e.g. every
  // Post being :Draft or :Published, those labels are rather the models).
  for (const [m, flags] of dynamic) {
    if (!combosOf(m).some((c) => !c.labels.some((l) => flags.has(l)))) return null;
  }
  return { models: modelSet, impls, dynamic };
}

/** The roles of the labels of `combos` (see the module documentation). */
export function labelLayout(
  combos: readonly LabelCombination[],
  options: LabelLayoutOptions = {},
): LabelLayout {
  const warnings: string[] = [];
  const hasSchemaObjects = options.hasSchemaObjects ?? (() => false);
  const all = new Set(combos.flatMap((c) => c.labels));
  const alone = new Set(combos.filter((c) => c.labels.length === 1).map((c) => c.labels[0]!));
  const hinted = new Set<string>();
  for (const h of options.interfaces ?? []) {
    if (!all.has(h)) warnings.push(`--interface ${h}: no node carries the label ${h}; ignored.`);
    else if (alone.has(h)) {
      warnings.push(
        `--interface ${h}: some nodes carry :${h} alone, so it cannot be an interface; ignored.`,
      );
    } else hinted.add(h);
  }

  const parents = new Map<string, string[]>();
  const interfaces = new Set<string>();
  const dynamic = new Map<string, string[]>();
  const flags = new Set<string>();
  for (const group of groupsOf(combos)) {
    const choices = modelChoices(group, hinted) ?? [];
    const readings = choices
      .map((models) => readingOf(group, models, hinted, hasSchemaObjects))
      .filter((r): r is Reading => r !== null);
    if (readings.length !== 1) {
      const multi = group.combos.filter((c) => c.labels.length > 1);
      if (readings.length > 1) {
        // Labels that are an interface in some readings and a model in others.
        const either = group.labels.filter(
          (l) => readings.some((r) => r.impls.has(l)) && readings.some((r) => r.models.has(l)),
        );
        warnings.push(
          `Nodes labelled ${multi.map((c) => c.labels.map((l) => `:${l}`).join("")).join(", ")} became one model per label (${group.labels.join(", ")}): which labels are interfaces is ambiguous. Run \`cyphra pull\` with --interface <label> for each one that is (candidates: ${either.join(", ")}).`,
        );
        continue;
      }
      for (const c of multi) {
        warnings.push(
          `Nodes labelled ${c.labels.map((l) => `:${l}`).join("")} became one model per label (${c.labels.join(", ")}): an interface needs a label on every node of the models it is seen with (and never alone), a dynamic label a label on some of them only, with no property or constraint of its own.`,
        );
      }
      continue;
    }
    const r = readings[0]!;
    for (const i of r.impls.keys()) interfaces.add(i);
    // An interface extends another when every implementation of the first implements the second.
    const ancestors = (i: string) =>
      [...r.impls.keys()].filter((j) => {
        if (j === i) return false;
        const a = r.impls.get(i)!;
        const b = r.impls.get(j)!;
        return a.size < b.size && [...a].every((m) => b.has(m));
      });
    const direct = (above: readonly string[]) =>
      above.filter((a) => !above.some((b) => b !== a && ancestors(b).includes(a))).sort();
    for (const i of r.impls.keys()) {
      const p = direct(ancestors(i));
      if (p.length) parents.set(i, p);
    }
    for (const m of r.models) {
      const p = direct([...r.impls].filter(([, ms]) => ms.has(m)).map(([i]) => i));
      if (p.length) parents.set(m, p);
    }
    for (const [m, fs] of r.dynamic) {
      dynamic.set(m, [...fs].sort());
      fs.forEach((f) => flags.add(f));
    }
  }
  return { parents, interfaces, dynamic, flags, warnings };
}
