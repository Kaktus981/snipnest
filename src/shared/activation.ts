import { hostPermissionPattern } from "./logic";

const PENDING_ACTIVATION_TTL_MS = 5 * 60 * 1000;

export interface PendingSiteActivation {
  origin: string;
  tabId: number;
  windowId: number;
  createdAt: number;
  expiresAt: number;
}

export function createPendingActivation(
  origin: string,
  tabId: number,
  windowId: number,
  now = Date.now()
): PendingSiteActivation {
  return {
    origin: new URL(origin).origin,
    tabId,
    windowId,
    createdAt: now,
    expiresAt: now + PENDING_ACTIVATION_TTL_MS
  };
}

export function isPendingActivationValid(
  activation: PendingSiteActivation,
  now = Date.now()
): boolean {
  return activation.expiresAt > now;
}

export function permissionCoversActivation(
  activation: PendingSiteActivation,
  grantedOrigins: string[]
): boolean {
  return grantedOrigins.includes(hostPermissionPattern(activation.origin));
}
