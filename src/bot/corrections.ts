import { TMDBMeta } from './tmdb';

export interface PendingStagingItem {
  id: string;
  sourceChannelId: string;
  sourceMessageId: number;
  originalFileName: string;
  fileSize: number;
  category: string;
  parsedTitle: string;
  parsedYear?: number;
  issue: string;
  createdAt: number;
}

export interface PendingAnnounceItem {
  id: string;
  fileData: any;
  issue: string;
  createdAt: number;
}

export interface AdminCorrectionSession {
  type: 'staging' | 'announcement';
  correctionId: string;
  category: string;
}

const pendingStaging = new Map<string, PendingStagingItem>();
const pendingAnnounce = new Map<string, PendingAnnounceItem>();
const adminSessions = new Map<string, AdminCorrectionSession>();

export function createStagingCorrection(item: Omit<PendingStagingItem, 'id' | 'createdAt'>): PendingStagingItem {
  const id = `stg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const record: PendingStagingItem = {
    ...item,
    id,
    createdAt: Date.now(),
  };
  pendingStaging.set(id, record);
  return record;
}

export function getStagingCorrection(id: string): PendingStagingItem | undefined {
  return pendingStaging.get(id);
}

export function removeStagingCorrection(id: string): boolean {
  return pendingStaging.delete(id);
}

export function createAnnounceCorrection(fileData: any, issue: string): PendingAnnounceItem {
  const id = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const record: PendingAnnounceItem = {
    id,
    fileData,
    issue,
    createdAt: Date.now(),
  };
  pendingAnnounce.set(id, record);
  return record;
}

export function getAnnounceCorrection(id: string): PendingAnnounceItem | undefined {
  return pendingAnnounce.get(id);
}

export function removeAnnounceCorrection(id: string): boolean {
  return pendingAnnounce.delete(id);
}

export function setAdminSession(adminId: string, session: AdminCorrectionSession) {
  adminSessions.set(adminId, session);
}

export function getAdminSession(adminId: string): AdminCorrectionSession | undefined {
  return adminSessions.get(adminId);
}

export function clearAdminSession(adminId: string): boolean {
  return adminSessions.delete(adminId);
}
