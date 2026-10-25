export type TaughtAction = "observe" | "act" | "click" | "type" | "key" | "scroll" | "navigate";
export interface TaughtStep {
  action: TaughtAction;
  tool: string;
  args: Record<string, unknown>;
  screenshots: string[];
  error?: string;
}
export interface TaughtPlaybook {
  version: 1;
  kind: "taught";
  name: string;
  title: string;
  notes: string;
  ownerBotId: string;
  computerKind: string;
  createdAt: string;
  steps: TaughtStep[];
}
export interface TaughtRun {
  id: string;
  name: string;
  botId: string;
  threadId: string;
  computerId: string;
  sha256: string;
  status: "awaiting-approval" | "running" | "success" | "failed" | "rejected";
  startedAt: string;
  finishedAt?: string;
  failedStep?: number;
  error?: string;
  completedSteps: number;
  screenshots: string[][];
  compareScreenshots: boolean;
  stagedId?: string;
}
export interface TaughtListing {
  playbook: TaughtPlaybook;
  approved: boolean;
  runs: TaughtRun[];
}

export interface TaughtTool { name: string; inputSchema?: { properties?: Record<string, { type?: string; enum?: string[] }>; required?: string[] } }
export interface TaughtSession { id: string; title: string; computerKind: string; steps: TaughtStep[]; pending: number; tools: TaughtTool[] }
