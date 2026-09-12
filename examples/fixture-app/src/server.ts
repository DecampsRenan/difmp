import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { renderHomePage, renderLoginPage } from "./html.js";
import { Store } from "./store.js";
import type { Project, SeedInput, SeedResult, Variant } from "./types.js";

const SESSION_COOKIE = "sid";
const SEED_HEADER = "x-seed-token";

export interface ServerDeps {
  readonly store: Store;
  readonly variant: Variant;
  readonly seedEnabled: boolean;
  readonly seedToken: string;
}

const readCookies = (header: string | undefined): Map<string, string> => {
  const jar = new Map<string, string>();
  if (header === undefined) return jar;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    // A stray "%" makes decodeURIComponent throw. One malformed cookie set by an
    // unrelated service on 127.0.0.1 must not 500 every route and become an
    // un-modelled fifth variant; fall back to the raw value (lossless for `sid`,
    // which is hex).
    try {
      jar.set(key, decodeURIComponent(raw));
    } catch {
      jar.set(key, raw);
    }
  }
  return jar;
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};

const sendHtml = (res: ServerResponse, status: number, html: string): void => {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
};

const redirect = (res: ServerResponse, location: string, setCookie?: string): void => {
  const headers: Record<string, string | string[]> = { location };
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  res.writeHead(302, headers);
  res.end();
};

const errorBody = (code: string, message: string): unknown => ({ error: { code, message } });

/**
 * Creates a workspace, its single user and an active session in one shot.
 * Shared by the startup `seed` option and by `POST /__seed/workspace`.
 */
export const seedWorkspace = (store: Store, input: SeedInput = {}): SeedResult => {
  const suffix = randomUUID().slice(0, 8);
  const workspaceName = input.workspaceName ?? `Workspace ${suffix}`;
  const email = input.email ?? `user-${suffix}@example.test`;
  const password = input.password ?? `pw-${randomUUID().slice(0, 12)}`;

  const workspace = store.createWorkspace(workspaceName);
  const user = store.createUser(email, password, workspace.id);
  const session = store.createSession(user.id);
  for (const name of input.projects ?? []) {
    store.createProject(workspace.id, name);
  }

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    userId: user.id,
    email: user.email,
    password,
    sessionToken: session.token,
  };
};

export const createFixtureServer = (deps: ServerDeps): Server => {
  const { store, variant, seedEnabled, seedToken } = deps;

  const currentUser = (req: IncomingMessage) => {
    const token = readCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (token === undefined) return undefined;
    const session = store.getSession(token);
    if (session === undefined) return undefined;
    return store.getUser(session.userId);
  };

  const guardTestEndpoint = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!seedEnabled) {
      sendJson(res, 404, errorBody("not_found", "Not found."));
      return false;
    }
    const provided = req.headers[SEED_HEADER];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (value !== seedToken) {
      sendJson(res, 403, errorBody("forbidden", `Missing or invalid ${SEED_HEADER} header.`));
      return false;
    }
    return true;
  };

  return createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      // ---- test-only endpoints (never linked from, or mentioned in, the UI) ----
      if (path === "/__seed/workspace" && method === "POST") {
        if (!guardTestEndpoint(req, res)) return;
        const raw = await readBody(req);
        let input: SeedInput = {};
        if (raw.trim().length > 0) {
          try {
            input = JSON.parse(raw) as SeedInput;
          } catch {
            sendJson(res, 400, errorBody("bad_request", "Body must be JSON."));
            return;
          }
        }
        sendJson(res, 201, seedWorkspace(store, input));
        return;
      }

      if (path === "/__probe/projects" && method === "GET") {
        if (!guardTestEndpoint(req, res)) return;
        const workspaceId = url.searchParams.get("workspaceId");
        if (workspaceId === null) {
          sendJson(res, 400, errorBody("bad_request", "workspaceId is required."));
          return;
        }
        const name = url.searchParams.get("name") ?? undefined;
        const projects = store.findProjects(workspaceId, name);
        sendJson(res, 200, { count: projects.length, projects });
        return;
      }

      // ---- auth ----
      if (path === "/login" && method === "POST") {
        const raw = await readBody(req);
        const form = new URLSearchParams(raw);
        const email = form.get("email") ?? "";
        const password = form.get("password") ?? "";
        const user = store.findUserByEmail(email);
        if (user === undefined || !store.checkPassword(user, password)) {
          sendHtml(res, 401, renderLoginPage({ error: "Invalid email or password." }));
          return;
        }
        const session = store.createSession(user.id);
        redirect(res, "/", `${SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Lax`);
        return;
      }

      if (path === "/logout") {
        const token = readCookies(req.headers.cookie).get(SESSION_COOKIE);
        if (token !== undefined) store.deleteSession(token);
        redirect(res, "/", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return;
      }

      // ---- app ----
      if (path === "/" && method === "GET") {
        const user = currentUser(req);
        if (user === undefined) {
          sendHtml(res, 200, renderLoginPage({ error: undefined }));
          return;
        }
        const workspace = store.getWorkspace(user.workspaceId);
        if (workspace === undefined) {
          sendHtml(res, 500, renderLoginPage({ error: "Workspace is missing." }));
          return;
        }
        sendHtml(
          res,
          200,
          renderHomePage({
            workspace,
            email: user.email,
            projects: store.listProjects(workspace.id),
            variant,
          }),
        );
        return;
      }

      if (path === "/api/projects" && (method === "GET" || method === "POST")) {
        const user = currentUser(req);
        if (user === undefined) {
          sendJson(res, 401, errorBody("unauthenticated", "Sign in first."));
          return;
        }

        if (method === "GET") {
          sendJson(res, 200, { projects: store.listProjects(user.workspaceId) });
          return;
        }

        // Variant 2: the write is always refused, with network-visible evidence.
        if (variant === "create-500") {
          sendJson(res, 500, errorBody("project_create_failed", "The project could not be saved."));
          return;
        }

        const raw = await readBody(req);
        let name = "";
        try {
          const parsed = JSON.parse(raw) as { name?: unknown };
          name = typeof parsed.name === "string" ? parsed.name.trim() : "";
        } catch {
          sendJson(res, 400, errorBody("bad_request", "Body must be JSON."));
          return;
        }
        if (name.length === 0) {
          sendJson(res, 400, errorBody("invalid_name", "A project name is required."));
          return;
        }

        // Variant 3: a perfectly plausible 201 that is never written to the store.
        if (variant === "false-success") {
          const ghost: Project = {
            id: `prj_${randomUUID()}`,
            workspaceId: user.workspaceId,
            name,
            createdAt: new Date().toISOString(),
          };
          sendJson(res, 201, ghost);
          return;
        }

        sendJson(res, 201, store.createProject(user.workspaceId, name));
        return;
      }

      sendJson(res, 404, errorBody("not_found", "Not found."));
    })().catch((cause: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, errorBody("internal_error", String(cause)));
      } else {
        res.end();
      }
    });
  });
};
