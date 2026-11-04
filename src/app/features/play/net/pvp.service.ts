import { Injectable, OnDestroy, signal } from '@angular/core';
import { PvpClient } from './rooms';
import type { HostRoomOptions, PeerHello, PvpStatus, RoomAd } from './rooms';
import type { NetMessage } from './protocol';

/** Thin Angular wrapper around `PvpClient`. The game core talks to this service or to `client` directly. */
@Injectable({ providedIn: 'root' })
export class PvpService implements OnDestroy {
  readonly status = signal<PvpStatus>('idle');
  readonly rooms = signal<RoomAd[]>([]);
  readonly roomCode = signal<string | null>(null);
  readonly peerHello = signal<PeerHello | null>(null);

  readonly client = new PvpClient();

  private stopListing: (() => void) | null = null;

  constructor() {
    this.client.onStatus((s) => this.status.set(s));
    this.client.onRoomCode((code) => this.roomCode.set(code));
    this.client.onHello((h) => this.peerHello.set(h));
  }

  /** Starts the public room list (replaces any previous listing). */
  watchRooms(): void {
    this.stopListing?.();
    this.stopListing = this.client.listRooms((rooms) => this.rooms.set(rooms));
  }

  stopWatchingRooms(): void {
    this.stopListing?.();
    this.stopListing = null;
  }

  hostRoom(opts: HostRoomOptions): Promise<{ code: string }> {
    return this.client.hostRoom(opts);
  }

  joinRoom(code: string, guestName: string, password?: string): Promise<void> {
    return this.client.joinRoom(code, guestName, password);
  }

  reconnect(): Promise<void> {
    return this.client.reconnect();
  }

  send(msg: NetMessage): boolean {
    return this.client.send(msg);
  }

  onMessage(cb: (msg: NetMessage) => void): () => void {
    return this.client.onMessage(cb);
  }

  createManualOffer(): Promise<string> {
    return this.client.createManualOffer();
  }

  acceptManualOffer(offerCode: string): Promise<string> {
    return this.client.acceptManualOffer(offerCode);
  }

  acceptManualAnswer(answerCode: string): Promise<void> {
    return this.client.acceptManualAnswer(answerCode);
  }

  close(): void {
    this.stopWatchingRooms();
    this.client.close();
  }

  ngOnDestroy(): void {
    this.close();
  }
}
