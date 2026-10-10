export type Plan = {
  steps: string;
  criteria: string;
  verificationCommand: string;
};
export type LegacyTask = {
  id: string;
  title: string;
  goal: string;
  cwd: string;
  model: string;
  status: string;
  plan: Plan | null;
  approvedPlan: Plan | null;
  reason: string;
  verified: boolean;
  experiments: {
    id: string;
    at: string;
    hypothesis: string;
    conclusion: string;
    artifacts: string[];
    evidenceEntries: string[];
  }[];
  verifications: {
    at: string;
    command: string;
    exitCode: number;
    output: string;
    summary: string;
  }[];
  reports: { date: string; at: string; markdown: string }[];
};
export type Task = {
  id: string;
  conversationId: string;
  title: string;
  goal: string;
  cwd: string;
  model: string;
  businessStatus: string;
  executionStatus: string;
  verificationStatus: string;
  createdAt: string;
  updatedAt: string;
  legacyVerified: boolean;
  engineAvailable: boolean;
  manualReason?: string;
  acceptedAt?: string;
};
export type View = {
  entries: {
    id: string;
    kind: string;
    model?: {
      role: string;
      content:
        | string
        | { type: string; text?: string; name?: string; arguments?: unknown }[];
    }[];
  }[];
  docs: Record<string, unknown>;
};
export type Check = {
  id: string;
  url: string;
  contains?: string;
  json?: { path: string; equals: unknown };
};
export type Tool = {
  id: string;
  name: string;
  description: string;
  path: string;
  mutates: boolean;
  method?: "GET" | "POST";
};
export type Manifest = {
  schemaVersion: number;
  resources: unknown[];
  tools: Tool[];
  events: string[];
  verification: { checks: string[] };
};
export type Plugin = {
  id: string;
  name: string;
  version: string;
  description: string;
  workspace: { title: string; path: string };
  enabled: boolean;
  online: boolean;
  error: string;
  manifestUrl: string;
  manifest: Manifest;
};
export type Resource = {
  id: string;
  pluginId: string;
  name: string;
  kind: string;
  serviceId: string;
  version: string;
  environmentId: string;
  health: string;
  sampledAt: string;
  method: string;
  detail: string;
  failures: number;
  healthySamples: number;
  restartAllowed: boolean;
  checks: Check[];
};
export type Incident = {
  id: string;
  resourceId: string;
  status: string;
  openedAt: string;
  updatedAt: string;
  closedAt?: string;
  attempts: number;
  actionId: string;
  reason: string;
  verification: string;
  version: string;
  environmentId: string;
  diagnosisId?: string;
  diagnosisStatus?: string;
  diagnosisSummary?: string;
};
export type Evidence = {
  id: string;
  incidentId: string;
  resourceId: string;
  actionId: string;
  version: string;
  environmentId: string;
  at: string;
  verdict: string;
  summary: string;
  checks: {
    id: string;
    url: string;
    passed: boolean;
    detail: string;
    sampledAt: string;
  }[];
  reviewConversationId: string;
  review: string;
};
export type Worker = {
  id: string;
  role: string;
  status: string;
  lastSeen: string;
  detail: string;
};
export type Event = {
  id: string;
  at: string;
  kind: string;
  resourceId: string;
  incidentId: string;
  message: string;
};
export type Snapshot = {
  plugins: Plugin[];
  resources: Resource[];
  incidents: Incident[];
  tasks: Task[];
  workers: Worker[];
  evidence: Evidence[];
  events: Event[];
};
export const emptySnapshot: Snapshot = {
  plugins: [],
  resources: [],
  incidents: [],
  tasks: [],
  workers: [],
  evidence: [],
  events: [],
};
