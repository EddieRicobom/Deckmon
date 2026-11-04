export type PvpErrorCode =
  | 'invalid-code'
  | 'wrong-password'
  | 'not-found'
  | 'room-busy'
  | 'network'
  | 'webrtc'
  | 'no-candidates'
  | 'protocol'
  | 'cancelled'
  | 'other';

/** Error with a stable `code` the UI can switch on; `message` is a short Portuguese sentence for the player. */
export class PvpError extends Error {
  readonly code: PvpErrorCode;

  constructor(code: PvpErrorCode, message: string) {
    super(message);
    this.name = 'PvpError';
    this.code = code;
  }
}
