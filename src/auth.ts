import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { readJSON, writeJSON, deleteObject, userProfilePath, tokenLookupPath, usersIndexPath } from "./storage";
import type { UserProfile, UserToken, Config } from "./types";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function generateTokenValue(): string {
  return `sk-${randomBytes(32).toString("hex")}`;
}

export function tokenPrefix(token: string): string {
  return token.length > 12 ? token.slice(0, 12) + "..." : token;
}

export async function resolveUser(token: string): Promise<{ userId: string; tokenId: string } | null> {
  const h = hashToken(token);
  const entry = await readJSON<{ userId: string; tokenId: string }>(tokenLookupPath(h));
  return entry;
}

export async function autoCreateUser(
  token: string,
  name?: string
): Promise<{ userId: string; tokenId: string }> {
  const h = hashToken(token);

  const existing = await attemptClaimToken(h);
  if (existing) return existing;

  const userId = generateId("usr");
  const tokenId = generateId("tok");
  const now = new Date().toISOString();

  const userToken: UserToken = {
    id: tokenId,
    prefix: tokenPrefix(token),
    hashedToken: h,
    createdAt: now,
  };

  const profile: UserProfile = {
    id: userId,
    name: name || `auto-${userId.slice(0, 8)}`,
    active: true,
    tokens: [userToken],
    createdAt: now,
    migrated: false,
  };

  const profilePath = userProfilePath(userId);
  const tokenPath = tokenLookupPath(h);

  try {
    await writeJSON(tokenPath, { userId, tokenId }, true);
  } catch (e: any) {
    if (e.name === "PreconditionFailed") {
      const entry = await readJSON<{ userId: string; tokenId: string }>(tokenPath);
      if (entry) return entry;
    }
    throw e;
  }

  try {
    await writeJSON(profilePath, profile);
    await appendToUsersIndex(userId, profile.name, now);
  } catch (e) {
    await deleteObject(tokenPath).catch(() => {});
    throw e;
  }

  return { userId, tokenId };
}

async function attemptClaimToken(hash: string): Promise<{ userId: string; tokenId: string } | null> {
  return readJSON<{ userId: string; tokenId: string }>(tokenLookupPath(hash));
}

async function appendToUsersIndex(userId: string, name: string, createdAt: string) {
  const indexPath = usersIndexPath();
  const existing = await readJSON<Record<string, { name: string; createdAt: string; active: boolean }>>(indexPath);
  const index = existing || {};
  index[userId] = { name, createdAt, active: true };
  await writeJSON(indexPath, index);
}

export async function resolveOrCreateUser(
  token: string
): Promise<{ userId: string; tokenId: string }> {
  const existing = await resolveUser(token);
  if (existing) return existing;

  return autoCreateUser(token);
}

export function isAdminRequest(token: string, adminKey: string): boolean {
  if (!adminKey || !token) return false;
  const maxLen = Math.max(token.length, adminKey.length);
  const tBuf = Buffer.alloc(maxLen, token);
  const aBuf = Buffer.alloc(maxLen, adminKey);
  return timingSafeEqual(tBuf, aBuf);
}
