import { Children, isValidElement, createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ dispatch }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
import { ApprovalCard } from "./ApprovalCard";
import { pendingApprovals, PendingApprovalActions } from "./PendingApproval";
import { answerResponse } from "@/lib/card-answer";
const message: Message = { id: "page-card", role: "bot", kind: "options", at: 1,
  card: { title: "Save this page?", subtitle: "Review title\n\nComplete draft", tool: "propose_page", requestId: "request",
    options: ["Save page", "Cancel"], pageRequest: { botId: "bot", proposalId: "proposal", title: "Review title" } } };
type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] { if (!isValidElement(value)) return []; const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)]; }
describe("reviewed page card", () => {
  it("uses the existing composer actions and offers Save page / Cancel without remembered permission", () => {
    const pending = pendingApprovals([message])[0]!;
    const tree = PendingApprovalActions({ pending, threadId: "thread", onCancelTurn: vi.fn() });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Save page"); expect(html).toContain("Cancel");
    expect(html).not.toContain("Cancel turn"); expect(html).not.toContain("Always allow");
    const buttons = nodes(tree).filter((node) => node.type === "button");
    buttons.find((node) => node.props.children === "Save page")!.props.onClick!();
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "thread", requestId: "request", behavior: "allow" }));
    buttons.find((node) => node.props.children === "Cancel")!.props.onClick!();
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "deny" }));
  });
  it("renders the settled document link and cancels a generic option answer safely", () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, { message: { ...message, card: { ...message.card!, answered: "allow", pageRequest: { ...message.card!.pageRequest!, pageId: "saved" } } } }));
    expect(html).toContain('#/pages/saved'); expect(html).toContain("Page saved");
    expect(answerResponse(message.card!, "Cancel")).toEqual({ behavior: "deny" });
    expect(answerResponse(message.card!, "Save page")).toEqual({ behavior: "allow" });
  });
});
