/** Operator-approved configuration, deployed with the Worker. No runtime credentials. */
export interface RepositoryMapping {
  readonly slot: string;
  readonly client: string;
  readonly project: string;
  readonly environment: string;
  readonly repositoryId: number;
  /** The repository's reviewed `owner/name`, for trusted issue links in notifications only; never authority. */
  readonly repository?: string;
  /** Required to deliver; omit only while a Slot is not approved for delivery. */
  readonly githubInstallationId?: number;
  readonly clientOriginLabel?: string;
  readonly defaultDeveloper: string;
  /** How the Slot's plugin is deployed, once reviewed; unset is reported as unknown. */
  readonly deployment?: DeploymentMethod;
  /** The reviewed team responsible for the installation; unset is reported as unknown. */
  readonly responsibleTeam?: string;
}

/** Central site deployment tooling, the private native updater, or a manual install. */
export type DeploymentMethod = "central" | "native" | "manual";

export type DeployedStage = "staging" | "prod";

/**
 * Reviewed mappings for each deployed stage. Add real mappings by reviewed PR.
 * A stage's Worker sees only its own list, so a staging Slot never reaches
 * production, where its repository is outside the production App.
 */
export const stageMappings: Readonly<Record<DeployedStage, readonly RepositoryMapping[]>> = {
  staging: [
    // Synthetic content only (#57): the suspension drill makes the sandbox public for a few minutes.
    { slot: "gq-support-sandbox/staging", client: "getquick", project: "gq-support-sandbox", environment: "staging",
      repositoryId: 1424354303, repository: "Quick-Release/gq-support-sandbox", githubInstallationId: 172696674, clientOriginLabel: "client-support", defaultDeveloper: "vvaz" },
  ],
  prod: [],
};

/** Deployment pins each stage's App slug (deploy/github-app.ts). */
const STAGE_BY_SLUG: Readonly<Record<string, DeployedStage>> = { "getquick-support-staging": "staging", "getquick-support": "prod" };

/** The deployed stage a pinned App slug belongs to; any other slug, including none, has none. */
export const stageForSlug = (slug: string): DeployedStage | null => Object.hasOwn(STAGE_BY_SLUG, slug) ? STAGE_BY_SLUG[slug]! : null;

/** The mappings for the Worker's own stage. Any other slug, including none, gets no mappings. */
export const mappingsForSlug = (slug: string): readonly RepositoryMapping[] => {
  const stage = stageForSlug(slug);
  return stage ? stageMappings[stage] : [];
};

export const mappingFor = (mappings: readonly RepositoryMapping[], slot: string) =>
  mappings.find((mapping) => mapping.slot === slot);

/** Every Slot mapped to the repository, which a repository failure affects together. */
export const slotsOf = (mappings: readonly RepositoryMapping[], repositoryId: number) =>
  mappings.filter((mapping) => mapping.repositoryId === repositoryId).map((mapping) => mapping.slot);
