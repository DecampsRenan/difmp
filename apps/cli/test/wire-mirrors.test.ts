import { BudgetKind } from "@difmp/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `apps/ui` cannot depend on `@difmp/core`, so it keeps a hand-written mirror of the wire types.
 * Until #45 removes that mirror, this pins the parts that already drifted once (#58).
 */
const uiEvents = readFileSync(
  resolve(fileURLToPath(new URL(".", import.meta.url)), "../../ui/src/types/events.ts"),
  "utf8",
);

const literalsOf = (typeName: string): ReadonlyArray<string> => {
  const match = new RegExp(`export type ${typeName} =([^;]+);`).exec(uiEvents);
  if (match === null) throw new Error(`${typeName} not found in apps/ui/src/types/events.ts`);
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
};

describe("UI wire mirror", () => {
  it("BudgetKind lists exactly the kinds core can emit", () => {
    expect(literalsOf("BudgetKind").toSorted()).toEqual(BudgetKind.literals.toSorted());
  });
});
