import type { ScriptedProviderScript, VerdictScript, VerdictSpec } from "@difmp/agent-runtime";
import type { Variant } from "@difmp/fixture-app";
import type { JourneyOptions } from "./journey.js";
import { loginThenCreateScript, projectCreateScript } from "./journey.js";
import {
  budgetExhaustionScript,
  exceedActionsThenSucceed,
  prematureFinishOnFixtureApp,
  skipLastCriterion,
  slowExplorationScript,
  staleObservationOnFixtureApp,
} from "./risky.js";

export * from "./journey.js";
export * from "./risky.js";

/**
 * Canned answers for the deterministic verifier, next to the browsing script that produces the
 * evidence. `$all` is resolved by the scripted provider against the artifactIds actually present in
 * its prompt, because a canned verdict cannot know the ids an attempt will mint.
 *
 * `evaluator.kind` is reported as `scripted-model`, so none of this can be mistaken for a model
 * judgement.
 */
const passed = (expected: string, observed: string): VerdictSpec => ({
  status: "passed",
  expected,
  observed,
  evidence: ["$all"],
});

const failed = (expected: string, observed: string): VerdictSpec => ({
  status: "failed",
  expected,
  observed,
  evidence: ["$all"],
  absence: "established-at-checkpoint",
});

const expectations = {
  created: "the project appears in the list after it is created",
  persisted: "the project is still present after the reload",
  unique: "exactly one entry with that name is visible in the list after the reload",
} as const;

export const healthyVerdicts: VerdictScript = {
  byCriterion: {
    c1: passed(
      expectations.created,
      "the list shows the project right after the form was submitted",
    ),
    c2: passed(
      expectations.persisted,
      "after the reload, the list rendered by the server still contains the project",
    ),
    c3: passed(
      expectations.unique,
      "the list visible after the reload contains exactly one entry with that name",
    ),
  },
};

/** `create-500`: the POST is refused, nothing is persisted, the UI shows the status in an alert. */
export const create500Verdicts: VerdictScript = {
  byCriterion: {
    c1: failed(
      expectations.created,
      "creation failed (HTTP 500) and the list does not contain the project; an alert quotes the status",
    ),
    c2: failed(
      expectations.persisted,
      "the project never existed: the reloaded list does not contain it",
    ),
    c3: failed(expectations.unique, "no entry with that name is visible after the reload"),
  },
};

/** `false-success`: 201 + optimistic UI, nothing written. Only the reload tells the difference. */
export const falseSuccessVerdicts: VerdictScript = {
  byCriterion: {
    c1: passed(
      expectations.created,
      "the list shows the project appended by the interface after the 201 response",
    ),
    c2: failed(
      expectations.persisted,
      "after the reload, the list rendered by the server no longer contains the project",
    ),
    c3: failed(expectations.unique, "no entry with that name is visible after the reload"),
  },
};

/**
 * `premature-finish`: no criterion was ever requested, so the verifier is never consulted. The
 * fallback exists only to prove the point if the runner asks anyway — an unrequested criterion
 * stays `inconclusive` and `finish` alone can never produce `passed`.
 */
export const prematureFinishVerdicts: VerdictScript = {
  fallback: {
    status: "inconclusive",
    expected: "evidence collected for this criterion",
    observed: "the agent declared the journey finished without requesting any evidence collection",
    evidence: [],
    missingEvidence: ["no screenshot and no observation was requested for this criterion"],
  },
};

/**
 * Two criteria settled, the third never requested by the agent and unsettleable by the runner's
 * final pass. `passed` requires every criterion — the aggregate must be `inconclusive`.
 */
export const unevaluatedCriterionVerdicts: VerdictScript = {
  byCriterion: {
    c1: passed(
      expectations.created,
      "the list shows the project right after the form was submitted",
    ),
    c2: passed(expectations.persisted, "after the reload, the list still contains the project"),
    c3: {
      status: "inconclusive",
      expected: expectations.unique,
      observed: "no evidence was requested for this criterion",
      evidence: [],
      missingEvidence: ["an observation of the list taken after the reload, for this criterion"],
    },
  },
};

/** Evidence that does not belong to the attempt must force `inconclusive`, never `passed`. */
export const inventedEvidenceVerdicts: VerdictScript = {
  fallback: {
    status: "passed",
    expected: expectations.created,
    observed: "claims to rely on evidence that was never produced",
    // Deliberately NOT a `$` token: `art_9999` is never minted, so the reference check must bite.
    evidence: ["art_9999"],
  },
};

/** A first pass that asks for more evidence, then concludes on the second. */
export const needsEvidenceThenPasses: VerdictScript = {
  byCriterion: {
    c1: [
      {
        status: "inconclusive",
        expected: expectations.created,
        observed: "the only screenshot available predates the form submission",
        evidence: [],
        missingEvidence: ["a screenshot of the list taken after the creation"],
        evidenceHint: "take a screenshot after the submission",
      },
      passed(
        expectations.created,
        "the screenshot taken after the submission shows the project in the list",
      ),
    ],
    c2: passed(expectations.persisted, "after the reload, the list still contains the project"),
    c3: passed(expectations.unique, "exactly one entry with that name is visible after the reload"),
  },
};

const verdictsForVariant = (variant: Variant): VerdictScript =>
  variant === "create-500"
    ? create500Verdicts
    : variant === "false-success"
      ? falseSuccessVerdicts
      : healthyVerdicts;

export interface FixtureAppScriptOptions extends JourneyOptions {
  /** Demo credentials for the fixture-free scenario; synthetic data, never secrets. */
  readonly demoEmail?: string;
  readonly demoPassword?: string;
}

/**
 * Every scripted case the demo needs, keyed by the name a test selects.
 * The four variant entries drive `project-create` / `project-create-checked`; the rest are the
 * harness-behaviour cases of spec §13.
 */
export const fixtureAppScripts = (
  options: FixtureAppScriptOptions,
): Readonly<Record<string, ScriptedProviderScript>> => {
  const forVariant = (variant: Variant): ScriptedProviderScript => ({
    agent: projectCreateScript({ ...options, variant }),
    verdicts: verdictsForVariant(variant),
  });

  return {
    // --- the four reproducible variants -------------------------------------------------------
    healthy: forVariant("healthy"),
    "create-500": forVariant("create-500"),
    "false-success": forVariant("false-success"),
    "alt-layout": forVariant("alt-layout"),

    // --- the fixture-free scenario ------------------------------------------------------------
    "no-fixture": {
      agent: loginThenCreateScript({
        ...options,
        email: options.demoEmail ?? "demo@example.test",
        password: options.demoPassword ?? "demo-password",
      }),
      verdicts: {
        byCriterion: {
          c1: passed("the user is signed in", "the home page displays the workspace name"),
          c2: passed(expectations.created, "the list shows the project right after the submission"),
          c3: passed(
            expectations.persisted,
            "after the reload, the list still contains the project",
          ),
        },
      },
    },

    // --- risky behaviours of the harness itself ------------------------------------------------
    "premature-finish": {
      agent: prematureFinishOnFixtureApp(),
      verdicts: prematureFinishVerdicts,
    },
    "exceed-actions": {
      // Crosses the indicative threshold and still passes: one warning, no refusal, no degradation.
      agent: exceedActionsThenSucceed(options),
      verdicts: healthyVerdicts,
    },
    cancellable: {
      // Long enough on purpose: the cancellation case needs a run that is still going when the
      // dashboard asks it to stop.
      agent: slowExplorationScript(options),
      verdicts: healthyVerdicts,
    },
    "stale-observation": {
      agent: staleObservationOnFixtureApp(options),
      verdicts: healthyVerdicts,
    },
    "budget-exhausted": {
      // 40k input tokens a turn burns `maxTokens` (200k, minus the 20k verifier reserve) in five
      // model calls, well before `maxModelCalls` (40) — so this case is about the token budget.
      agent: budgetExhaustionScript(),
      defaultUsage: { inputTokens: 40_000, outputTokens: 2_000 },
    },
    "unevaluated-criterion": {
      agent: skipLastCriterion(options),
      verdicts: unevaluatedCriterionVerdicts,
    },
    "invented-evidence": {
      agent: projectCreateScript(options),
      verdicts: inventedEvidenceVerdicts,
    },
    "needs-evidence": {
      agent: projectCreateScript(options),
      verdicts: needsEvidenceThenPasses,
    },
  };
};
