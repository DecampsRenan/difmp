import {
  check,
  clickByName,
  fillByName,
  finish,
  observe,
  screenshot,
  type ScriptFactory,
  type ScriptedProviderScript,
} from "difmp/scripted";

/**
 * A consumer-owned walkthrough. The factory receives the resolved inputs and criterion ids for
 * this run, so it never needs to know generated ids in advance.
 */
export const createProject: ScriptFactory<ScriptedProviderScript> = (context) => ({
  agent: {
    id: "create-project",
    description: "create a project and capture the resulting list",
    steps: [
      { text: "Inspect the form", calls: [observe()] },
      {
        text: "Fill the project name",
        calls: [
          fillByName("Project name", String(context.inputs["projectName"] ?? "Demo project")),
        ],
      },
      { text: "Submit", calls: [clickByName("Create", { intent: "create the project" })] },
      { text: "Inspect the result", calls: [observe(), screenshot("project-created")] },
      {
        text: "Evaluate every criterion",
        calls: context.criterionIds.map((criterionId) => check(criterionId)),
      },
      { text: "Done", calls: [finish("custom walkthrough completed")] },
    ],
  },
  verdicts: {
    fallback: {
      status: "passed",
      expected: "the configured scenario criterion",
      observed: "the scripted walkthrough reached its final captured state",
      evidence: ["$all"],
    },
  },
});
