// Bundles a Node service (api or worker) into a single dist/index.js that runs with no node_modules,
// which keeps the Docker image small and avoids workspace resolution surprises in production.
import { build } from "esbuild";

const [entry = "src/server.ts"] = process.argv.slice(2);

await build({
  entryPoints: [entry],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  // Optional native bindings we never use, and the TypeScript compiler that graphile-config can load
  // lazily for .ts preset files (we pass configuration in code instead).
  external: ["pg-native", "typescript"],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_ } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirname_(__filename);",
    ].join(" "),
  },
});
