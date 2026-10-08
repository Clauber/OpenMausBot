import type { Response } from "express";

export function sendTabNotFound(res: Response, id: string): void {
  res.status(404).json({ error: "tab_not_found", id });
}

export function sendBadRequest(res: Response, reason: string): void {
  res.status(400).json({ error: "bad_request", reason });
}

export function sendInternal(res: Response, message: string): void {
  res.status(500).json({ error: "internal", message });
}
