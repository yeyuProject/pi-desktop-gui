/** Inherited desktop switches must not choose a fixture's data directory or behavior. */
export function desktopTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('PI_DESKTOP_')),
    ),
    ...overrides,
  };
}
