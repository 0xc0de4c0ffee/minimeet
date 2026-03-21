const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // In production, lock this down to your domain
    methods: ["GET", "POST"],
  },
});

// ─── State ──────────────────────────────────────────────────────────────────

// Maps a userId to their socket + profile info
// { [userId]: { socketId, name, status } }
const onlineUsers = new Map();

// Active calls keyed by a generated callId
// { [callId]: { callerId, calleeId, startedAt, timerId } }
const activeCalls = new Map();

const CALL_DURATION_MS = 60_000; // 60 seconds
const RING_TIMEOUT_MS = 20_000; // 20 seconds to answer

// ─── Helpers ────────────────────────────────────────────────────────────────

function broadcastUserList() {
  const users = [];
  for (const [userId, data] of onlineUsers) {
    users.push({ userId, name: data.name, status: data.status });
  }
  io.emit("user-list", users);
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

// ─── Socket.IO Events ──────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`⚡ Socket connected: ${socket.id}`);

  // ── Register ──────────────────────────────────────────────────────────
  // Client sends: { name: "Sarah Chen" }
  // Server assigns a userId and broadcasts updated user list
  socket.on("register", ({ name }) => {
    const userId = uuidv4().slice(0, 8);
    socket.userId = userId;

    onlineUsers.set(userId, {
      socketId: socket.id,
      name,
      status: "online",
    });

    socket.emit("registered", { userId, name });
    broadcastUserList();

    console.log(`✅ ${name} registered as ${userId}`);
  });

  // ── Initiate Call ─────────────────────────────────────────────────────
  // Caller sends: { calleeId }
  // Server creates a call record, notifies callee
  socket.on("call-user", ({ calleeId }) => {
    const callerId = socket.userId;
    const caller = onlineUsers.get(callerId);
    const callee = onlineUsers.get(calleeId);

    if (!callee) {
      socket.emit("call-error", { message: "User is offline" });
      return;
    }

    const callId = uuidv4().slice(0, 12);

    // Ring timeout — auto-cancel if callee doesn't answer
    const ringTimerId = setTimeout(() => {
      const call = activeCalls.get(callId);
      if (call && !call.startedAt) {
        socket.emit("call-not-answered", { callId });
        const calleeSocket = getSocketByUserId(calleeId);
        if (calleeSocket) {
          calleeSocket.emit("call-cancelled", { callId });
        }
        cleanupCall(callId);
      }
    }, RING_TIMEOUT_MS);

    activeCalls.set(callId, {
      callerId,
      calleeId,
      startedAt: null,
      timerId: null,
      ringTimerId,
    });

    // Notify callee of incoming call
    const calleeSocket = getSocketByUserId(calleeId);
    if (calleeSocket) {
      calleeSocket.emit("incoming-call", {
        callId,
        callerId,
        callerName: caller.name,
      });
    }

    // Confirm to caller
    socket.emit("call-ringing", { callId, calleeId, calleeName: callee.name });

    console.log(`📞 ${caller.name} calling ${callee.name} [${callId}]`);
  });

  // ── Accept Call ───────────────────────────────────────────────────────
  socket.on("accept-call", ({ callId }) => {
    const call = activeCalls.get(callId);
    if (!call) return;

    clearTimeout(call.ringTimerId);
    call.startedAt = Date.now();

    // Start the 60-second enforced timer
    call.timerId = setTimeout(() => {
      const callerSocket = getSocketByUserId(call.callerId);
      const calleeSocket = getSocketByUserId(call.calleeId);

      if (callerSocket) callerSocket.emit("call-timeout", { callId });
      if (calleeSocket) calleeSocket.emit("call-timeout", { callId });

      cleanupCall(callId);
      console.log(`⏰ Call ${callId} auto-ended (60s limit)`);
    }, CALL_DURATION_MS);

    // Notify both parties to start WebRTC
    const callerSocket = getSocketByUserId(call.callerId);
    if (callerSocket) {
      callerSocket.emit("call-accepted", { callId });
    }

    socket.emit("call-accepted", { callId });
    console.log(`✅ Call ${callId} accepted — 60s timer started`);
  });

  // ── Decline Call ──────────────────────────────────────────────────────
  socket.on("decline-call", ({ callId }) => {
    const call = activeCalls.get(callId);
    if (!call) return;

    const callerSocket = getSocketByUserId(call.callerId);
    if (callerSocket) {
      callerSocket.emit("call-declined", { callId });
    }

    cleanupCall(callId);
    console.log(`❌ Call ${callId} declined`);
  });

  // ── End Call ──────────────────────────────────────────────────────────
  socket.on("end-call", ({ callId }) => {
    const call = activeCalls.get(callId);
    if (!call) return;

    const duration = call.startedAt
      ? Math.floor((Date.now() - call.startedAt) / 1000)
      : 0;

    // Notify the other party
    const otherUserId =
      call.callerId === socket.userId ? call.calleeId : call.callerId;
    const otherSocket = getSocketByUserId(otherUserId);
    if (otherSocket) {
      otherSocket.emit("call-ended", { callId, duration });
    }

    socket.emit("call-ended", { callId, duration });
    cleanupCall(callId);
    console.log(`🔚 Call ${callId} ended by user (${duration}s)`);
  });

  // ── WebRTC Signaling: SDP Offer ───────────────────────────────────────
  socket.on("webrtc-offer", ({ callId, sdp }) => {
    const call = activeCalls.get(callId);
    if (!call) return;

    const targetId =
      call.callerId === socket.userId ? call.calleeId : call.callerId;
    const targetSocket = getSocketByUserId(targetId);

    if (targetSocket) {
      targetSocket.emit("webrtc-offer", { callId, sdp });
    }
  });

  // ── WebRTC Signaling: SDP Answer ──────────────────────────────────────
  socket.on("webrtc-answer", ({ callId, sdp }) => {
    const call = activeCalls.get(callId);
    if (!call) return;

    const targetId =
      call.callerId === socket.userId ? call.calleeId : call.callerId;
    const targetSocket = getSocketByUserId(targetId);

    if (targetSocket) {
      targetSocket.emit("webrtc-answer", { callId, sdp });
    }
  });

  // ── WebRTC Signaling: ICE Candidate ───────────────────────────────────
  socket.on("webrtc-ice-candidate", ({ callId, candidate }) => {
    const call = activeCalls.get(callId);
    if (!call) return;

    const targetId =
      call.callerId === socket.userId ? call.calleeId : call.callerId;
    const targetSocket = getSocketByUserId(targetId);

    if (targetSocket) {
      targetSocket.emit("webrtc-ice-candidate", { callId, candidate });
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const userId = socket.userId;
    if (!userId) return;

    // End any active calls involving this user
    for (const [callId, call] of activeCalls) {
      if (call.callerId === userId || call.calleeId === userId) {
        const otherUserId =
          call.callerId === userId ? call.calleeId : call.callerId;
        const otherSocket = getSocketByUserId(otherUserId);
        if (otherSocket) {
          otherSocket.emit("call-ended", {
            callId,
            duration: call.startedAt
              ? Math.floor((Date.now() - call.startedAt) / 1000)
              : 0,
          });
        }
        cleanupCall(callId);
      }
    }

    const name = onlineUsers.get(userId)?.name || "Unknown";
    onlineUsers.delete(userId);
    broadcastUserList();
    console.log(`👋 ${name} (${userId}) disconnected`);
  });
});

// ─── Serve static frontend (optional) ───────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));

// ─── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   🕐 OneMinute Signaling Server           ║
  ║   Running on http://localhost:${PORT}        ║
  ║   60-second calls enforced server-side    ║
  ╚═══════════════════════════════════════════╝
  `);
});
