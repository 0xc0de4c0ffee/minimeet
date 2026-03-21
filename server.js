const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 30000,
  pingInterval: 10000,
  maxHttpBufferSize: 1e6,
});

// ─── Supabase / JSON fallback ───────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
  const { createClient } = require("@supabase/supabase-js");
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log("✅ Supabase connected");
} else {
  console.log("⚠️ No Supabase — falling back to local JSON");
}

// ─── X (Twitter) OAuth 2.0 ─────────────────────────────────────────────────

const X_CLIENT_ID = process.env.X_CLIENT_ID;
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const X_CALLBACK_URL = process.env.X_CALLBACK_URL || "http://localhost:3001/auth/x/callback";

const oauthStates = new Map();  // state → { codeVerifier, createdAt }
const authTokens = new Map();   // token → { xId, username, displayName, avatar, expiresAt }

// Clean up expired states/tokens every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStates) { if (now - v.createdAt > 600_000) oauthStates.delete(k); }
  for (const [k, v] of authTokens) { if (now > v.expiresAt) authTokens.delete(k); }
}, 300_000);

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// Route: Start OAuth flow
app.get("/auth/x", (req, res) => {
  if (!X_CLIENT_ID) return res.status(500).send("X OAuth not configured");

  const state = base64url(crypto.randomBytes(16));
  const { verifier, challenge } = generatePKCE();

  oauthStates.set(state, { codeVerifier: verifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: X_CLIENT_ID,
    redirect_uri: X_CALLBACK_URL,
    scope: "users.read tweet.read offline.access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  res.redirect(`https://twitter.com/i/oauth2/authorize?${params}`);
});

// Route: OAuth callback
app.get("/auth/x/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.warn("X OAuth error:", error);
    return res.redirect("/?auth_error=" + encodeURIComponent(error));
  }

  if (!code || !state || !oauthStates.has(state)) {
    return res.redirect("/?auth_error=invalid_state");
  }

  const { codeVerifier } = oauthStates.get(state);
  oauthStates.delete(state);

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64"),
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: X_CALLBACK_URL,
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error("Token exchange failed:", tokenRes.status, errBody);
      return res.redirect("/?auth_error=token_exchange_failed");
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch user profile
    const userRes = await fetch("https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userRes.ok) {
      console.error("User fetch failed:", userRes.status);
      return res.redirect("/?auth_error=user_fetch_failed");
    }

    const userData = await userRes.json();
    const xUser = userData.data;

    // Get higher-res profile image (replace _normal with _400x400)
    const avatar = xUser.profile_image_url
      ? xUser.profile_image_url.replace("_normal", "_400x400")
      : null;

    // Store X profile in Supabase
    await dbSetXProfile(xUser.username, {
      xId: xUser.id,
      username: xUser.username,
      displayName: xUser.name,
      avatar,
    });

    // Create a temporary auth token the client can use
    const authToken = base64url(crypto.randomBytes(24));
    authTokens.set(authToken, {
      xId: xUser.id,
      username: xUser.username,
      displayName: xUser.name,
      avatar,
      expiresAt: Date.now() + 300_000, // 5 min to use it
    });

    console.log(`✅ X auth success: @${xUser.username} (${xUser.name})`);
    res.redirect(`/?auth_token=${authToken}`);
  } catch (e) {
    console.error("OAuth callback error:", e);
    res.redirect("/?auth_error=server_error");
  }
});

// API: Resolve auth token (called by client via fetch)
app.get("/auth/resolve/:token", (req, res) => {
  const profile = authTokens.get(req.params.token);
  if (!profile) return res.status(404).json({ error: "Token expired or invalid" });
  // Don't delete — let it expire naturally so page refreshes work briefly
  res.json({
    xId: profile.xId,
    username: profile.username,
    displayName: profile.displayName,
    avatar: profile.avatar,
  });
});

// ─── X Profile persistence ──────────────────────────────────────────────────

async function dbGetXProfile(username) {
  const key = username.toLowerCase().trim();
  if (supabase) {
    try {
      const { data } = await supabase.from("x_profiles").select("*").eq("username", key).single();
      if (data) return data;
    } catch {}
    return null;
  }
  const stored = jsonGet("x_profiles", key);
  return stored ? JSON.parse(stored) : null;
}

async function dbSetXProfile(username, profile) {
  const key = username.toLowerCase().trim();
  if (supabase) {
    try {
      await supabase.from("x_profiles").upsert({
        username: key,
        x_id: profile.xId,
        display_name: profile.displayName,
        avatar: profile.avatar,
        updated_at: new Date().toISOString(),
      });
    } catch (e) { console.warn("X profile write error:", e.message); }
    return;
  }
  jsonSet("x_profiles", key, JSON.stringify(profile));
}

// ─── Avatar persistence ─────────────────────────────────────────────────────

const avatarCache = new Map();

async function dbGetAvatar(name) {
  const key = name.toLowerCase().trim();
  if (avatarCache.has(key)) return avatarCache.get(key);
  if (supabase) {
    try {
      const { data } = await supabase.from("avatars").select("data").eq("name", key).single();
      if (data) { avatarCache.set(key, data.data); return data.data; }
    } catch {}
    return null;
  }
  return jsonGet("avatars", key);
}

async function dbSetAvatar(name, dataUrl) {
  const key = name.toLowerCase().trim();
  if (dataUrl) avatarCache.set(key, dataUrl); else avatarCache.delete(key);
  if (supabase) {
    try {
      if (dataUrl) await supabase.from("avatars").upsert({ name: key, data: dataUrl, updated_at: new Date().toISOString() });
      else await supabase.from("avatars").delete().eq("name", key);
    } catch (e) { console.warn("Avatar write error:", e.message); }
    return;
  }
  jsonSet("avatars", key, dataUrl);
}

// ─── Call stats persistence ─────────────────────────────────────────────────

const statsCache = new Map();

function defaultStats() {
  return { received: 0, accepted: 0, declined: 0, missed: 0, streak: 0, best_streak: 0 };
}

async function dbGetStats(name) {
  const key = name.toLowerCase().trim();
  if (statsCache.has(key)) return statsCache.get(key);
  if (supabase) {
    try {
      const { data } = await supabase.from("call_stats").select("*").eq("name", key).single();
      if (data) {
        const stats = { received: data.received||0, accepted: data.accepted||0, declined: data.declined||0, missed: data.missed||0, streak: data.streak||0, best_streak: data.best_streak||0 };
        statsCache.set(key, stats);
        return stats;
      }
    } catch {}
    const fresh = defaultStats();
    statsCache.set(key, fresh);
    return fresh;
  }
  const stored = jsonGet("stats", key);
  const stats = stored ? JSON.parse(stored) : defaultStats();
  statsCache.set(key, stats);
  return stats;
}

async function dbSetStats(name, stats) {
  const key = name.toLowerCase().trim();
  statsCache.set(key, stats);
  if (supabase) {
    try {
      await supabase.from("call_stats").upsert({ name: key, received: stats.received, accepted: stats.accepted, declined: stats.declined, missed: stats.missed, streak: stats.streak, best_streak: stats.best_streak, updated_at: new Date().toISOString() });
    } catch (e) { console.warn("Stats write error:", e.message); }
    return;
  }
  jsonSet("stats", key, JSON.stringify(stats));
}

async function recordCallOutcome(calleeName, outcome) {
  const stats = await dbGetStats(calleeName);
  stats.received++;
  if (outcome === "accepted") { stats.accepted++; stats.streak++; if (stats.streak > stats.best_streak) stats.best_streak = stats.streak; }
  else if (outcome === "declined") { stats.declined++; stats.streak = 0; }
  else if (outcome === "missed") { stats.missed++; stats.streak = 0; }
  await dbSetStats(calleeName, stats);
  return stats;
}

// ─── JSON file fallback ─────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, "data");
const jsonStores = {};

function jsonGet(store, key) {
  const file = path.join(DATA_DIR, `${store}.json`);
  if (!jsonStores[store]) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(file)) jsonStores[store] = JSON.parse(fs.readFileSync(file, "utf-8"));
      else jsonStores[store] = {};
    } catch { jsonStores[store] = {}; }
  }
  return jsonStores[store][key] || null;
}

function jsonSet(store, key, value) {
  if (!jsonStores[store]) jsonStores[store] = {};
  if (value) jsonStores[store][key] = value; else delete jsonStores[store][key];
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, `${store}.json`), JSON.stringify(jsonStores[store]), "utf-8");
  } catch (e) { console.warn(`JSON write error (${store}):`, e.message); }
}

// ─── State ──────────────────────────────────────────────────────────────────

const onlineUsers = new Map();
const activeCalls = new Map();
const takenNames = new Map();
const disconnectTimers = new Map();

const CALL_DURATION_MS = 60_000;
const RING_TIMEOUT_MS = 20_000;
const RECONNECT_GRACE_MS = 15_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function broadcastUserList() {
  const users = [];
  for (const [userId, data] of onlineUsers) {
    if (!data.disconnectedAt) {
      users.push({
        userId, name: data.name, status: data.status,
        avatar: data.avatar || null, stats: data.stats || null,
        xUsername: data.xUsername || null,
      });
    }
  }
  io.emit("user-list", users);
  io.emit("online-count", users.length);
}

function getSocketByUserId(userId) {
  const userData = onlineUsers.get(userId);
  if (!userData) return null;
  return io.sockets.sockets.get(userData.socketId) || null;
}

function cleanupCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) return;
  clearTimeout(call.timerId);
  clearTimeout(call.ringTimerId);
  activeCalls.delete(callId);
}

function isNameTaken(name, excludeUserId = null) {
  const lower = name.toLowerCase().trim();
  const existingUserId = takenNames.get(lower);
  if (!existingUserId) return false;
  if (excludeUserId && existingUserId === excludeUserId) return false;
  if (!onlineUsers.has(existingUserId)) { takenNames.delete(lower); return false; }
  return true;
}

function isUserInCall(userId) {
  for (const [, call] of activeCalls) {
    if (call.callerId === userId || call.calleeId === userId) return true;
  }
  return false;
}

async function refreshUserStats(userId) {
  const userData = onlineUsers.get(userId);
  if (!userData) return;
  userData.stats = await dbGetStats(userData.name);
  broadcastUserList();
}

// ─── Socket.IO Events ──────────────────────────────────────────────────────

io.on("connection", (socket) => {

  socket.on("register", async ({ name, reconnectUserId, avatar, xUsername }) => {
    const trimmedName = name.trim();

    if (reconnectUserId && onlineUsers.has(reconnectUserId)) {
      const eu = onlineUsers.get(reconnectUserId);
      if (disconnectTimers.has(reconnectUserId)) { clearTimeout(disconnectTimers.get(reconnectUserId)); disconnectTimers.delete(reconnectUserId); }
      eu.socketId = socket.id; eu.disconnectedAt = null; eu.status = "online";
      if (avatar) { eu.avatar = avatar; await dbSetAvatar(eu.name, avatar); }
      socket.userId = reconnectUserId;
      const resolvedAvatar = eu.avatar || await dbGetAvatar(eu.name);
      eu.avatar = resolvedAvatar;
      eu.stats = await dbGetStats(eu.name);
      socket.emit("registered", { userId: reconnectUserId, name: eu.name, reconnected: true, avatar: resolvedAvatar, stats: eu.stats, xUsername: eu.xUsername || null });
      broadcastUserList();
      return;
    }

    if (isNameTaken(trimmedName)) {
      socket.emit("register-error", { message: `"${trimmedName}" is already taken. Try a different name.` });
      return;
    }

    const userId = uuidv4().slice(0, 8);
    socket.userId = userId;
    const storedAvatar = await dbGetAvatar(trimmedName);
    const resolvedAvatar = avatar || storedAvatar || null;
    if (avatar && avatar !== storedAvatar) await dbSetAvatar(trimmedName, avatar);
    const stats = await dbGetStats(trimmedName);

    onlineUsers.set(userId, {
      socketId: socket.id, name: trimmedName, status: "online",
      avatar: resolvedAvatar, stats, disconnectedAt: null,
      xUsername: xUsername || null,
    });
    takenNames.set(trimmedName.toLowerCase(), userId);
    socket.emit("registered", { userId, name: trimmedName, reconnected: false, avatar: resolvedAvatar, stats, xUsername: xUsername || null });
    broadcastUserList();
    console.log(`✅ ${trimmedName}${xUsername ? " (@" + xUsername + ")" : ""} registered as ${userId}`);
  });

  socket.on("update-avatar", async ({ avatar }) => {
    const userId = socket.userId; if (!userId) return;
    const userData = onlineUsers.get(userId); if (!userData) return;
    userData.avatar = avatar || null;
    await dbSetAvatar(userData.name, avatar);
    broadcastUserList();
  });

  socket.on("call-user", ({ calleeId }) => {
    const callerId = socket.userId;
    const caller = onlineUsers.get(callerId);
    const callee = onlineUsers.get(calleeId);
    if (!callee || callee.disconnectedAt) { socket.emit("call-error", { message: "User is offline" }); return; }
    if (isUserInCall(calleeId)) { socket.emit("call-error", { message: `${callee.name} is already in a call` }); return; }
    if (isUserInCall(callerId)) { socket.emit("call-error", { message: "You are already in a call" }); return; }

    const callId = uuidv4().slice(0, 12);
    const ringTimerId = setTimeout(async () => {
      const call = activeCalls.get(callId);
      if (call && !call.startedAt) {
        await recordCallOutcome(callee.name, "missed");
        await refreshUserStats(calleeId);
        socket.emit("call-not-answered", { callId });
        const cs = getSocketByUserId(calleeId); if (cs) cs.emit("call-cancelled", { callId });
        cleanupCall(callId);
      }
    }, RING_TIMEOUT_MS);

    activeCalls.set(callId, { callerId, calleeId, startedAt: null, timerId: null, ringTimerId });
    const cs = getSocketByUserId(calleeId);
    if (cs) cs.emit("incoming-call", { callId, callerId, callerName: caller.name, callerAvatar: caller.avatar || null, callerXUsername: caller.xUsername || null });
    socket.emit("call-ringing", { callId, calleeId, calleeName: callee.name, calleeAvatar: callee.avatar || null });
  });

  socket.on("accept-call", async ({ callId }) => {
    const call = activeCalls.get(callId); if (!call) return;
    clearTimeout(call.ringTimerId); call.startedAt = Date.now();
    const callee = onlineUsers.get(call.calleeId);
    if (callee) { await recordCallOutcome(callee.name, "accepted"); await refreshUserStats(call.calleeId); }
    call.timerId = setTimeout(() => {
      const s1 = getSocketByUserId(call.callerId); const s2 = getSocketByUserId(call.calleeId);
      if (s1) s1.emit("call-timeout", { callId }); if (s2) s2.emit("call-timeout", { callId });
      cleanupCall(callId);
    }, CALL_DURATION_MS);
    const s1 = getSocketByUserId(call.callerId); if (s1) s1.emit("call-accepted", { callId });
    socket.emit("call-accepted", { callId });
  });

  socket.on("decline-call", async ({ callId }) => {
    const call = activeCalls.get(callId); if (!call) return;
    const callee = onlineUsers.get(call.calleeId);
    if (callee) { await recordCallOutcome(callee.name, "declined"); await refreshUserStats(call.calleeId); }
    const s = getSocketByUserId(call.callerId); if (s) s.emit("call-declined", { callId });
    cleanupCall(callId);
  });

  socket.on("end-call", ({ callId }) => {
    const call = activeCalls.get(callId); if (!call) return;
    const dur = call.startedAt ? Math.floor((Date.now() - call.startedAt) / 1000) : 0;
    const oid = call.callerId === socket.userId ? call.calleeId : call.callerId;
    const os = getSocketByUserId(oid); if (os) os.emit("call-ended", { callId, duration: dur });
    socket.emit("call-ended", { callId, duration: dur });
    cleanupCall(callId);
  });

  socket.on("webrtc-offer", ({ callId, sdp }) => { const c = activeCalls.get(callId); if (!c) return; const t = c.callerId === socket.userId ? c.calleeId : c.callerId; const s = getSocketByUserId(t); if (s) s.emit("webrtc-offer", { callId, sdp }); });
  socket.on("webrtc-answer", ({ callId, sdp }) => { const c = activeCalls.get(callId); if (!c) return; const t = c.callerId === socket.userId ? c.calleeId : c.callerId; const s = getSocketByUserId(t); if (s) s.emit("webrtc-answer", { callId, sdp }); });
  socket.on("webrtc-ice-candidate", ({ callId, candidate }) => { const c = activeCalls.get(callId); if (!c) return; const t = c.callerId === socket.userId ? c.calleeId : c.callerId; const s = getSocketByUserId(t); if (s) s.emit("webrtc-ice-candidate", { callId, candidate }); });

  socket.on("disconnect", () => {
    const userId = socket.userId; if (!userId) return;
    const userData = onlineUsers.get(userId); if (!userData) return;
    userData.disconnectedAt = Date.now(); broadcastUserList();
    const timer = setTimeout(() => {
      for (const [callId, call] of activeCalls) {
        if (call.callerId === userId || call.calleeId === userId) {
          const oid = call.callerId === userId ? call.calleeId : call.callerId;
          const os = getSocketByUserId(oid);
          if (os) os.emit("call-ended", { callId, duration: call.startedAt ? Math.floor((Date.now() - call.startedAt) / 1000) : 0 });
          cleanupCall(callId);
        }
      }
      takenNames.delete(userData.name.toLowerCase());
      onlineUsers.delete(userId); disconnectTimers.delete(userId);
      broadcastUserList();
    }, RECONNECT_GRACE_MS);
    disconnectTimers.set(userId, timer);
  });
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n  🕐 OneMinute on http://localhost:${PORT} | DB: ${supabase ? "Supabase" : "JSON"} | X OAuth: ${X_CLIENT_ID ? "✅" : "❌"}\n`);
});
