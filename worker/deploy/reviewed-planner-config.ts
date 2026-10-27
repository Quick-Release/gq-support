// Reviewed SOURCE metadata only. No environment override or CLI manifest path.
// Missing live metadata is expected; importing the entry never reads a secret.
import type { ReviewedEndpoint } from "./endpoint-attestation.ts";
import type { ApprovalPolicy } from "./github-candidate-approval.ts";
import type { OwnerWindow } from "./planner-evidence.ts";
export interface ReviewedPlannerConfig {
  readonly discord: { readonly enabled: boolean };
  readonly endpoint: ReviewedEndpoint;
  readonly approval: Omit<ApprovalPolicy, "run" | "attempt" | "head">;
  readonly worker: string;
  readonly window: OwnerWindow;
  readonly app: { readonly id: number; readonly clientId: string; readonly slug: "getquick-support" | "getquick-support-staging" };
}
export const reviewedPlannerConfig: ReviewedPlannerConfig | undefined = undefined;
