import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { DeckListEntry } from './core/game';
import type { RulesMode } from './core/types';
import { OnlineMatchService } from './online-match.service';
import { PvpService } from './net/pvp.service';
import type { RoomAd } from './net/rooms';

/** Lobby panel for online PvP: host a room, join from the public list or by code, or pair manually. */
@Component({
  selector: 'digimon-online-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  template: `
    <section class="flex flex-col gap-4 rounded-xl border border-line bg-ink-1 p-4">
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
          <span class="text-muted">Your name</span>
          <input
            class="rounded-lg border border-line bg-ink-2 p-2 text-fg"
            maxlength="40"
            [value]="match.localName()"
            (change)="match.setName($any($event.target).value)"
            placeholder="Tamer name" />
        </label>
        <p class="m-0 flex-1 text-xs text-muted">Deck: {{ deckName() || 'none selected' }} ({{ cardCount() }} cards)</p>
      </div>

      @if (match.phase() !== 'idle') {
        <div class="flex flex-col gap-2 rounded-lg border border-accent/60 bg-ink-2 p-3 text-sm">
          @if (match.phase() === 'waiting' && match.role() === 'host') {
            <span class="text-muted">Room is open. Share this code with your opponent.</span>
            <div class="flex flex-wrap items-center gap-2">
              <code class="rounded bg-ink-1 px-3 py-1 font-mono text-2xl tracking-[0.3em] text-fg">{{ match.roomCode() ?? '....' }}</code>
              @if (match.roomCode(); as code) {
                <button type="button" class="btn-line" (click)="copy(code)">Copy code</button>
              }
              <span class="text-xs text-muted">Waiting for a guest...</span>
            </div>
          } @else if (match.phase() === 'joining') {
            <span class="text-muted">Connecting to the room...</span>
          } @else if (match.phase() === 'handshake') {
            <span class="text-muted">Connected. Exchanging decks...</span>
          } @else if (match.phase() === 'playing') {
            <span class="text-muted">Match running. Open the table to play.</span>
          }
          <div>
            <button type="button" class="btn-line" (click)="match.leave()">Cancel</button>
          </div>
        </div>
      }

      @if (match.phase() === 'idle') {
        <div class="flex gap-1" role="tablist" aria-label="Online room">
          <button type="button" role="tab" class="btn-line" [class.btn-active]="tab() === 'host'" [attr.aria-selected]="tab() === 'host'" (click)="tab.set('host')">Host a room</button>
          <button type="button" role="tab" class="btn-line" [class.btn-active]="tab() === 'join'" [attr.aria-selected]="tab() === 'join'" (click)="tab.set('join')">Join a room</button>
        </div>

        @if (tab() === 'host') {
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-muted">Room name</span>
              <input class="rounded-lg border border-line bg-ink-2 p-2 text-fg" maxlength="32" [value]="roomName()" (input)="roomName.set($any($event.target).value)" placeholder="Friendly match" />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-muted">Password (optional)</span>
              <input class="rounded-lg border border-line bg-ink-2 p-2 text-fg" type="password" maxlength="64" [value]="password()" (input)="password.set($any($event.target).value)" />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-muted">Rules (the guest plays your choice)</span>
              <select class="rounded-lg border border-line bg-ink-2 p-2 text-fg" [value]="rules()" (change)="rules.set($any($event.target).value)">
                <option value="assisted">Assisted (recommended)</option>
                <option value="manual">Manual (free sandbox)</option>
              </select>
            </label>
            <label class="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" [checked]="isPublic()" (change)="isPublic.set($any($event.target).checked)" />
              List in the public room list
            </label>
            <div>
              <button type="button" class="btn-line btn-active" [disabled]="entries().length === 0" (click)="createRoom()">Create room</button>
            </div>
          </div>
        } @else {
          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between text-xs text-muted">
              <span>Public rooms (live)</span>
              <span>{{ pvp.rooms().length }} open</span>
            </div>
            @for (room of pvp.rooms(); track room.code) {
              <div class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink-2 p-2 text-sm">
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate font-semibold text-fg">{{ room.roomName }} @if (room.hasPassword) {<span aria-label="Password protected">🔒</span>}</span>
                  <span class="truncate text-xs text-muted">Host {{ room.hostName }} · {{ room.deckName || 'deck hidden' }} · {{ age(room) }}</span>
                </div>
                <span class="font-mono text-xs text-muted">{{ room.code }}</span>
                <button type="button" class="btn-line btn-active" [disabled]="entries().length === 0" (click)="joinListed(room)">Join</button>
              </div>
            } @empty {
              <p class="m-0 text-xs text-muted">No open rooms right now. Host one, or join by code.</p>
            }

            <div class="grid grid-cols-1 gap-3 border-t border-line pt-3 md:grid-cols-[1fr_1fr_auto]">
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-muted">Join by code</span>
                <input class="rounded-lg border border-line bg-ink-2 p-2 font-mono uppercase text-fg" maxlength="4" [value]="joinCode()" (input)="joinCode.set($any($event.target).value)" placeholder="ABCD" />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-muted">Password (if any)</span>
                <input class="rounded-lg border border-line bg-ink-2 p-2 text-fg" type="password" maxlength="64" [value]="joinPassword()" (input)="joinPassword.set($any($event.target).value)" />
              </label>
              <div class="flex items-end">
                <button type="button" class="btn-line btn-active" [disabled]="entries().length === 0 || joinCode().trim().length !== 4" (click)="joinByCode()">Join</button>
              </div>
            </div>
          </div>
        }

        @if (match.error(); as err) {
          <p class="m-0 rounded-lg border border-red-500/60 bg-red-950/60 p-2 text-xs text-red-100" role="alert">{{ err }}</p>
        }

        <details class="rounded-lg border border-line bg-ink-2 p-3 text-sm">
          <summary class="cursor-pointer text-fg">Manual connection (no internet brokers)</summary>
          <div class="mt-3 grid gap-4 md:grid-cols-2">
            <div class="flex flex-col gap-2">
              <span class="font-semibold text-fg">As host</span>
              <button type="button" class="btn-line" [disabled]="entries().length === 0" (click)="makeOffer()">Create offer</button>
              @if (offerCode(); as offer) {
                <textarea class="h-24 rounded-lg border border-line bg-ink-1 p-2 font-mono text-xs text-fg" readonly [value]="offer"></textarea>
                <button type="button" class="btn-line" (click)="copy(offer)">Copy offer</button>
              }
              <textarea class="h-20 rounded-lg border border-line bg-ink-1 p-2 font-mono text-xs text-fg" placeholder="Paste the answer here" [value]="manualAnswerText()" (input)="manualAnswerText.set($any($event.target).value)"></textarea>
              <button type="button" class="btn-line" [disabled]="!manualAnswerText().trim()" (click)="acceptAnswer()">Connect</button>
            </div>
            <div class="flex flex-col gap-2">
              <span class="font-semibold text-fg">As guest</span>
              <textarea class="h-24 rounded-lg border border-line bg-ink-1 p-2 font-mono text-xs text-fg" placeholder="Paste the offer here" [value]="manualOfferText()" (input)="manualOfferText.set($any($event.target).value)"></textarea>
              <button type="button" class="btn-line" [disabled]="entries().length === 0 || !manualOfferText().trim()" (click)="manualAccept()">Create answer</button>
              @if (answerCode(); as answer) {
                <textarea class="h-24 rounded-lg border border-line bg-ink-1 p-2 font-mono text-xs text-fg" readonly [value]="answer"></textarea>
                <button type="button" class="btn-line" (click)="copy(answer)">Copy answer</button>
              }
            </div>
          </div>
        </details>
      }

      @if (copied(); as note) {
        <p class="m-0 text-xs text-muted" role="status">{{ note }}</p>
      }
    </section>
  `,
  styles: [
    `
      .btn-line {
        border: 1px solid var(--dc-line, #334155);
        background: var(--dc-ink-1, #0f172a);
        color: var(--dc-fg, #e2e8f0);
        border-radius: 0.5rem;
        padding: 0.4rem 0.75rem;
        font-size: 0.8rem;
        cursor: pointer;
      }
      .btn-line:hover:not(:disabled) {
        border-color: var(--dc-accent, #38bdf8);
      }
      .btn-line:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .btn-active {
        background: var(--dc-accent, #38bdf8);
        color: var(--dc-accent-ink, #0f172a);
        border-color: transparent;
        font-weight: 600;
      }
    `,
  ],
})
export class OnlinePanelComponent implements OnInit, OnDestroy {
  readonly entries = input<DeckListEntry[]>([]);
  readonly deckName = input('');

  protected readonly match = inject(OnlineMatchService);
  protected readonly pvp = inject(PvpService);

  protected readonly tab = signal<'host' | 'join'>('host');
  protected readonly roomName = signal('');
  protected readonly isPublic = signal(true);
  protected readonly rules = signal<RulesMode>('assisted');
  protected readonly password = signal('');
  protected readonly joinCode = signal('');
  protected readonly joinPassword = signal('');
  protected readonly offerCode = signal<string | null>(null);
  protected readonly answerCode = signal<string | null>(null);
  protected readonly manualOfferText = signal('');
  protected readonly manualAnswerText = signal('');
  protected readonly copied = signal<string | null>(null);
  protected readonly cardCount = computed(() => this.entries().reduce((n, e) => n + e.count, 0));

  ngOnInit(): void {
    this.pvp.watchRooms();
  }

  ngOnDestroy(): void {
    this.pvp.stopWatchingRooms();
  }

  createRoom(): void {
    this.match.host({
      name: this.match.localName(),
      deckName: this.deckName(),
      entries: this.entries(),
      roomName: this.roomName().trim() || `${this.match.localName() || 'Tamer'}'s room`,
      isPublic: this.isPublic(),
      password: this.password(),
      mode: this.rules(),
    });
  }

  joinListed(room: RoomAd): void {
    let password = '';
    if (room.hasPassword) {
      const answer = window.prompt(`Password for "${room.roomName}"`);
      if (answer === null) return;
      password = answer;
    }
    this.match.join(room.code, this.joinSetup(password));
  }

  joinByCode(): void {
    this.match.join(this.joinCode(), this.joinSetup(this.joinPassword()));
  }

  async makeOffer(): Promise<void> {
    const code = await this.match.manualOffer({
      name: this.match.localName(),
      deckName: this.deckName(),
      entries: this.entries(),
      roomName: '',
      isPublic: false,
      password: '',
      mode: this.rules(),
    });
    this.offerCode.set(code);
  }

  async acceptAnswer(): Promise<void> {
    await this.match.manualAnswer(this.manualAnswerText());
  }

  async manualAccept(): Promise<void> {
    const answer = await this.match.manualAccept(this.manualOfferText(), this.joinSetup(''));
    this.answerCode.set(answer);
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(
      () => this.copied.set('Copied to the clipboard.'),
      () => this.copied.set('Copy failed. Select the text and copy it by hand.'),
    );
  }

  age(room: RoomAd): string {
    const seconds = Math.max(0, Math.round((Date.now() - room.createdAt) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.round(seconds / 60)}m ago`;
  }

  private joinSetup(password: string) {
    return { name: this.match.localName(), deckName: this.deckName(), entries: this.entries(), password };
  }
}
