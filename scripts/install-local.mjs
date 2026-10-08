// Bootstrap against an unpublished Machines checkout without saving local paths.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const machines = resolve(process.argv[2] ?? join(root, "../machines"));
const temp = await mkdtemp(join(tmpdir(), "machines-dispatch-dependency-"));
try {
  execFileSync("npm", ["run", "build"], { cwd: machines, stdio: "inherit" });
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
      { cwd: machines, encoding: "utf8" },
    ),
  )[0];
  execFileSync(
    "npm",
    [
      "install",
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      join(temp, packed.filename),
    ],
    { cwd: root, stdio: "inherit" },
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
