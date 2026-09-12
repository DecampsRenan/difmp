import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Project, Session, User, Workspace } from "./types.js";

interface Snapshot {
  workspaces: Workspace[];
  users: User[];
  sessions: Session[];
  projects: Project[];
}

const emptySnapshot = (): Snapshot => ({
  workspaces: [],
  users: [],
  sessions: [],
  projects: [],
});

const hashPassword = (password: string, salt: string): string =>
  scryptSync(password, salt, 32).toString("hex");

const encodePassword = (password: string): string => {
  const salt = randomBytes(12).toString("hex");
  return `${salt}:${hashPassword(password, salt)}`;
};

const verifyPassword = (encoded: string, password: string): boolean => {
  const [salt, expected] = encoded.split(":");
  if (salt === undefined || expected === undefined) return false;
  const actual = hashPassword(password, salt);
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Authoritative server-side store.
 *
 * In-memory by default; when `persistDir` is given every mutation is mirrored
 * to a JSON file so a restarted process can pick the data back up. Either way
 * the data lives on the server, which is what makes a browser reload a
 * meaningful persistence check.
 */
export class Store {
  readonly #data: Snapshot;
  readonly #file: string | undefined;

  constructor(persistDir?: string | undefined) {
    this.#file = persistDir === undefined ? undefined : join(persistDir, "fixture-app-store.json");
    this.#data = this.#load() ?? emptySnapshot();
  }

  #load(): Snapshot | undefined {
    if (this.#file === undefined) return undefined;
    try {
      const raw = readFileSync(this.#file, "utf8");
      const parsed = JSON.parse(raw) as Partial<Snapshot>;
      return {
        workspaces: parsed.workspaces ?? [],
        users: parsed.users ?? [],
        sessions: parsed.sessions ?? [],
        projects: parsed.projects ?? [],
      };
    } catch {
      return undefined;
    }
  }

  #flush(): void {
    if (this.#file === undefined) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, `${JSON.stringify(this.#data, null, 2)}\n`, "utf8");
  }

  createWorkspace(name: string): Workspace {
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      name,
      createdAt: new Date().toISOString(),
    };
    this.#data.workspaces.push(workspace);
    this.#flush();
    return workspace;
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.#data.workspaces.find((w) => w.id === id);
  }

  createUser(email: string, password: string, workspaceId: string): User {
    const user: User = {
      id: `usr_${randomUUID()}`,
      email,
      workspaceId,
      passwordHash: encodePassword(password),
    };
    this.#data.users.push(user);
    this.#flush();
    return user;
  }

  getUser(id: string): User | undefined {
    return this.#data.users.find((u) => u.id === id);
  }

  findUserByEmail(email: string): User | undefined {
    const needle = email.trim().toLowerCase();
    return this.#data.users.find((u) => u.email.toLowerCase() === needle);
  }

  checkPassword(user: User, password: string): boolean {
    return verifyPassword(user.passwordHash, password);
  }

  createSession(userId: string): Session {
    const session: Session = {
      token: randomBytes(24).toString("hex"),
      userId,
    };
    this.#data.sessions.push(session);
    this.#flush();
    return session;
  }

  getSession(token: string): Session | undefined {
    return this.#data.sessions.find((s) => s.token === token);
  }

  deleteSession(token: string): void {
    const index = this.#data.sessions.findIndex((s) => s.token === token);
    if (index >= 0) {
      this.#data.sessions.splice(index, 1);
      this.#flush();
    }
  }

  createProject(workspaceId: string, name: string): Project {
    const project: Project = {
      id: `prj_${randomUUID()}`,
      workspaceId,
      name,
      createdAt: new Date().toISOString(),
    };
    this.#data.projects.push(project);
    this.#flush();
    return project;
  }

  listProjects(workspaceId: string): Project[] {
    return this.#data.projects
      .filter((p) => p.workspaceId === workspaceId)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Authoritative read used by the reserved probe endpoint only. */
  findProjects(workspaceId: string, name?: string | undefined): Project[] {
    const all = this.listProjects(workspaceId);
    return name === undefined ? all : all.filter((p) => p.name === name);
  }
}
