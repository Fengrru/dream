export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(public readonly nodeId: string) {
    super(`memory node not found: ${nodeId}`);
  }
}

/** Raised when a rewrite is attempted outside the reconsolidation window. */
export class ReconsolidationWindowClosedError extends DomainError {
  constructor(public readonly nodeId: string) {
    super(
      `reconsolidation window closed for ${nodeId}: the memory was not recalled recently; ` +
        `encode a new node linked to it instead.`,
    );
  }
}

/** Raised when a mutation targets a record that already has a newer version. */
export class SupersededMemoryError extends DomainError {
  constructor(public readonly nodeId: string, public readonly supersededBy: string) {
    super(`memory ${nodeId} was superseded by ${supersededBy}; mutate the latest version instead.`);
  }
}

/** Raised when a plugin uses a memory capability it did not declare. */
export class PolicyViolationError extends DomainError {
  constructor(pluginId: string, capability: string) {
    super(
      `plugin "${pluginId}" attempted memory op "${capability}" without declaring that capability (deny-by-default).`,
    );
  }
}
