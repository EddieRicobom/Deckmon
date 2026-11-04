# Public rooms (serverless P2P)

Two devices find each other through public MQTT brokers, exchange a WebRTC offer and answer
through them, then talk directly over a data channel. The app runs no server. Brokers only carry
lobby ads and encrypted signaling, and the game never goes through them.

Game-core integration is **not** done here. The game core (`../core`, components) will call
`PvpService` or `PvpClient` later.

## Files

| File | Role |
| --- | --- |
| `config.ts` | Plain config object: topic prefix, brokers, STUN, optional TURN, protocol version. No build env. |
| `rooms.ts` | `PvpClient`, the framework-agnostic public API. |
| `pvp.service.ts` | Angular `PvpService` (`providedIn: 'root'`) with signals `status`, `rooms`, `roomCode`, `peerHello`. |
| `protocol.ts` | `NetMessage` union, validated decoding, command sequencing (`OutboundQueue`, `InboundQueue`). |
| `matchmaker.ts` | Lobby, room topic, join/offer/answer flow, timeouts, typed errors. |
| `secret.ts` | Password key derivation (PBKDF2) and AES-GCM sealing of room frames. |
| `signal.ts` | Hand-written MQTT 3.1.1 hub over WSS. Publishes to all brokers, dedupes by message id. |
| `mqtt-lite.ts` | MQTT packet encoding and streaming decoding (no dependency). |
| `peer.ts` | WebRTC data channel: STUN, optional TURN, ping/pong, silence detection. |
| `sdp-compact.ts`, `codec.ts` | Compact binary SDP (`DCGc.`), with full-SDP fallbacks, for manual copy-paste pairing. |
| `room-code.ts` | 4-character codes over a 32-symbol alphabet with no 0, O, 1 or I. |
| `errors.ts` | `PvpError` with a stable `code` (`wrong-password`, `not-found`, `room-busy`, `network`, …). |
| `diag.ts` | In-memory pairing trail (`H1`, `G3`, `I:connected`…). Never stored or sent. |

## Public API (`PvpClient`)

- `listRooms(cb)`: real-time public list of `RoomAd {code, hostName, roomName, deckName, createdAt, hasPassword}`. Never includes the password.
- `hostRoom({hostName, deckName, isPublic, roomName, password?})`: opens the room. The code is available at once through `roomCode`/`onRoomCode`. The promise resolves when a guest is connected.
- `joinRoom(code, guestName, password?)`: resolves when connected, rejects with `PvpError`.
- `send(msg)`, `onMessage(cb)`, `onStatus(cb)` (`idle | signaling | connecting | connected | disconnected | failed`), `onHello(cb)`.
- `reconnect()`: reopens the same room code (host) or rejoins it (guest). Unacked commands are resent once the new channel opens.
- `createManualOffer()`, `acceptManualOffer(code)`, `acceptManualAnswer(code)`: copy-paste fallback with no brokers. Manual pairing has no room password because there is no room topic.
- `close()`.

## Protocol

Messages are JSON objects with a `t` field:

- `hello {name, deckName, protocol}`: sent on every new channel. A protocol mismatch fails the session.
- `cmd {seq, cmd}`, `ack {seq}`: ordered, deduplicated commands with cumulative acks.
- `state-hash {seq, hash}`, `chat {text}`, `reveal {uids, cardIds}`, `ping`, `pong` (handled inside the peer), `resign`.

Sequencing applies to `cmd` only. The sender assigns `seq` inside `send()`, so any `seq` the caller
sets is ignored. The receiver holds up to 256 early commands and drops duplicates. Unacked
commands are kept (up to 512) and resent in order on every new channel.

Every frame is validated (types, lengths, a 32 KB frame cap, a 16 KB command cap). Peer data is
never trusted.

## Hidden information plan

- Each peer owns its deck, hand and security state. Only the owner's client can read them.
- The opponent receives only redacted state. Hidden cards are sent with explicit `reveal` messages.
- Seeded shuffles plus a commit-reveal hash (`state-hash`) let peers check each other's state
  without trusting it. The commit is made before the seed is revealed.

This is a plan. None of it is implemented in `net/`.

## Rooms, codes and passwords

- **Codes**: 4 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. A room is found by its code
  only, and the code is public in the lobby.
- **Lobby topic** `<prefix>lobby`: public. Room ads every 3 s, expired after 9 s without an ad. An
  ad carries the code, host name, room name, note (deck), and a `hasPassword` flag.
- **Room topic** `<prefix>room/<hash>`: `hash` is 128 bits of `PBKDF2-SHA256(password, salt = prefix + "room/" + code, 100k iterations)`. Without the password the topic cannot be computed, so non-holders never see the signaling traffic.
- **Encryption**: the other 256 bits of the same PBKDF2 output form an AES-GCM key. Every room-topic frame (`here`, `join`, `offer`, `answer`, `busy`) is sealed with a random 12-byte IV. The room code is bound as additional data, so a frame cannot be replayed into another room.
- **Wrong password**: derives a different topic and key. The guest hears nothing and fails with `wrong-password` after the retries (about 14 s). Without a password, the same case reports `not-found`.
- **Limits**: PBKDF2 slows guessing but does not stop it. An attacker who records the lobby can try offline guesses against the captured traffic. Use a real passphrase for private games. The password is not verified against the lobby ad, so the ad leaks nothing about it.
- A password is trimmed and capped at 64 characters. Room names are capped at 32.

## Configuration

Edit `config.ts`. `PVP_CONFIG.turn = { urls: ['turn:...'], username, credential }` enables a
relay for networks where the direct path fails. Without it, STUN only works on most networks.
Some (CGNAT or symmetric NAT) will fail, and the UI says so.

## Limits

- Public brokers have no uptime guarantee. There are four, and a manual-code fallback exists.
- Brokers see who publishes to which hashed topic and when, but not the contents.
- Nothing stops a cheating client. Each device trusts the other's commands within the protocol
  limits. Verification relies on the commit-reveal hash above.
- Not tested on real devices or mobile networks. Unit tests cover codecs, sequencing, the MQTT
  packet layer, password encryption, and wrong-password failure through an in-memory hub.
