import type { CriterionId, CriterionMethod, InputValue } from "./events.js"

/**
 * The subset of `ScenarioContract` (design-contracts §4) the live view reads. Fetched from
 * `contractUrl` because `contractFrozen` only carries criterion *ids* — the view needs the verbatim
 * criterion text and its `model` vs `code` method before any verification has run.
 */
export interface ContractCriterion {
  readonly id: CriterionId
  readonly text: string
  readonly method: CriterionMethod
  readonly checkName?: string
  readonly line?: number
  readonly column?: number
}

export interface ContractView {
  readonly specPath?: string
  readonly id?: string
  readonly tags?: ReadonlyArray<string>
  readonly fixtureName?: string
  readonly criteria: ReadonlyArray<ContractCriterion>
  readonly inputs?: Readonly<Record<string, InputValue>>
  readonly maxActions?: number
}

const isMethod = (v: unknown): v is CriterionMethod => v === "model" || v === "code"

/** Tolerant reader: a malformed contract degrades the view, it never throws into render. */
export const readContract = (value: unknown): ContractView | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const rawCriteria = Array.isArray(record["criteria"]) ? record["criteria"] : []
  const criteria: Array<ContractCriterion> = []
  for (const raw of rawCriteria) {
    if (typeof raw !== "object" || raw === null) continue
    const c = raw as Record<string, unknown>
    const id = c["id"]
    const text = c["text"]
    if (typeof id !== "string" || typeof text !== "string") continue
    const method = isMethod(c["method"]) ? c["method"] : "model"
    const checkName = typeof c["checkName"] === "string" ? c["checkName"] : undefined
    criteria.push(checkName === undefined ? { id, text, method } : { id, text, method, checkName })
  }
  const view: {
    -readonly [K in keyof ContractView]: ContractView[K]
  } = { criteria }
  if (typeof record["specPath"] === "string") view.specPath = record["specPath"]
  if (typeof record["id"] === "string") view.id = record["id"]
  if (typeof record["fixtureName"] === "string") view.fixtureName = record["fixtureName"]
  if (typeof record["maxActions"] === "number") view.maxActions = record["maxActions"]
  if (Array.isArray(record["tags"])) view.tags = record["tags"].filter((t): t is string => typeof t === "string")
  return view
}
