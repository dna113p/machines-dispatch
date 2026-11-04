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
  /**
   * Why Dispatch stopped a non-completed attempt, for the ticket's note. Set
   * only when a claim was lost; sources without claims never receive it.
   */
  readonly reason?: string;
}
/** Who holds a claim: one daemon state directory, one attempt, one computer. */
export interface Holder {
  readonly daemon: string;
  readonly attempt: string;
  readonly host: string;
}
/** A held claim. JSON, so an attempt can persist it across restarts. */
export interface Lease {
  readonly scope: string;
  readonly key: string;
  readonly holder: Holder;
  readonly expiresAt: string;
  /** How long one acquisition or renewal lasts; renew before half of it is left. */
  readonly ttlMs: number;
  /** Whatever the store needs to recognise its own record. */
  readonly data?: JsonValue;
}
export interface ClaimRequest {
  /** The claim identity: `${source.id}/${item.label}`. */
  readonly scope: string;
  /** The request identity, `item.key`. */
  readonly key: string;
  readonly holder: Holder;
  /** An explicit retry ignores finished keys but still respects a live lease. */
  readonly retry: boolean;
}
export type Acquisition =
  | { readonly acquired: true; readonly lease: Lease }
  | {
      readonly acquired: false;
      readonly holder?: Holder;
      readonly expiresAt?: string;
      /** The key was finished by an earlier holder. */
      readonly finished?: boolean;
    };
export type Renewal =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly reason: "lost"; readonly holder?: Holder };
/**
 * Shared admission across daemons, so at most one runs a ticket at a time and
 * a finished request does not run again elsewhere. Network errors throw.
 */
export interface ClaimStore {
  acquire(claim: ClaimRequest): Promise<Acquisition>;
  renew(lease: Lease): Promise<Renewal>;
  /** Records the lease's key as finished and ends the lease. Throws `ClaimLost` when another holder has it. */
  finish(lease: Lease): Promise<void>;
  /** Ends the lease without recording its key as finished. */
  abandon(lease: Lease): Promise<void>;
}
/** The store no longer names this lease; another holder took the claim. */
export class ClaimLost extends Error {
  readonly holder?: Holder;
  constructor(holder?: Holder) {
    super(
      holder
        ? `Claim lost to ${holder.host}; another computer took this ticket`
        : "Claim lost; another computer took this ticket",
    );
    this.holder = holder;
  }
}
/** Implementations own eligibility and tracker-specific interpretation of output. */
export interface WorkSource {
  readonly id: string;
  scan(): Promise<SourceScan>;
  prepare(item: WorkItem): Promise<LaunchRequest | undefined>;
  apply(report: WorkReport): Promise<void>;
  /** Optional cross-computer admission. Without it, only this state directory deduplicates. */
  readonly claims?: ClaimStore;
}
/** A permanent conflict or invalid result needs intervention, not repeated writes. */
export class ReportConflict extends Error {}
export type AttemptStatus =
  | "starting"
  | "running"
  | "waiting"
  | "sleeping"
  | "continued-outside"
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
  /** A stopped run awaiting the next startup's recovery decision. */
  cutOff?: true;
  /** Automatic restart continuations already claimed for this attempt. */
  continued?: number;
  runStatusDir?: string;
  sleeping?: MachineHostResult["sleeping"];
  wakeError?: string;
  cannotSleep?: string;
  state?: MachineHostResult["state"];
  result?: MachineHostResult;
  note?: string;
  error?: string;
  delivery: "none" | "pending" | "applied" | "conflict";
  deliveryError?: string;
  claim?: AttemptClaim;
  /** Why an attempt from before claims were enabled was not resumed; becomes the report's reason. */
  claimRefused?: string;
}
export interface AttemptClaim {
  lease: Lease;
  /**
   * held: renewed while the attempt runs, sleeps or awaits writeback.
   * finishing: the attempt is settled; its key is being recorded as finished.
   * done: finished. lost: another holder took it; never finished by this one.
   */
  state: "held" | "finishing" | "done" | "lost";
  lostTo?: Holder;
  /** Set when losing the claim stopped the attempt; becomes the report's reason. */
  reason?: string;
  /** The last renew or finish error, cleared by the next success. */
  error?: string;
}
export function active(status: AttemptStatus): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "waiting" ||
    status === "sleeping"
  );
}
