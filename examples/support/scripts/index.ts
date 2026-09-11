import type { ScriptedProviderScript, VerdictScript, VerdictSpec } from "@harness/agent-runtime"
import type { Variant } from "@harness/fixture-app"
import type { JourneyOptions } from "./journey.js"
import { loginThenCreateScript, projectCreateScript } from "./journey.js"
import { budgetExhaustionScript, exceedActionsThenSucceed, prematureFinishOnFixtureApp, skipLastCriterion, slowExplorationScript, staleObservationOnFixtureApp } from "./risky.js"

export * from "./journey.js"
export * from "./risky.js"

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
  evidence: ["$all"]
})

const failed = (expected: string, observed: string): VerdictSpec => ({
  status: "failed",
  expected,
  observed,
  evidence: ["$all"],
  absence: "established-at-checkpoint"
})

const expectations = {
  created: "le projet apparaît dans la liste après création",
  persisted: "le projet est toujours présent après rechargement",
  unique: "une seule entrée de ce nom est visible dans la liste après rechargement"
} as const

export const healthyVerdicts: VerdictScript = {
  byCriterion: {
    c1: passed(expectations.created, "la liste affiche le projet juste après la soumission du formulaire"),
    c2: passed(expectations.persisted, "après rechargement, la liste rendue par le serveur contient toujours le projet"),
    c3: passed(expectations.unique, "la liste visible après rechargement contient une seule entrée de ce nom")
  }
}

/** `create-500`: the POST is refused, nothing is persisted, the UI shows the status in an alert. */
export const create500Verdicts: VerdictScript = {
  byCriterion: {
    c1: failed(expectations.created, "la création a échoué (HTTP 500) et la liste ne contient pas le projet ; une alerte cite le statut"),
    c2: failed(expectations.persisted, "le projet n'a jamais existé : la liste rechargée ne le contient pas"),
    c3: failed(expectations.unique, "aucune entrée de ce nom n'est visible après rechargement")
  }
}

/** `false-success`: 201 + optimistic UI, nothing written. Only the reload tells the difference. */
export const falseSuccessVerdicts: VerdictScript = {
  byCriterion: {
    c1: passed(expectations.created, "la liste affiche le projet ajouté par l'interface après la réponse 201"),
    c2: failed(expectations.persisted, "après rechargement, la liste rendue par le serveur ne contient plus le projet"),
    c3: failed(expectations.unique, "aucune entrée de ce nom n'est visible après rechargement")
  }
}

/**
 * `premature-finish`: no criterion was ever requested, so the verifier is never consulted. The
 * fallback exists only to prove the point if the runner asks anyway — an unrequested criterion
 * stays `inconclusive` and `finish` alone can never produce `passed`.
 */
export const prematureFinishVerdicts: VerdictScript = {
  fallback: {
    status: "inconclusive",
    expected: "une preuve collectée pour ce critère",
    observed: "l'agent a déclaré la fin du parcours sans demander de collecte de preuve",
    evidence: [],
    missingEvidence: ["aucune capture ni observation n'a été demandée pour ce critère"]
  }
}

/**
 * Two criteria settled, the third never requested by the agent and unsettleable by the runner's
 * final pass. `passed` requires every criterion — the aggregate must be `inconclusive`.
 */
export const unevaluatedCriterionVerdicts: VerdictScript = {
  byCriterion: {
    c1: passed(expectations.created, "la liste affiche le projet juste après la soumission du formulaire"),
    c2: passed(expectations.persisted, "après rechargement, la liste contient toujours le projet"),
    c3: {
      status: "inconclusive",
      expected: expectations.unique,
      observed: "aucune preuve n'a été demandée pour ce critère",
      evidence: [],
      missingEvidence: ["une observation de la liste prise après le rechargement, pour ce critère"]
    }
  }
}

/** Evidence that does not belong to the attempt must force `inconclusive`, never `passed`. */
export const inventedEvidenceVerdicts: VerdictScript = {
  fallback: {
    status: "passed",
    expected: expectations.created,
    observed: "prétend s'appuyer sur une preuve qui n'a jamais été produite",
    // Deliberately NOT a `$` token: `art_9999` is never minted, so the reference check must bite.
    evidence: ["art_9999"]
  }
}

/** A first pass that asks for more evidence, then concludes on the second. */
export const needsEvidenceThenPasses: VerdictScript = {
  byCriterion: {
    c1: [
      {
        status: "inconclusive",
        expected: expectations.created,
        observed: "la capture disponible précède la soumission du formulaire",
        evidence: [],
        missingEvidence: ["une capture de la liste postérieure à la création"],
        evidenceHint: "prendre une capture après la soumission"
      },
      passed(expectations.created, "la capture postérieure à la soumission montre le projet dans la liste")
    ],
    c2: passed(expectations.persisted, "après rechargement, la liste contient toujours le projet"),
    c3: passed(expectations.unique, "une seule entrée de ce nom est visible après rechargement")
  }
}

const verdictsForVariant = (variant: Variant): VerdictScript =>
  variant === "create-500"
    ? create500Verdicts
    : variant === "false-success"
    ? falseSuccessVerdicts
    : healthyVerdicts

export interface FixtureAppScriptOptions extends JourneyOptions {
  /** Demo credentials for the fixture-free scenario; synthetic data, never secrets. */
  readonly demoEmail?: string
  readonly demoPassword?: string
}

/**
 * Every scripted case the demo needs, keyed by the name a test selects.
 * The four variant entries drive `project-create` / `project-create-checked`; the rest are the
 * harness-behaviour cases of spec §13.
 */
export const fixtureAppScripts = (
  options: FixtureAppScriptOptions
): Readonly<Record<string, ScriptedProviderScript>> => {
  const forVariant = (variant: Variant): ScriptedProviderScript => ({
    agent: projectCreateScript({ ...options, variant }),
    verdicts: verdictsForVariant(variant)
  })

  return {
    // --- the four reproducible variants -------------------------------------------------------
    "healthy": forVariant("healthy"),
    "create-500": forVariant("create-500"),
    "false-success": forVariant("false-success"),
    "alt-layout": forVariant("alt-layout"),

    // --- the fixture-free scenario ------------------------------------------------------------
    "no-fixture": {
      agent: loginThenCreateScript({
        ...options,
        email: options.demoEmail ?? "demo@example.test",
        password: options.demoPassword ?? "demo-password"
      }),
      verdicts: {
        byCriterion: {
          c1: passed("l'utilisateur est connecté", "l'accueil affiche le nom de l'espace de travail"),
          c2: passed(expectations.created, "la liste affiche le projet juste après la soumission"),
          c3: passed(expectations.persisted, "après rechargement, la liste contient toujours le projet")
        }
      }
    },

    // --- risky behaviours of the harness itself ------------------------------------------------
    "premature-finish": {
      agent: prematureFinishOnFixtureApp(),
      verdicts: prematureFinishVerdicts
    },
    "exceed-actions": {
      // Crosses the indicative threshold and still passes: one warning, no refusal, no degradation.
      agent: exceedActionsThenSucceed(options),
      verdicts: healthyVerdicts
    },
    "cancellable": {
      // Long enough on purpose: the cancellation case needs a run that is still going when the
      // dashboard asks it to stop.
      agent: slowExplorationScript(options),
      verdicts: healthyVerdicts
    },
    "stale-observation": {
      agent: staleObservationOnFixtureApp(options),
      verdicts: healthyVerdicts
    },
    "budget-exhausted": {
      // 40k input tokens a turn burns `maxTokens` (200k, minus the 20k verifier reserve) in five
      // model calls, well before `maxModelCalls` (40) — so this case is about the token budget.
      agent: budgetExhaustionScript(),
      defaultUsage: { inputTokens: 40_000, outputTokens: 2_000 }
    },
    "unevaluated-criterion": {
      agent: skipLastCriterion(options),
      verdicts: unevaluatedCriterionVerdicts
    },
    "invented-evidence": {
      agent: projectCreateScript(options),
      verdicts: inventedEvidenceVerdicts
    },
    "needs-evidence": {
      agent: projectCreateScript(options),
      verdicts: needsEvidenceThenPasses
    }
  }
}
