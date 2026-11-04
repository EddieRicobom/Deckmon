/**
 * Configuration of the serverless P2P layer. Plain object on purpose: no build-time env (Vite/Angular) is read here.
 * Edit the values below to change brokers, the topic namespace, or to enable a TURN relay.
 */

export interface TurnConfig {
  urls: string[];
  username: string;
  credential: string;
}

export interface PvpConfig {
  /** Namespace prefix for every MQTT topic (ends with a slash). */
  topicPrefix: string;
  /** Public MQTT brokers over WebSocket. Every message is published to all of them and deduplicated by id. */
  brokers: readonly string[];
  /** STUN servers (only used to discover the public address; they never see game traffic). */
  stunUrls: readonly string[];
  /** Optional TURN relay for networks where the direct path fails (CGNAT, symmetric NAT). `null` = STUN only. */
  turn: TurnConfig | null;
  /** Version carried in the `hello` message. Peers with a different version refuse to play. */
  protocolVersion: number;
}

export const PVP_CONFIG: PvpConfig = {
  topicPrefix: 'deckmon/v1/dcg/',
  brokers: [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/',
    'wss://mqtt.eclipseprojects.io:443/mqtt',
  ],
  stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  turn: null,
  protocolVersion: 1,
};
