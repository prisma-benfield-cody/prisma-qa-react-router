/**
 * Build a slim .output/ for Prisma Compute (Bun runtime, ~256MB artifact cap).
 * Mirrors Docker production layout: build/ + prod node_modules + server.mjs.
 * Paths resolve from import.meta.url — Compute's process.cwd() is outside the upload.
 */
import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".output");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!existsSync(join(root, "build", "server", "index.js"))) {
  console.error("Missing build/. Run `bun run build` first.");
  process.exit(1);
}

cpSync(join(root, "build"), join(out, "build"), { recursive: true });
if (existsSync(join(root, "public"))) {
  cpSync(join(root, "public"), join(out, "public"), { recursive: true });
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Only ship React Router runtime deps — never Composer/alchemy (256MB artifact cap).
const runtimeDeps = Object.fromEntries(
  Object.entries(pkg.dependencies || {}).filter(([name]) =>
    !name.startsWith("@prisma/") && name !== "alchemy" && name !== "prisma"
  ),
);
const outPkg = {
  name: "qa-react-router",
  private: true,
  type: "module",
  dependencies: runtimeDeps,
};
writeFileSync(join(out, "package.json"), JSON.stringify(outPkg, null, 2) + "\n");

// Entry must set NODE_ENV BEFORE importing React (ESM import hoist).
// Compute may leave NODE_ENV unset; Bun then loads react.development.js and SSR crashes.
writeFileSync(
  join(out, "server.mjs"),
  `process.env.NODE_ENV = process.env.NODE_ENV || "production";
await import("./server-app.mjs");
`,
);

writeFileSync(
  join(out, "server-app.mjs"),
  `import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import morgan from "morgan";
import sourceMapSupport from "source-map-support";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const buildPath = path.join(__dirname, "build", "server", "index.js");
const assetsDir = path.join(__dirname, "build", "client");
const publicDir = path.join(__dirname, "public");

sourceMapSupport.install({
  retrieveSourceMap(source) {
    if (source.startsWith("file://")) {
      const sourceMapPath = \`\${url.fileURLToPath(source)}.map\`;
      if (fs.existsSync(sourceMapPath)) {
        return { url: source, map: fs.readFileSync(sourceMapPath, "utf8") };
      }
    }
    return null;
  },
});

const buildModule = await import(url.pathToFileURL(buildPath).href);
const port = Number(process.env.PORT) || 3000;

const app = express();
app.disable("x-powered-by");
app.use(compression());
app.use(
  "/assets",
  express.static(path.join(assetsDir, "assets"), { immutable: true, maxAge: "1y" }),
);
app.use(express.static(assetsDir));
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, { maxAge: "1h" }));
}
app.use(morgan("tiny"));
app.all("/{*splat}", createRequestHandler({
  build: buildModule,
  mode: process.env.NODE_ENV,
}));

const server = app.listen(port, () => {
  console.log(\`[qa-react-router] listening on :\${port} NODE_ENV=\${process.env.NODE_ENV} cwd=\${process.cwd()} root=\${__dirname}\`);
});
["SIGTERM", "SIGINT"].forEach((signal) => {
  process.once(signal, () => server?.close(console.error));
});
`,
);

const install = spawnSync("bun", ["install"], {
  cwd: out,
  stdio: "inherit",
  env: process.env,
});
if (install.status !== 0) {
  const npm = spawnSync("npm", ["install", "--omit=dev"], {
    cwd: out,
    stdio: "inherit",
    env: process.env,
  });
  if (npm.status !== 0) process.exit(npm.status ?? 1);
}

console.log("Prepared .output/");
spawnSync("du", ["-sh", out], { stdio: "inherit" });
