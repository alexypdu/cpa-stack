export const signalExitStatuses = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const satisfies Partial<Record<NodeJS.Signals, number>>;
