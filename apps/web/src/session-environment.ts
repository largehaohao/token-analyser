export const SESSION_ENVIRONMENTS = [
  { id: "local", label: "本机" },
  { id: "192.168.1.102", label: "192.168.1.102" },
] as const;

export type SessionEnvironmentId = (typeof SESSION_ENVIRONMENTS)[number]["id"];

export function normalizeEnvironment(value: unknown): SessionEnvironmentId {
  return SESSION_ENVIRONMENTS.find((item) => item.id === value)?.id ?? "local";
}

export function environmentLabel(id: SessionEnvironmentId): string {
  return SESSION_ENVIRONMENTS.find((item) => item.id === id)!.label;
}
