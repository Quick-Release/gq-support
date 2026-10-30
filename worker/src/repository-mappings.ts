/** Operator-approved configuration, deployed with the Worker. No runtime credentials. */
export interface RepositoryMapping {
  readonly slot: string;
  readonly client: string;
  readonly project: string;
  readonly environment: string;
  readonly repositoryId: number;
  /** Required to deliver; omit only while a Slot is not approved for delivery. */
  readonly githubInstallationId?: number;
  readonly clientOriginLabel?: string;
  readonly defaultDeveloper: string;
}

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
      repositoryId: 1424354303, githubInstallationId: 172696674, clientOriginLabel: "client-support", defaultDeveloper: "vvaz" },
  ],
  prod: [],
};

/** Deployment pins each stage's App slug (deploy/github-app.ts). */
const STAGE_BY_SLUG: Readonly<Record<string, DeployedStage>> = { "getquick-support-staging": "staging", "getquick-support": "prod" };

/** The mappings for the Worker's own stage. Any other slug, including none, gets no mappings. */
export const mappingsForSlug = (slug: string): readonly RepositoryMapping[] =>
  Object.hasOwn(STAGE_BY_SLUG, slug) ? stageMappings[STAGE_BY_SLUG[slug]!] : [];

export const mappingFor = (mappings: readonly RepositoryMapping[], slot: string) =>
  mappings.find((mapping) => mapping.slot === slot);

/** Every Slot mapped to the repository, which a repository failure affects together. */
export const slotsOf = (mappings: readonly RepositoryMapping[], repositoryId: number) =>
  mappings.filter((mapping) => mapping.repositoryId === repositoryId).map((mapping) => mapping.slot);
