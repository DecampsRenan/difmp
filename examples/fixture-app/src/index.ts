import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import { createFixtureServer, seedWorkspace } from "./server.js";
import { Store } from "./store.js";
import {
  isVariant,
  type FixtureAppHandle,
  type FixtureAppOptions,
  type ProbeResult,
  type SeedInput,
  type SeedResult,
  type Variant,
} from "./types.js";

export {
  isVariant,
  VARIANTS,
  type FixtureAppHandle,
  type FixtureAppOptions,
  type ProbeResult,
  type Project,
  type SeedInput,
  type SeedResult,
  type Session,
  type User,
  type Variant,
  type Workspace,
} from "./types.js";

const HOST = "127.0.0.1";

/**
 * Resolves the variant: the explicit option wins, then `FIXTURE_APP_VARIANT`,
 * then "healthy". An unknown env value is a hard error rather than a silent
 * fallback, so a typo in a test matrix cannot quietly run the healthy app.
 */
export const resolveVariant = (
  explicit: Variant | undefined,
  env: string | undefined = process.env["FIXTURE_APP_VARIANT"],
): Variant => {
  if (explicit !== undefined) return explicit;
  if (env === undefined || env.trim() === "") return "healthy";
  if (!isVariant(env)) {
    throw new Error(`FIXTURE_APP_VARIANT: unknown variant ${JSON.stringify(env)}`);
  }
  return env;
};

export const startFixtureApp = async (
  options: FixtureAppOptions = {},
): Promise<FixtureAppHandle> => {
  const variant = resolveVariant(options.variant);
  const seedEnabled = options.seedEnabled ?? true;
  const seedToken = options.seedToken ?? randomBytes(16).toString("hex");
  const store = new Store(options.persistDir);

  const initialSeed = options.seed === undefined ? undefined : seedWorkspace(store, options.seed);

  const server = createFixtureServer({ store, variant, seedEnabled, seedToken });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 only: the fixture app is never exposed on 0.0.0.0.
    server.listen(options.port ?? 0, HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://${HOST}:${port}`;

  const callTestEndpoint = async (
    path: string,
    init: { method: "GET" | "POST"; body?: string },
  ): Promise<unknown> => {
    const response = await fetch(`${url}${path}`, {
      method: init.method,
      headers:
        init.body === undefined
          ? { "x-seed-token": seedToken }
          : { "x-seed-token": seedToken, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      throw new Error(
        `${init.method} ${path} → HTTP ${response.status}: ${JSON.stringify(payload)}`,
      );
    }
    return payload;
  };

  return {
    url,
    port,
    variant,
    seedEnabled,
    seedToken,
    initialSeed,
    seedWorkspace: async (input: SeedInput = {}) =>
      (await callTestEndpoint("/__seed/workspace", {
        method: "POST",
        body: JSON.stringify(input),
      })) as SeedResult,
    probeProjects: async (query) => {
      const params = new URLSearchParams({ workspaceId: query.workspaceId });
      if (query.name !== undefined) params.set("name", query.name);
      return (await callTestEndpoint(`/__probe/projects?${params.toString()}`, {
        method: "GET",
      })) as ProbeResult;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((cause) => (cause ? reject(cause) : resolve()));
      }),
  };
};
