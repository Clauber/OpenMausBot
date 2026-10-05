/** Markdown storage stays independent of the editor used by each client. */
export interface Page {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: string;
  revision: number;
  sourceThreadId: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface PageDraft {
  revision: number;
  title: string;
  content: string;
  spaceId?: string;
  parentId?: string | null;
}
export interface PageRequestCardData {
  botId: string;
  proposalId: string;
  title: string;
  pageId?: string;
}
