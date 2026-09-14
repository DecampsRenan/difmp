import { defineConfig } from "@stylishedcoyote/difmp";
import { createProject } from "./custom-script.js";

export default defineConfig({
  baseUrl: "http://127.0.0.1:3000",
  include: ["tests/**/*.e2e.md"],
  inputs: { projectName: "Project {{ run.id }}" },
  provider: "scripted",
  scripts: { createProject },
  providerOptions: { script: "createProject" },
});
