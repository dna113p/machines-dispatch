import type { Configuration } from "@dna113p/machines-dispatch";
// The demo stays offline; without this line the daemon asks npm for a newer Machines.
export const update = "off";
export default (({ tk }) => [
  tk({ id: "demo", cwd: ".", defaultMachine: "research" }),
]) satisfies Configuration;
