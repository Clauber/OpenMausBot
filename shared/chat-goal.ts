export interface ChatGoal {
  id: string;
  epoch: number;
  objective: string;
  sourceMessageId: string;
  status: "active" | "paused" | "blocked" | "completed" | "stopped";
  turns: number;
  stalls: number;
  progress?: string;
  detail?: string;
  updatedAt: number;
}

export function chatGoalCommand(text: string): { action: "start"; objective: string } | { action: "status" | "pause" | "resume" | "stop" } | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const value = (match[1] ?? "").trim();
  if (!value || value.toLowerCase() === "status") return { action: "status" };
  const command = value.toLowerCase();
  if (command === "pause" || command === "resume" || command === "stop") return { action: command };
  return { action: "start", objective: value };
}
