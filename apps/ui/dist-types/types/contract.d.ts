import type { CriterionId, CriterionMethod, InputValue } from "./events.js";
/**
 * The subset of `ScenarioContract` (design-contracts §4) the live view reads. Fetched from
 * `contractUrl` because `contractFrozen` only carries criterion *ids* — the view needs the verbatim
 * criterion text and its `model` vs `code` method before any verification has run.
 */
export interface ContractCriterion {
    readonly id: CriterionId;
    readonly text: string;
    readonly method: CriterionMethod;
    readonly checkName?: string;
    readonly line?: number;
    readonly column?: number;
}
export interface ContractView {
    readonly specPath?: string;
    readonly id?: string;
    readonly tags?: ReadonlyArray<string>;
    readonly fixtureName?: string;
    readonly criteria: ReadonlyArray<ContractCriterion>;
    readonly inputs?: Readonly<Record<string, InputValue>>;
    readonly maxActions?: number;
}
/** Tolerant reader: a malformed contract degrades the view, it never throws into render. */
export declare const readContract: (value: unknown) => ContractView | undefined;
//# sourceMappingURL=contract.d.ts.map