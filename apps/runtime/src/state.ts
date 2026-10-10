import { defineDoc } from "@earendil-works/pi-durable";

export type Status =
  | "draft"
  | "planning"
  | "awaiting_confirmation"
  | "running"
  | "stopping"
  | "stopped"
  | "blocked"
  | "completed";
export type Plan = {
  steps: string;
  criteria: string;
  verificationCommand: string;
};
export type Experiment = {
  id: string;
  at: string;
  hypothesis: string;
  conclusion: string;
  artifacts: string[];
  evidenceEntries: string[];
};
export type Verification = {
  at: string;
  command: string;
  exitCode: number;
  output: string;
  summary: string;
  assurance?: "execution_assertion";
};
export type Report = { date: string; at: string; markdown: string };
export type Task = {
  id: string;
  title: string;
  goal: string;
  cwd: string;
  model: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
  plan: Plan | null;
  approvedPlan: Plan | null;
  experiments: Experiment[];
  verifications: Verification[];
  reports: Report[];
  reason: string;
  submissionId: string;
  verified: boolean;
};
export type Service = {
  id: string;
  name: string;
  description: string;
  url: string;
  operations: string;
};
export type Command = {
  key: string;
  hash: string;
  action: string;
  taskId: string;
  body: Record<string, string>;
  done: boolean;
};
export type Board = {
  tasks: Record<string, Task>;
  services: Record<string, Service>;
  commands: Record<string, Command>;
};
export const BoardDoc = defineDoc<Board>({
  kind: "refbox.board",
  version: 1,
  scope: "session",
  initial: () => ({ tasks: {}, services: {}, commands: {} }),
});
export const now = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function required(value: unknown, name: string, max = 20000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(400, `${name} 必须为非空字符串（最多 ${max} 字符）`);
  return value.trim();
}
