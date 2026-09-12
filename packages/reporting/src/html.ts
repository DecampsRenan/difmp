import type { ReportInput } from "@difmp/core"
import { artifactHref, embedJson, escapeHtml as h } from "./escape.js"
import { reportStyles } from "./styles.js"
import type { ArtifactView, AttemptView, CriterionView, Diagnostic, ReportView, TimelineEntry } from "./view.js"
import { buildReportView, criterionStatusLabel, downgradeLabel } from "./view.js"

/**
 * The statement spec §9 demands whenever a verdict came from a textual evaluation. It is rendered
 * next to every `model` criterion, not once in a footnote.
 */
const PROBABILISTIC_NOTE =
  "Évaluation textuelle par modèle : le verdict est probabiliste et argumenté à partir des preuves " +
  "collectées. Ce n'est pas une assertion déterministe et il peut différer d'une exécution à l'autre."

const DETERMINISTIC_NOTE =
  "Évaluation par code : un check TypeScript enregistré a produit ce verdict de façon déterministe."

const SCRIPTED_NOTE =
  "Double scripté déterministe : réponse de test, jamais un jugement de modèle réel."

const formatDuration = (ms: number): string =>
  ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${
    Math.round((ms % 60_000) / 1000)
  } s`

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} o` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} Kio` : `${
    (bytes / (1024 * 1024)).toFixed(1)
  } Mio`

const shortHash = (hash: string): string => hash === "" ? "—" : hash.slice(0, 16)

const badge = (status: string, label: string): string =>
  `<span class="badge s-${h(status)}">${h(label)}</span>`

/** Neutral on purpose: the method is not a verdict and must not borrow a status colour. */
const methodBadge = (method: "model" | "code"): string =>
  `<span class="badge method">méthode ${h(method)}</span>`

/** A path is data too: only a relative, in-directory path becomes a link. */
const artifactLink = (artifact: ArtifactView): string => {
  if (artifact.path === undefined) return `<span class="missing">aucun fichier</span>`
  const href = artifactHref(artifact.path)
  return href === undefined
    ? `<span class="mono wrap">${h(artifact.path)}</span> <span class="missing">(chemin non relatif, non lié)</span>`
    : `<a class="mono wrap" href="${h(href)}">${h(artifact.path)}</a>`
}

const definition = (label: string, value: string | undefined, mono = false): string =>
  value === undefined || value === ""
    ? ""
    : `<dt>${h(label)}</dt><dd class="wrap${mono ? " mono" : ""}">${h(value)}</dd>`

const expectationItem = (criterion: CriterionView): string => {
  const source = criterion.sourceText === criterion.expectation
    ? ""
    : `<dt>Texte source (avant interpolation)</dt><dd><pre>${h(criterion.sourceText)}</pre></dd>`
  return `<article class="item">
  <header>
    <b class="mono">${h(criterion.id)}</b>
    ${methodBadge(criterion.method)}
    <span class="cat">${h(criterion.location)}</span>
  </header>
  <pre>${h(criterion.expectation)}</pre>
  <dl class="kv">
    ${definition("Hash du critère (contrat)", shortHash(criterion.contractHash), true)}
    ${source}
  </dl>
</article>`
}

/**
 * The harness refusing to conclude is INFORMATION. A criterion that reads `inconclusive` because a
 * rule downgraded it must say which rule, what the evaluator had answered, and why — otherwise the
 * reader cannot tell "the evaluator was unsure" from "the harness would not take its word".
 */
const downgradeBlock = (criterion: CriterionView): string => {
  if (criterion.downgrades.length === 0) return ""
  const rows = criterion.downgrades.map((downgrade) =>
    `<li><b>${h(downgradeLabel(downgrade.reason))}</b> — statut ramené de « ${
      h(criterionStatusLabel(downgrade.from))
    } » à « ${h(criterionStatusLabel(downgrade.to))} » : ${h(downgrade.detail)}</li>`
  ).join("")
  return `<div class="note d-warning"><b>Statut imposé par le harness</b>
  <ul>${rows}</ul>
  <p>Le verdict affiché n'est pas celui proposé par l'évaluateur : une règle du harness l'a refusé.</p></div>`
}

/** spec §9 forbids losing an earlier verdict when the agent asks again. */
const reCheckBlock = (criterion: CriterionView): string => {
  if (criterion.reChecks.length === 0) return ""
  const rows = criterion.reChecks.map((reCheck) =>
    `<tr><td class="mono">seq ${h(String(reCheck.evaluatedAtSeq))}</td><td>${
      h(criterionStatusLabel(reCheck.status))
    }</td><td>${h(reCheck.requestedBy)}</td><td>${
      reCheck.applied ? badge("failed", "a remplacé le verdict") : badge("inconclusive", "observation seulement")
    }</td><td class="wrap">${h(reCheck.observed)}</td></tr>`
  ).join("")
  return `<div class="note d-warning"><b>Évaluations ultérieures de ce critère</b>
  <div class="scroll"><table>
    <thead><tr><th>Événement</th><th>Statut rendu</th><th>Demandé par</th><th>Effet</th><th>Observé</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p>${h(criterion.reChecks[criterion.reChecks.length - 1]!.note)}</p></div>`
}

const evaluationItem = (criterion: CriterionView): string => {
  const note = criterion.evaluatorKind === "scripted-model"
    ? `<p class="note">${h(SCRIPTED_NOTE)} ${h(PROBABILISTIC_NOTE)}</p>`
    : criterion.probabilistic
    ? `<p class="note">${h(PROBABILISTIC_NOTE)}</p>`
    : `<p class="note deterministic">${h(DETERMINISTIC_NOTE)}</p>`

  const evidence = criterion.evidence.length === 0
    ? `<dd>aucune preuve attachée</dd>`
    : `<dd><ul>${
      criterion.evidence.map((a) =>
        `<li><span class="mono">${h(a.artifactId)}</span> — ${h(a.kind)} — ${artifactLink(a)}</li>`
      ).join("")
    }</ul></dd>`

  const dangling = criterion.danglingEvidence.length === 0
    ? ""
    : `<dt>Références de preuve introuvables</dt><dd class="missing mono">${
      h(criterion.danglingEvidence.join(", "))
    }</dd>`

  const mismatch = criterion.hashMismatch
    ? `<p class="note d-error">Le hash évalué (${
      h(shortHash(criterion.resultHash ?? ""))
    }) ne correspond pas au hash gelé du contrat (${h(shortHash(criterion.contractHash))}).</p>`
    : ""

  return `<article class="item">
  <header>
    <b class="mono">${h(criterion.id)}</b>
    ${badge(criterion.status, criterionStatusLabel(criterion.status))}
    ${methodBadge(criterion.method)}
    <span class="cat">${h(criterion.evaluatorLabel)}</span>
  </header>
  ${note}
  ${mismatch}
  ${downgradeBlock(criterion)}
  ${reCheckBlock(criterion)}
  <dl class="kv">
    <dt>Attente évaluée (texte gelé)</dt><dd><pre>${h(criterion.expectation)}</pre></dd>
    <dt>Attendu (évaluateur)</dt><dd><pre>${h(criterion.expected ?? "—")}</pre></dd>
    <dt>Observé (évaluateur)</dt><dd><pre>${h(criterion.observed ?? "—")}</pre></dd>
    ${definition("Limites déclarées", criterion.limitations)}
    ${
    definition(
      "Branche de la règle d'absence",
      criterion.absence === undefined
        ? undefined
        : criterion.absence === "uncertain-navigation"
        ? "absence après navigation incertaine → non concluant"
        : "absence établie au checkpoint prévu → échec"
    )
  }
    ${definition("Évalué à l'événement", criterion.evaluatedAtSeq === undefined ? undefined : `seq ${criterion.evaluatedAtSeq}`)}
    ${definition("Tentative", criterion.attemptId)}
    <dt>Preuves</dt>${evidence}
    ${dangling}
  </dl>
</article>`
}

const timelineRow = (entry: TimelineEntry): string =>
  `<tr class="c-${h(entry.category)}">
  <td class="mono">${h(String(entry.seq))}</td>
  <td class="mono wrap">${h(entry.ts)}</td>
  <td><span class="cat">${h(entry.category)}</span></td>
  <td class="wrap">${h(entry.title)}${
    entry.durationMs === undefined ? "" : ` <span class="cat">(${h(formatDuration(entry.durationMs))})</span>`
  }</td>
  <td class="wrap">${
    entry.fields.map((f) => `<div><span class="cat">${h(f.label)}</span> ${h(f.value)}</div>`).join("")
  }</td>
</tr>`

const attemptAccounting = (attempt: AttemptView): string => `<div class="item">
  <header><b class="mono">${h(attempt.attemptId)}</b> ${badge(attempt.status, attempt.status)}</header>
  <h3>Budgets bloquants — consommé et restant</h3>
  <div class="scroll"><table>
    <thead><tr><th>Budget</th><th>Consommé</th><th>Limite</th><th>Restant</th><th>Note</th></tr></thead>
    <tbody>${
  attempt.budgets.map((b) =>
    `<tr><td>${h(b.label)} <span class="cat">${h(b.key)}</span></td><td class="mono">${h(String(b.used))}</td><td class="mono">${
      h(String(b.limit))
    }</td><td class="mono">${h(String(b.remaining))}</td><td class="wrap">${h(b.note ?? "")}</td></tr>`
  ).join("")
}</tbody>
  </table></div>
  <h3>Compteur d'actions — seuil INDICATIF, distinct des budgets</h3>
  <p class="mono big">${h(attempt.actions.rendering)}</p>
  <p class="note">Le seuil <code>maxActions</code> est indicatif : le dépasser n'a rien refusé, n'a dégradé aucun
  statut et n'entre dans aucun budget bloquant. ${
  attempt.actions.exceeded ? "Il a été dépassé pendant cette tentative." : "Il n'a pas été dépassé."
}</p>
</div>`

const artifactRow = (artifact: ArtifactView): string => `<tr>
  <td class="mono">${h(artifact.artifactId)}</td>
  <td class="mono">${h(artifact.attemptId)}</td>
  <td>${h(artifact.kind)}${artifact.label === undefined ? "" : ` <span class="cat">${h(artifact.label)}</span>`}</td>
  <td>${
  artifact.state === "present"
    ? badge("passed", "présent")
    : badge(artifact.state === "failed" ? "failed" : "inconclusive", artifact.state === "failed" ? "échec" : "manquant")
}</td>
  <td>${artifactLink(artifact)}</td>
  <td class="wrap">${h(artifact.reason ?? "")}</td>
  <td class="mono">${artifact.bytes === undefined ? "" : h(formatBytes(artifact.bytes))}</td>
  <td class="mono wrap">${h(artifact.ts)}</td>
</tr>`

const diagnosticItem = (diagnostic: Diagnostic): string =>
  `<p class="note d-${h(diagnostic.severity)}"><b>${h(diagnostic.source)}</b>${
    diagnostic.seq === undefined ? "" : ` <span class="cat">seq ${h(String(diagnostic.seq))}</span>`
  } — ${h(diagnostic.message)}</p>`

export const renderHtmlReport = (input: ReportInput): string => renderHtmlFromView(buildReportView(input))

export const renderHtmlFromView = (view: ReportView): string => {
  const title = `Rapport ${view.scenarioId} — ${view.statusLabel}`
  const counts = view.counts

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)}</title>
<style>${reportStyles}</style>
</head>
<body>
<main>

<section class="panel" id="verdict">
  <div class="verdict">
    <div>
      <h1>${h(view.scenarioId)}</h1>
      <p class="lede mono">${h(view.specPath)}</p>
    </div>
    <div class="big s-${h(view.status)}">${h(view.statusLabel)}</div>
  </div>
  ${view.statusDetail === undefined ? "" : `<p class="note">${h(view.statusDetail)}</p>`}
  ${
    view.finalized
      ? ""
      : `<p class="note d-error">Exécution non finalisée : le journal se termine sur une ligne incomplète.
         Ce rapport peut être partiel.</p>`
  }
  <div class="meta">
    <div><span>Run</span><span class="mono">${h(view.runId)}</span></div>
    <div><span>Démarré</span><span class="mono">${h(view.startedAt)}</span></div>
    <div><span>Terminé</span><span class="mono">${h(view.finishedAt)}</span></div>
    <div><span>Durée</span>${h(formatDuration(view.durationMs))}</div>
    <div><span>Hash du contrat</span><span class="mono">${h(shortHash(view.contractHash))}</span></div>
    <div><span>Adaptateur</span><span class="mono">${h(view.model.adapterId)}</span></div>
    <div><span>Modèle</span><span class="mono">${h(`${view.model.provider}/${view.model.modelId}`)}</span></div>
    <div><span>Base URL</span><span class="mono wrap">${h(view.baseUrl)}</span></div>
    <div><span>Harness / Node</span><span class="mono">${h(`${view.harnessVersion} / ${view.nodeVersion}`)}</span></div>
  </div>
  <div class="tiles">
    <div class="tile s-passed"><b>${h(String(counts.passed))}</b><span>réussis</span></div>
    <div class="tile s-failed"><b>${h(String(counts.failed))}</b><span>échoués</span></div>
    <div class="tile s-inconclusive"><b>${h(String(counts.inconclusive))}</b><span>non concluants</span></div>
    <div class="tile s-error"><b>${h(String(counts.error))}</b><span>en erreur</span></div>
    <div class="tile s-pending"><b>${h(String(counts.pending))}</b><span>en attente</span></div>
    <div class="tile"><b>${h(String(view.artifactCounts.present))}</b><span>artefacts présents</span></div>
    <div class="tile"><b>${
    h(String(view.artifactCounts.missing + view.artifactCounts.failed))
  }</b><span>artefacts manquants</span></div>
  </div>
</section>

<nav>
  <a href="#attentes">Attentes</a>
  <a href="#evaluations">Évaluations</a>
  <a href="#faits">Observations factuelles</a>
  <a href="#comptes">Budgets et actions</a>
  <a href="#artefacts">Artefacts</a>
  <a href="#diagnostics">Hypothèses de diagnostic</a>
</nav>

<section class="panel" id="attentes">
  <h2>Attentes textuelles</h2>
  <p class="lede">Le texte gelé du contrat, verbatim. Rien ici n'est un résultat : c'est ce qui était demandé,
  tel que figé avant toute navigation. L'agent navigateur ne peut pas le modifier.</p>
  ${view.criteria.map(expectationItem).join("\n")}
  ${
  view.criteria.length === 0
    ? `<p class="note">Aucune attente n'a été gelée : le run s'est arrêté avant l'étape 3 de §6 (contrat jamais gelé).
  Ce rapport décrit un échec d'infrastructure, pas un verdict sur le produit.</p>`
    : ""
}
  <h3>Corps du scénario (interpolé)</h3>
  <pre>${h(view.scenarioBody)}</pre>
</section>

<section class="panel" id="evaluations">
  <h2>Évaluations</h2>
  <p class="lede">Les verdicts, avec leur méthode et leur évaluateur. Une évaluation par modèle est un jugement
  textuel probabiliste ; une évaluation par code est une assertion déterministe. Les deux sont distinguées
  explicitement ci-dessous.</p>
  ${view.criteria.map(evaluationItem).join("\n")}
  ${view.criteria.length === 0 ? `<p class="note">Aucun critère n'a pu être évalué.</p>` : ""}
</section>

<section class="panel" id="faits">
  <h2>Observations factuelles</h2>
  <p class="lede">La chronologie journalisée des actions, observations, vérifications et erreurs. Ce sont des
  faits enregistrés pendant l'exécution, sans interprétation.</p>
  <div class="scroll"><table>
    <thead><tr><th>Seq</th><th>Horodatage</th><th>Catégorie</th><th>Événement</th><th>Détails</th></tr></thead>
    <tbody>${view.timeline.map(timelineRow).join("")}</tbody>
  </table></div>
  ${view.timeline.length === 0 ? `<p class="note">Aucun événement journalisé.</p>` : ""}
</section>

<section class="panel" id="comptes">
  <h2>Budgets bloquants et compteur d'actions</h2>
  <p class="lede">Deux choses distinctes, présentées séparément : les budgets bloquants terminent l'exécution
  lorsqu'ils sont épuisés ; le seuil d'actions est purement indicatif et ne modifie jamais un verdict.</p>
  ${view.attempts.map(attemptAccounting).join("\n")}
  ${view.attempts.length === 0 ? `<p class="note">Aucune tentative enregistrée.</p>` : ""}
</section>

<section class="panel" id="artefacts">
  <h2>Inventaire des artefacts</h2>
  <p class="lede">Chaque artefact attendu, présent ou non. Un échec de capture est listé avec sa raison, jamais
  dissimulé. Les liens sont des chemins relatifs au répertoire du run.</p>
  <div class="scroll"><table>
    <thead><tr><th>Id</th><th>Tentative</th><th>Type</th><th>État</th><th>Fichier</th><th>Raison</th><th>Taille</th><th>Horodatage</th></tr></thead>
    <tbody>${view.artifacts.map(artifactRow).join("")}</tbody>
  </table></div>
  ${view.artifacts.length === 0 ? `<p class="note">Aucun artefact enregistré.</p>` : ""}
</section>

<section class="panel" id="diagnostics">
  <h2>Hypothèses de diagnostic</h2>
  <p class="lede">Interprétations et signaux, pas des faits observés : raisons d'un statut, budgets épuisés,
  limites déclarées par les évaluateurs, artefacts manquants.</p>
  ${
    view.diagnostics.length === 0
      ? `<p class="note d-info">Aucun signal de diagnostic enregistré.</p>`
      : view.diagnostics.map(diagnosticItem).join("\n")
  }
</section>

<footer>
  <p>Rapport autonome : il s'ouvre hors ligne depuis <code>file://</code> et ne charge aucune ressource externe.
  Les gros artefacts restent des fichiers voisins, référencés en chemins relatifs.</p>
  <p>Ouvrir <code>attempts/&lt;tentative&gt;/trace.zip</code> reste une action externe documentée :
  <code>npx playwright show-trace &lt;chemin&gt;</code>, ou <code>trace.playwright.dev</code>.</p>
  <p>Limites : traces, vidéos et captures DOM peuvent contenir des données de la page et ne sont pas anonymisées.
  La liste d'origines autorisées est un contrôle au niveau des outils, pas un isolement réseau.</p>
  <script type="application/json" id="harness-report-data">${embedJson(view)}</script>
</footer>

</main>
</body>
</html>
`
}
