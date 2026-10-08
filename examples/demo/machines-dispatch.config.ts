import type { Configuration } from "@dna113p/machines-dispatch";
export default (({ tk }) => [
  tk({ id: "demo", cwd: ".", defaultMachine: "research" }),
]) satisfies Configuration;
