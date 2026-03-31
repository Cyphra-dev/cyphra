/**
 * Provider-neutral compiled query shape (matches {@link CompiledCypher} from `@cyphra/query`).
 */
export type CompiledGraphQuery = {
  readonly text: string;
  readonly params: Readonly<Record<string, unknown>>;
};
