import type { Fixture, FixtureResult, StorageStateLike } from "@difmp/core";
import type { SeedResult } from "@difmp/fixture-app";
import { forgetWorkspace, rememberWorkspace } from "./attempt-state.js";

/**
 * The fixture app mints a fresh `x-seed-token` per server instance and prints it (`--seed`) or
 * returns it as `handle.seedToken`. It is a secret: it is read from the environment through
 * `ctx.secrets`, never declared as an input, never interpolated into the scenario, never logged.
 */
export const seedTokenEnvVar = "FIXTURE_APP_SEED_TOKEN";

/** Name of the session cookie set by the fixture app (see its README, "Auth"). */
const sessionCookieName = "sid";

const redactToken = (message: string, token: string): string =>
  token.length === 0 ? message : message.replaceAll(token, "[redacted]");

/**
 * Spec §4's `authenticated-workspace`: an isolated workspace + user + active session, prepared
 * through the fixture app's guarded seed API rather than through the UI — the scenario tests the
 * business journey, not the login.
 *
 * Returns the workspace name as a PUBLIC value (`{{ fixture.workspaceName }}`, visible to the
 * model) and the session cookie as a PRIVATE `storageState` (handed to the browser context only).
 * The session token is never part of `public`, so it can never reach a prompt or a report.
 */
export const authenticatedWorkspace: Fixture = async (ctx): Promise<FixtureResult> => {
  const seedToken = ctx.secrets(seedTokenEnvVar);
  if (seedToken === undefined || seedToken.trim() === "") {
    throw new Error(
      `authenticated-workspace: ${seedTokenEnvVar} is not set. The seed token is a secret and comes ` +
        "from the environment, never from an input. Start the fixture app with --seed and export the " +
        "token it prints.",
    );
  }

  const base = new URL(ctx.baseUrl);
  // Per-attempt tenant: a shared workspace would not be data isolation (spec §4).
  const workspaceName = `Workspace ${ctx.runId}-${ctx.attemptId}`;
  const email = `agent-${ctx.runId}-${ctx.attemptId}@example.test`;

  const response = await fetch(new URL("/__seed/workspace", base), {
    method: "POST",
    headers: { "content-type": "application/json", "x-seed-token": seedToken },
    body: JSON.stringify({ workspaceName, email }),
  }).catch((cause: unknown) => {
    throw new Error(
      `authenticated-workspace: cannot reach the seed API at ${base.origin}: ` +
        redactToken(cause instanceof Error ? cause.message : String(cause), seedToken),
    );
  });

  if (!response.ok) {
    // 403 = wrong token, 404 = the app was started with seedEnabled: false. Never echo the body
    // verbatim into the message without redaction.
    const body = await response.text().catch(() => "");
    throw new Error(
      `authenticated-workspace: POST /__seed/workspace answered HTTP ${response.status} — ` +
        redactToken(body.slice(0, 200), seedToken),
    );
  }

  const seed = (await response.json()) as SeedResult;

  // --- ACQUISITION → CLEANUP, immediately and per resource -------------------------------------
  // Everything below can still fail; each cleanup is registered the moment its resource exists so
  // a half-prepared attempt is still torn down.

  rememberWorkspace(ctx.runId, ctx.attemptId, {
    workspaceId: seed.workspaceId,
    workspaceName: seed.workspaceName,
    email: seed.email,
  });
  ctx.addCleanup(() => {
    forgetWorkspace(ctx.runId, ctx.attemptId);
  });

  ctx.addCleanup(async () => {
    // Revoking the session is the only destructive operation the fixture app exposes over HTTP;
    // the workspace itself lives in a per-process store and is abandoned with the server. See
    // README.md, "What cleanup can and cannot do".
    await fetch(new URL("/logout", base), {
      method: "GET",
      headers: { cookie: `${sessionCookieName}=${seed.sessionToken}` },
      redirect: "manual",
    });
  });

  // Fail fast, and inside the fixture, if the session does not actually authenticate: otherwise
  // the agent silently lands on the login page and every criterion becomes a mystery.
  const probe = await fetch(new URL("/", base), {
    headers: { cookie: `${sessionCookieName}=${seed.sessionToken}` },
  });
  const page = await probe.text();
  if (!probe.ok || !page.includes(`id="workspace-name"`)) {
    throw new Error(
      `authenticated-workspace: the seeded session did not open the workspace home ` +
        `(HTTP ${probe.status}); the app answered the sign-in page instead.`,
    );
  }

  const storageState: StorageStateLike = {
    cookies: [
      {
        name: sessionCookieName,
        value: seed.sessionToken,
        domain: base.hostname,
        path: "/",
        // -1 → a session cookie, exactly like the one POST /login sets.
        expires: -1,
        httpOnly: true,
        secure: base.protocol === "https:",
        sameSite: "Lax",
      },
    ],
    origins: [],
  };

  return {
    // PUBLIC: interpolated as {{ fixture.workspaceName }} and visible to the model.
    public: { workspaceName: seed.workspaceName },
    // PRIVATE: browser context only. Never interpolated, never prompted, never reported.
    storageState,
  };
};
