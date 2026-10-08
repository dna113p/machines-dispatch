import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
export async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "machines-dispatch-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".machines"));
  await mkdir(join(root, ".tickets"));
  await mkdir(join(root, "home"));
  return root;
}
export async function ticket(
  root: string,
  id: string,
  fields = "",
  body = `# ${id}\n\nAcceptance criteria: verified.`,
) {
  await writeFile(
    join(root, ".tickets", `${id}.md`),
    `---\nid: ${id}\nstatus: open\ndeps: []\n${fields}---\n${body}\n`,
  );
}
export async function definition(
  root: string,
  name: string,
  action: "complete" | "hold" | "route" = "complete",
  human = false,
) {
  await writeFile(
    join(root, ".machines", `${name}.ts`),
    `
export const description = "Deterministic ${name} fixture";
export default function ({machine, operation, human, final}, input) {
  if (!input.ticket || !input.ticket.id) throw new Error("Expected ticket context");
  const outcome = ${JSON.stringify(action === "route" ? { action, machine: "implement", summary: "Investigated", input: { acceptance: "approved" } } : { action, summary: "Verified" })};
  return machine({ initial: "work", output: () => outcome, states: {
    work: operation(() => ({type:"done"}), {done:${JSON.stringify(human ? "review" : "done")}}),
    ${human ? 'review: human("Approve?", {submitted:"done"}, {choices:["yes","no"]}),' : ""}
    done: final()
  }});
}`,
  );
}
export async function until<T>(
  get: () => T | Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 15_000;
  let value: T;
  do {
    value = await get();
    if (accept(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${JSON.stringify(value)}`);
}
export const readTicket = (root: string, id: string) =>
  readFile(join(root, ".tickets", `${id}.md`), "utf8");
