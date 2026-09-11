/**
 * Per-attempt state shared between the `authenticated-workspace` fixture and the
 * `project-unique-in-storage` check.
 *
 * It deliberately does NOT travel through the fixture's `public` values: everything returned in
 * `public` is interpolated into the scenario body and the criteria, and therefore reaches the
 * model. The workspace id is a probe coordinate for the reserved `/__probe/projects` endpoint —
 * the browsing agent must never see it. Both the fixture and the check are trusted project code
 * loaded into the same harness process, so a module-level map is the narrowest channel available.
 */

export interface SeededWorkspace {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly email: string
}

const byAttempt = new Map<string, SeededWorkspace>()

const key = (runId: string, attemptId: string): string => `${runId}/${attemptId}`

export const rememberWorkspace = (
  runId: string,
  attemptId: string,
  workspace: SeededWorkspace
): void => {
  byAttempt.set(key(runId, attemptId), workspace)
}

export const lookupWorkspace = (runId: string, attemptId: string): SeededWorkspace | undefined =>
  byAttempt.get(key(runId, attemptId))

export const forgetWorkspace = (runId: string, attemptId: string): void => {
  byAttempt.delete(key(runId, attemptId))
}
