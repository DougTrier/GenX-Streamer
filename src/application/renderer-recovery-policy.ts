export interface RendererRecoveryBootstrap {
  schemaVersion: 1;
  recoveredRenderer: boolean;
}

export function validateRendererRecoveryBootstrap(value: unknown): RendererRecoveryBootstrap {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'schemaVersion') ||
    !Object.hasOwn(value, 'recoveredRenderer') ||
    (value as RendererRecoveryBootstrap).schemaVersion !== 1 ||
    typeof (value as RendererRecoveryBootstrap).recoveredRenderer !== 'boolean'
  )
    throw new Error('Renderer recovery status is unavailable.');
  return {
    schemaVersion: 1,
    recoveredRenderer: (value as RendererRecoveryBootstrap).recoveredRenderer,
  };
}

/** Session-local consent: persisted update preferences are never rewritten by recovery. */
export function createRendererRecoveryPolicy(read: () => Promise<unknown>) {
  let status: 'pending' | 'ordinary' | 'recovered' | 'unavailable' = 'pending';
  let explicitlyAuthorized = false;
  let initialization: Promise<void> | undefined;
  return {
    initialize(): Promise<void> {
      initialization ??= Promise.resolve()
        .then(read)
        .then((value) => {
          status = validateRendererRecoveryBootstrap(value).recoveredRenderer
            ? 'recovered'
            : 'ordinary';
        })
        .catch(() => {
          status = 'unavailable';
        });
      return initialization;
    },
    allowAutomaticWork(): boolean {
      return status !== 'pending' && (status === 'ordinary' || explicitlyAuthorized);
    },
    authorize(intent: 'scan' | 'refresh' | 'update-settings'): void {
      if (status === 'pending' || !['scan', 'refresh', 'update-settings'].includes(intent)) return;
      explicitlyAuthorized = true;
    },
    status(): 'pending' | 'ordinary' | 'recovered' | 'unavailable' {
      return status;
    },
  };
}
