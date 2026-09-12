import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

describe("TypeScript config loading", () => {
  it("loads a non-erasable config in an explicitly CommonJS consumer on Node 22", async () => {
    const loader = pathToFileURL(resolve(here, "../src/configModule.ts")).href;
    const config = resolve(here, "fixtures/commonjs-config/difmp.config.ts");
    const program = `
      import { importConfigModule } from ${JSON.stringify(loader)};
      const config = await importConfigModule(${JSON.stringify(config)});
      process.stdout.write(JSON.stringify(config));
    `;

    // A separate, uninstrumented Node process is important here. Vitest's transform hooks make
    // tsx detect a global loader and avoid the Node 22 code path that caused the regression.
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", program],
      { cwd: resolve(here, "fixtures/commonjs-config") },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      inputs: { commonjsConfig: "loaded-from-commonjs" },
    });
  });
});
