# 🕐 OneMinute — 60-Second Video Calling

A browser-based video calling app where every call is limited to exactly **60 seconds**. Built with WebRTC for peer-to-peer video and Socket.IO for signaling.

## How It Works

```
┌──────────┐     Socket.IO      ┌──────────────────┐     Socket.IO      ┌──────────┐
│  Caller  │ ◄────────────────► │  Signaling Server │ ◄────────────────► │  Callee  │
│ (Browser)│                    │   (Node.js)       │                    │ (Browser)│
└────┬─────┘                    └──────────────────┘                    └────┬─────┘
     │                                                                       │
     │                    WebRTC (Peer-to-Peer)                              │
     │ ◄───────────────────────────────────────────────────────────────────► │
     │                  Video + Audio (direct)                               │
```

1. Users join by entering their name
2. The server tracks who's online and relays signaling messages
3. When a call is accepted, WebRTC establishes a direct peer-to-peer video connection
4. The server enforces a 60-second hard limit — when time's up, both sides are notified
5. Call ended screen shows duration and option to call again

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Then open **http://localhost:3001** in two browser tabs (or two different devices on the same network).

## Testing Locally

1. Open **Tab 1** → enter a name like "Alice" → Join
2. Open **Tab 2** → enter a name like "Bob" → Join
3. Alice will see Bob in the contacts list (and vice versa)
4. Click the video icon to call
5. The other tab gets an incoming call popup
6. Accept → real WebRTC video connection with 60-second countdown

## Project Structure

```
oneminute/
├── server.js          # Signaling server (Express + Socket.IO)
├── package.json       # Dependencies
├── public/
│   └── index.html     # Full client app (HTML + CSS + JS)
└── README.md
```

## Architecture Details

### Signaling Server (`server.js`)
- **User registry**: Tracks online users with Socket.IO
- **Call management**: Handles call initiation, accept/decline, and cleanup
- **SDP relay**: Forwards WebRTC offers and answers between peers
- **ICE relay**: Forwards ICE candidates for NAT traversal
- **60s enforcement**: Server-side timer that forcefully ends calls

### Client (`public/index.html`)
- **WebRTC**: Full peer-to-peer video/audio using RTCPeerConnection
- **Camera access**: getUserMedia for local video/audio
- **ICE servers**: Uses Google's free STUN servers for NAT traversal
- **Responsive UI**: Works on desktop and mobile browsers

### Signaling Flow

```
Caller                  Server                  Callee
  │                       │                       │
  │── call-user ─────────►│                       │
  │                       │──── incoming-call ───►│
  │◄── call-ringing ──────│                       │
  │                       │◄──── accept-call ─────│
  │◄── call-accepted ─────│──── call-accepted ───►│
  │                       │                       │
  │── webrtc-offer ──────►│──── webrtc-offer ────►│
  │                       │◄──── webrtc-answer ───│
  │◄── webrtc-answer ─────│                       │
  │                       │                       │
  │◄─── ice-candidates ──►│◄─── ice-candidates ──►│
  │                       │                       │
  │     [60 seconds pass]                         │
  │                       │                       │
  │◄── call-timeout ──────│──── call-timeout ────►│
```

## Deploying to Production

### Requirements for Production
1. **HTTPS**: WebRTC requires a secure context. Use a reverse proxy like nginx with Let's Encrypt.
2. **TURN server**: STUN alone won't work for all NAT types. Set up a TURN server with [coturn](https://github.com/coturn/coturn) or use a service like Twilio's TURN.
3. **Domain**: Point a domain to your server.

### Quick Deploy with Railway / Render / Fly.io

```bash
# Railway
railway init
railway up

# Render — just connect your repo, set start command to `npm start`

# Fly.io
fly launch
fly deploy
```

### Adding a TURN Server

Update the `ICE_SERVERS` array in `public/index.html`:

```javascript
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:your-turn-server.com:3478",
    username: "your-username",
    credential: "your-password"
  }
];
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3001`  | Server port |

## Browser Support

- Chrome 80+
- Firefox 80+
- Safari 14+
- Edge 80+

## License

MIT
