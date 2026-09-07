import type { SearchEntityType } from "../../shared/search-events.ts";

export interface SearchEntryInput {
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  ownerId?: string | null;
  participantIds?: string[];
  deletedByUserIds?: string[];
  isPublic: boolean;
  adminOnly?: boolean;
  isActive?: boolean;
  createdAt: string;
  updatedAt: string;
}
