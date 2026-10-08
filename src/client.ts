import { request as httpRequest } from "node:http";
import { lstatSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Reuse legacy journals without moving files or opening a second daemon namespace. */
export function defaultStateDir(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const current = join(base, "machines-dispatch");
  const legacy = join(base, "auto-machines");
  const currentIdentity = directoryIdentity(current);
  const legacyIdentity = directoryIdentity(legacy);
  if (currentIdentity && legacyIdentity &&
      (currentIdentity.dev !== legacyIdentity.dev || currentIdentity.ino !== legacyIdentity.ino)) {
    throw new Error(
      "Both machines-dispatch and auto-machines state directories exist; " +
      "use --state-dir to select the existing journal explicitly. Do not merge live databases.",
    );
  }
  return currentIdentity ? current : legacyIdentity ? legacy : current;
}

function directoryIdentity(path: string): Stats | undefined {
  let entry: Stats;
  try { entry = lstatSync(path); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  // A dangling link or unreadable directory is not evidence that no journal exists.
  const directory = entry.isSymbolicLink() ? statSync(path) : entry;
  if (!directory.isDirectory()) throw new Error(`State path is not a directory: ${path}`);
  return directory;
}
export function request(
  stateDir: string,
  operation: string,
  payload: unknown = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = httpRequest(
      {
        socketPath: join(stateDir, "daemon.sock"),
        path: `/${operation}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            if (res.statusCode !== 200)
              reject(
                new Error(
                  typeof value === "object" &&
                  value !== null &&
                  "error" in value
                    ? String(value.error)
                    : "Daemon request failed",
                ),
              );
            else resolve(value);
          } catch (cause) {
            reject(cause);
          }
        });
      },
    );
    req.setTimeout(30_000, () =>
      req.destroy(
        new Error("Daemon request timed out; inspect status before retrying"),
      ),
    );
    req.once("error", reject);
    req.end(body);
  });
}
