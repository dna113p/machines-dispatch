import type { JsonValue } from "@dna113p/machines";
import type { PrepareMachineRunOptions } from "@dna113p/machines/launcher";
import type {
  HostedHumanRequest,
  MachineHostResult,
} from "@dna113p/machines/host";
export type { JsonValue } from "@dna113p/machines";

export interface WorkItem {
  readonly key: string;
  /** Additional keys consumed by this attempt. Explicit retries bypass them. */
  readonly supersedes?: readonly string[];
  readonly label: string;
  readonly ref: JsonValue;
}
export interface SourceScan {
  readonly items: readonly WorkItem[];
  readonly issues?: readonly string[];
}
export interface LaunchRequest extends PrepareMachineRunOptions {
  readonly cwd: string;
  /** What the run is for, in its published run status. The work item's label when absent. */
  readonly label?: string;
}
export interface WorkReport {
  readonly attemptId: string;
  readonly item: WorkItem;
  readonly status: "completed" | "failed" | "cancelled" | "interrupted";
  readonly result?: MachineHostResult;
  readonly error?: string;
}
/** Implementations own eligibility and tracker-specific interpretation of output. */
export interface WorkSource {
  readonly id: string;
  scan(): Promise<SourceScan>;
  prepare(item: WorkItem): Promise<LaunchRequest | undefined>;
  apply(report: WorkReport): Promise<void>;
}
/** A permanent conflict or invalid result needs intervention, not repeated writes. */
export class ReportConflict extends Error {}
export type AttemptStatus =
  | "starting"
  | "running"
  | "waiting"
  | "sleeping"
  | WorkReport["status"];
export interface Attempt {
  id: string;
  source: string;
  item: WorkItem;
  launch: LaunchRequest;
  status: AttemptStatus;
  startedAt: string;
  updatedAt: string;
  human?: HostedHumanRequest;
  runId?: string;
  sleeping?: MachineHostResult["sleeping"];
  wakeError?: string;
  cannotSleep?: string;
  state?: MachineHostResult["state"];
  result?: MachineHostResult;
  error?: string;
  delivery: "none" | "pending" | "applied" | "conflict";
  deliveryError?: string;
}
export function active(status: AttemptStatus): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "waiting" ||
    status === "sleeping"
  );
}
