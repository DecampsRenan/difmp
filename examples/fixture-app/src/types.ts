/**
 * Public types for the fixture app.
 *
 * The fixture app is a deliberately tiny "Projects" web app used as the target
 * of the agent-driven E2E harness. Each variant is a reproducible behaviour of
 * the same app, selected per server instance.
 */

/** The four reproducible behaviours of the fixture app. */
export type Variant = "healthy" | "create-500" | "false-success" | "alt-layout";

export const VARIANTS = [
  "healthy",
  "create-500",
  "false-success",
  "alt-layout",
] as const satisfies readonly Variant[];

export const isVariant = (value: unknown): value is Variant =>
  typeof value === "string" && (VARIANTS as readonly string[]).includes(value);

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly workspaceId: string;
  /** Not part of the conceptual model; needed so the login page can work. */
  readonly passwordHash: string;
}

export interface Session {
  readonly token: string;
  readonly userId: string;
}

export interface Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: string;
}

/** Optional workspace/user/session created at startup, before any HTTP call. */
export interface SeedInput {
  readonly workspaceName?: string;
  readonly email?: string;
  readonly password?: string;
  /** Project names created up-front in the seeded workspace. */
  readonly projects?: readonly string[];
}

/** What `POST /__seed/workspace` returns (and what the startup seed produces). */
export interface SeedResult {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  readonly sessionToken: string;
}

export interface ProbeResult {
  readonly count: number;
  readonly projects: readonly Project[];
}

export interface FixtureAppOptions {
  /** Default 0 → ephemeral port, so parallel tests never collide. */
  readonly port?: number;
  /** Explicit variant wins over `FIXTURE_APP_VARIANT`; default "healthy". */
  readonly variant?: Variant;
  /** Create a workspace + user + session before the server starts listening. */
  readonly seed?: SeedInput;
  /** Enables `POST /__seed/workspace` and `GET /__probe/projects`. Default true. */
  readonly seedEnabled?: boolean;
  /** Shared secret for the `x-seed-token` header. Random hex when omitted. */
  readonly seedToken?: string;
  /** When set, the store is mirrored to `<persistDir>/fixture-app-store.json`. */
  readonly persistDir?: string;
}

export interface FixtureAppHandle {
  readonly url: string;
  readonly port: number;
  readonly variant: Variant;
  readonly seedEnabled: boolean;
  /** Value to send as `x-seed-token` on the test-only endpoints. */
  readonly seedToken: string;
  /** Present only when `options.seed` was provided. */
  readonly initialSeed?: SeedResult | undefined;
  /** Test-only helper: same contract as `POST /__seed/workspace`. */
  seedWorkspace(input?: SeedInput): Promise<SeedResult>;
  /** Test-only helper: same contract as `GET /__probe/projects`. */
  probeProjects(query: {
    readonly workspaceId: string;
    readonly name?: string;
  }): Promise<ProbeResult>;
  close(): Promise<void>;
}
