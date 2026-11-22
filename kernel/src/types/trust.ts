export type TrustScope = 'task' | 'event';

export interface TrustGrant {
  id: string;
  recipientUserId: string;
  senderUserId: string;
  scopes: TrustScope[];
  grantedAt: string;
}

export interface PermissionRequest {
  id: string;
  recipientUserId: string;
  senderUserId: string;
  groupId: string | null;
  scopes: TrustScope[];
  reason: string | null;
  status: 'pending' | 'approved' | 'denied';
  requestedAt: string;
  resolvedAt: string | null;
}

export interface TrustGrantsResponse {
  grants: TrustGrant[];
}

export interface PermissionRequestsResponse {
  incoming: PermissionRequest[];
  outgoing: PermissionRequest[];
}

export interface TrustCandidate {
  userId: string;
  displayName: string;
  email: string | null;
  /** Names of groups this candidate shares with the current user — for context. */
  sharedGroups: string[];
}

export interface TrustCandidatesResponse {
  candidates: TrustCandidate[];
}
