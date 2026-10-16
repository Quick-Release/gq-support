/** Operator-approved configuration, deployed with the Worker. No runtime credentials. */
export interface RepositoryMapping {
  readonly slot: string;
  readonly client: string;
  readonly project: string;
  readonly environment: string;
  readonly repositoryId: number;
  readonly defaultDeveloper: string;
}

// Add real mappings by reviewed PR. No installation is approved by default.
export const repositoryMappings: readonly RepositoryMapping[] = [];

export const mappingFor = (mappings: readonly RepositoryMapping[], slot: string) =>
  mappings.find((mapping) => mapping.slot === slot);
