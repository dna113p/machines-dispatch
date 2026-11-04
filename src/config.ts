import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tk, type TkOptions } from "./tk.ts";
import { github, type GitHubOptions } from "./github.ts";
import { gitClaims, type GitClaimsOptions } from "./git-claims.ts";
import type { ClaimStore, WorkSource } from "./contracts.ts";
import { updateModes, type UpdateMode } from "./update.ts";
export interface ConfigurationPrimitives {
  tk: (options: TkOptions) => WorkSource;
  github: (options: GitHubOptions) => WorkSource;
  gitClaims: (options: GitClaimsOptions) => ClaimStore;
}
export type Configuration = (
  helpers: ConfigurationPrimitives,
) => readonly WorkSource[] | Promise<readonly WorkSource[]>;
async function importConfiguration(path: string) {
  const absolute = resolve(path);
  const loaded: { default?: unknown; update?: unknown } = await import(
    pathToFileURL(absolute).href
  );
  if (
    loaded.update !== undefined &&
    !updateModes.includes(loaded.update as UpdateMode)
  )
    throw new Error(
      `Configuration export "update" must be one of ${updateModes
        .map((mode) => JSON.stringify(mode))
        .join(", ")}`,
    );
  return { absolute, loaded, update: loaded.update as UpdateMode | undefined };
}
/** The optional `export const update` beside the default export. */
export async function loadUpdateMode(
  path: string,
): Promise<UpdateMode | undefined> {
  return (await importConfiguration(path)).update;
}
export async function loadConfiguration(
  path: string,
): Promise<readonly WorkSource[]> {
  const { absolute, loaded } = await importConfiguration(path);
  if (typeof loaded.default !== "function")
    throw new Error("Configuration must default-export a registration factory");
  const sources: unknown = await loaded.default({
    gitClaims: (options: GitClaimsOptions) =>
      gitClaims({ ...options, cwd: resolve(dirname(absolute), options.cwd) }),
    github: (options: GitHubOptions) =>
      github({
        ...options,
        cwd: resolve(dirname(absolute), options.cwd),
      }),
    tk: (options: TkOptions) => {
      const cwd = resolve(dirname(absolute), options.cwd);
      return tk({
        ...options,
        cwd,
        ...(options.ticketsDir === undefined
          ? {}
          : { ticketsDir: resolve(cwd, options.ticketsDir) }),
      });
    },
  });
  if (!Array.isArray(sources) || !sources.length)
    throw new Error("Configuration must return at least one source");
  for (const source of sources) {
    if (
      !source ||
      typeof source.id !== "string" ||
      !["scan", "prepare", "apply"].every(
        (name) => typeof source[name] === "function",
      )
    )
      throw new Error("Invalid source registration");
    const claims: unknown = source.claims;
    if (
      claims !== undefined &&
      (!claims ||
        typeof claims !== "object" ||
        !["acquire", "renew", "finish", "abandon"].every(
          (name) => typeof (claims as Record<string, unknown>)[name] === "function",
        ))
    )
      throw new Error(`Invalid claims for source ${source.id}`);
  }
  return sources;
}
