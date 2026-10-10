import { defineDoc } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";

export type DiagnosisInput = {
  incidentId: string;
  resourceId: string;
  actionId: string;
  version: string;
  environmentId: string;
  observations: JsonValue;
  context: string;
  model: string;
};
export type Diagnosis = DiagnosisInput & {
  id: string;
  conversationId: string;
  requestKey: string;
  hash: string;
  status: "running" | "completed" | "interrupted";
  summary: string;
  createdAt: string;
  updatedAt: string;
  submissionId: string;
};

// Keep platform diagnoses out of the historical board and normal task state machine.
export const DiagnosticsDoc = defineDoc<{
  records: Record<string, Diagnosis>;
  requests: Record<string, string>;
}>({
  kind: "refbox.diagnostics",
  version: 1,
  scope: "session",
  initial: () => ({ records: {}, requests: {} }),
});
