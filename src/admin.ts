import { Router } from "express";
import { randomBytes } from "crypto";
import { hashToken, generateTokenValue, tokenPrefix } from "./auth";
import { readJSON, writeJSON, userProfilePath, tokenLookupPath, usersIndexPath, pricingPath } from "./storage";
import { getCachedPricing, setPricingCache } from "./pricing";
import { queryMetrics } from "./metrics";
import type { UserProfile, UserToken, PricingConfig, Config, UsageQuery } from "./types";

export function createAdminRouter(config: Config) {
const router = Router();

router.post("/users", async (req, res) => {
  try {
    const { name } = req.body || {};
    const userId = `usr_${randomBytes(16).toString("hex")}`;
    const token = generateTokenValue();
    const h = hashToken(token);
    const tokenId = `tok_${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();

    const userToken: UserToken = {
      id: tokenId,
      prefix: tokenPrefix(token),
      hashedToken: h,
      createdAt: now,
    };

    const profile: UserProfile = {
      id: userId,
      name: name || `user-${userId.slice(0, 8)}`,
      active: true,
      tokens: [userToken],
      createdAt: now,
    };

    await writeJSON(userProfilePath(userId), profile);
    await writeJSON(tokenLookupPath(h), { userId, tokenId }, true);
    await appendUserToIndex(userId, profile.name, now);

    res.status(201).json({
      id: userId,
      name: profile.name,
      token,
      tokenPrefix: tokenPrefix(token),
      createdAt: now,
    });
  } catch (e) {
    console.error("[admin] POST /users error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Failed to create user" } });
  }
});

router.get("/users", async (_req, res) => {
  try {
    const index = await readJSON<Record<string, { name: string; createdAt: string; active: boolean }>>(usersIndexPath());
    if (!index) {
      res.json({ data: [] });
      return;
    }
    const users = [];
    for (const [id, info] of Object.entries(index)) {
      const profile = await readJSON<UserProfile>(userProfilePath(id));
      users.push({
        id,
        name: info.name,
        createdAt: info.createdAt,
        active: info.active,
        tokenCount: profile?.tokens.length || 0,
      });
    }
    res.json({ data: users });
  } catch (e) {
    console.error("[admin] GET /users error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Failed to list users" } });
  }
});

router.get("/users/:id", async (req, res) => {
  try {
    const profile = await readJSON<UserProfile>(userProfilePath(req.params.id));
    if (!profile) {
      res.status(404).json({ type: "error", error: { type: "not_found", message: "User not found" } });
      return;
    }
    const safeTokens = profile.tokens.map((t) => ({
      id: t.id,
      prefix: t.prefix,
      createdAt: t.createdAt,
      revoked: t.revoked || false,
    }));
    res.json({
      id: profile.id,
      name: profile.name,
      active: profile.active,
      createdAt: profile.createdAt,
      tokens: safeTokens,
    });
  } catch (e) {
    console.error("[admin] GET /users/:id error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Failed to get user" } });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    const profile = await readJSON<UserProfile>(userProfilePath(req.params.id));
    if (!profile) {
      res.status(404).json({ type: "error", error: { type: "not_found", message: "User not found" } });
      return;
    }
    profile.active = false;
    await writeJSON(userProfilePath(profile.id), profile);
    await updateUserIndexStatus(profile.id, false);
    res.json({ id: profile.id, active: false });
  } catch (e) {
    console.error("[admin] DELETE /users/:id error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Failed to deactivate user" } });
  }
});

router.post("/users/:id/tokens", async (req, res) => {
  try {
    const profile = await readJSON<UserProfile>(userProfilePath(req.params.id));
    if (!profile) {
      res.status(404).json({ type: "error", error: { type: "not_found", message: "User not found" } });
      return;
    }
    if (!profile.active) {
      res.status(400).json({ type: "error", error: { type: "invalid_request", message: "User is deactivated" } });
      return;
    }

    const token = generateTokenValue();
    const h = hashToken(token);
    const tokenId = `tok_${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();

    const userToken: UserToken = {
      id: tokenId,
      prefix: tokenPrefix(token),
      hashedToken: h,
      createdAt: now,
    };

    profile.tokens.push(userToken);
    await writeJSON(tokenLookupPath(h), { userId: profile.id, tokenId }, true);
    await writeJSON(userProfilePath(profile.id), profile);

    res.status(201).json({
      id: tokenId,
      token,
      prefix: tokenPrefix(token),
      createdAt: now,
    });
  } catch (e) {
    console.error("[admin] POST /users/:id/tokens error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Failed to generate token" } });
  }
});

router.delete("/users/:id/tokens/:tokenId", async (req, res) => {
  try {
    const profile = await readJSON<UserProfile>(userProfilePath(req.params.id));
    if (!profile) {
      res.status(404).json({ type: "error", error: { type: "not_found", message: "User not found" } });
      return;
    }

    const tokenEntry = profile.tokens.find((t) => t.id === req.params.tokenId);
    if (!tokenEntry) {
      res.status(404).json({ type: "error", error: { type: "not_found", message: "Token not found" } });
      return;
    }

    tokenEntry.revoked = true;
    await writeJSON(tokenLookupPath(tokenEntry.hashedToken), { userId: profile.id, tokenId: tokenEntry.id, revoked: true });
    await writeJSON(userProfilePath(profile.id), profile);

    res.json({ id: tokenEntry.id, revoked: true });
  } catch (e) {
    console.error("[admin] DELETE /users/:id/tokens/:tokenId error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Failed to revoke token" } });
  }
});

router.get("/pricing", async (_req, res) => {
  try {
    const cached = getCachedPricing();
    if (cached) { res.json(cached); return; }
    const pricing = await readJSON<PricingConfig>(pricingPath());
    if (pricing) setPricingCache(pricing);
    res.json(pricing || {});
  } catch (e) {
    console.error("[admin] GET /pricing error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Failed to read pricing" } });
  }
});

router.put("/pricing", async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json({ type: "error", error: { type: "invalid_request", message: "Invalid pricing data" } });
      return;
    }
    for (const [model, rates] of Object.entries(body)) {
      const r = rates as any;
      if (typeof r.input !== "number" || typeof r.output !== "number" || typeof r.cachedInput !== "number") {
        res.status(400).json({
          type: "error",
          error: { type: "invalid_request", message: `Model '${model}' must have input, output, cachedInput as numbers` },
        });
        return;
      }
    }
    await writeJSON(pricingPath(), body);
    setPricingCache(body as PricingConfig);
    res.json({ ok: true });
  } catch (e) {
    console.error("[admin] PUT /pricing error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Failed to update pricing" } });
  }
});

async function appendUserToIndex(userId: string, name: string, createdAt: string) {
  const index = await readJSON<Record<string, { name: string; createdAt: string; active: boolean }>>(usersIndexPath());
  const data = index || {};
  data[userId] = { name, createdAt, active: true };
  await writeJSON(usersIndexPath(), data);
}

async function updateUserIndexStatus(userId: string, active: boolean) {
  const index = await readJSON<Record<string, { name: string; createdAt: string; active: boolean }>>(usersIndexPath());
  if (index && index[userId]) {
    index[userId].active = active;
    await writeJSON(usersIndexPath(), index);
  }
}

router.get("/metrics", async (req, res) => {
  try {
    const query: UsageQuery = req.query as any;
    const result = await queryMetrics(config.logsGroupName, config.awsRegion, query);
    res.json(result);
  } catch (e) {
    console.error("[admin] GET /metrics error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Failed to query metrics" } });
  }
});

router.get("/users/:id/usage", async (req, res) => {
  try {
    const query: UsageQuery = req.query as any;
    const result = await queryMetrics(config.logsGroupName, config.awsRegion, query, req.params.id);
    res.json(result);
  } catch (e) {
    console.error("[admin] GET /users/:id/usage error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Failed to query user usage" } });
  }
});

  return router;
}
