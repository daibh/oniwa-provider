import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

let s3Client: S3Client | null = null;

let _bucket = "";
let _region = "";

export function initStorage(bucket: string, region: string) {
  _bucket = bucket;
  _region = region;
}

function getClient(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: _region || "us-east-1" });
  }
  return s3Client;
}

function bucket(): string {
  return _bucket;
}

export async function readJSON<T>(key: string): Promise<T | null> {
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    const body = await res.Body?.transformToString();
    return body ? JSON.parse(body) as T : null;
  } catch (e: any) {
    if (e.name === "NoSuchKey") return null;
    console.error(`[storage] readJSON error (key=${key}):`, e);
    throw e;
  }
}

export async function writeJSON<T>(key: string, data: T, ifNoneMatch?: boolean): Promise<void> {
  try {
    const cmd: any = {
      Bucket: bucket(),
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    };
    if (ifNoneMatch) cmd.IfNoneMatch = "*";
    await getClient().send(new PutObjectCommand(cmd));
  } catch (e: any) {
    if (ifNoneMatch && e.name === "PreconditionFailed") throw e;
    console.error(`[storage] writeJSON error (key=${key}):`, e);
    throw e;
  }
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (e) {
    console.error(`[storage] deleteObject error (key=${key}):`, e);
    throw e;
  }
}

export async function listObjects(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  try {
    do {
      const res = await getClient().send(new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      }));
      if (res.Contents) {
        for (const obj of res.Contents) {
          if (obj.Key) keys.push(obj.Key);
        }
      }
      token = res.NextContinuationToken;
    } while (token);
    return keys;
  } catch (e) {
    console.error(`[storage] listObjects error (prefix=${prefix}):`, e);
    throw e;
  }
}

export function userProfilePath(userId: string): string {
  return `users/${userId}/profile.json`;
}

export function tokenLookupPath(tokenHash: string): string {
  return `keys/${tokenHash}.json`;
}

export function pricingPath(): string {
  return "pricing.json";
}

export function usersIndexPath(): string {
  return "users/index.json";
}

export function usagePrefix(userId: string, date?: string): string {
  if (date) return `usage/${userId}/${date}/`;
  return `usage/${userId}/`;
}
