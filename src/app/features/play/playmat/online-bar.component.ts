import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { GameSession } from '../game-session.service';
import { OnlineMatchService } from '../online-match.service';

/** Online-only strip above the mat: connection pill, opponent, resign, desync repair, chat and the pause overlay. */
@Component({
  selector: 'digimon-online-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  template: `
    @if (match.phase() === 'playing') {
      <div class="flex flex-col gap-2 rounded-lg border border-line bg-ink-1 p-2 text-xs">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full px-2 py-0.5 font-semibold" [class]="pillClass()">{{ pillLabel() }}</span>
          <span class="text-fg">
            vs <b>{{ match.remoteName() || 'Opponent' }}</b>
            @if (match.remoteDeckName()) {
              <span class="text-muted">({{ match.remoteDeckName() }})</span>
            }
          </span>
          @if (match.desync()) {
            <span class="rounded bg-red-950/70 px-2 py-0.5 text-red-100" role="alert">Boards out of sync.</span>
            @if (isActive()) {
              <button type="button" class="btn-online" (click)="match.resync()">Resync</button>
            } @else {
              <span class="text-muted">Waiting for the active player to resync.</span>
            }
          }
          <div class="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" class="btn-online" (click)="chatOpen.set(!chatOpen())" [attr.aria-pressed]="chatOpen()">Chat</button>
            <button type="button" class="btn-online" (click)="resign()" [disabled]="match.resignedBy() !== null">Resign</button>
          </div>
        </div>

        @if (chatOpen()) {
          <div class="flex flex-col gap-1 rounded border border-line/60 bg-ink-2 p-2">
            <ol class="m-0 flex max-h-32 list-none flex-col gap-0.5 overflow-y-auto p-0">
              @for (line of match.chat(); track $index) {
                <li class="break-words">
                  <b [class.text-accent]="line.mine" [class.text-fg]="!line.mine">{{ line.name }}:</b>
                  <span class="text-muted"> {{ line.text }}</span>
                </li>
              } @empty {
                <li class="text-muted">No messages yet.</li>
              }
            </ol>
            <form class="flex gap-1" (submit)="sendChat($event)">
              <input
                class="min-w-0 flex-1 rounded border border-line bg-ink-1 p-1 text-fg"
                maxlength="300"
                [value]="draft()"
                (input)="draft.set($any($event.target).value)"
                placeholder="Say something" />
              <button type="submit" class="btn-online" [disabled]="!draft().trim()">Send</button>
            </form>
          </div>
        }

        @if (match.resignedBy() !== null) {
          <div class="flex flex-wrap items-center gap-2 rounded border border-accent bg-ink-2 p-2 text-sm text-fg">
            <span>{{ match.resignedBy() === localPlayer() ? 'You resigned.' : 'Your opponent resigned.' }} The game is over.</span>
            <button type="button" class="btn-online" (click)="leave()">Leave table</button>
          </div>
        }
      </div>

      @if (match.paused()) {
        <div class="fixed inset-0 z-[700] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Connection paused">
          <div class="flex max-w-sm flex-col gap-3 rounded-xl border border-line bg-ink-1 p-5 text-center text-fg shadow-xl">
            <h2 class="m-0 text-lg font-semibold">Connection lost</h2>
            <p class="m-0 text-sm text-muted">The game is paused until the link comes back. Your moves are kept and sent again on reconnect.</p>
            <p class="m-0 text-xs text-muted">Link: {{ match.status() }}</p>
            <div class="flex flex-wrap justify-center gap-2">
              <button type="button" class="btn-online btn-primary" (click)="match.reconnect()">Reconnect</button>
              <button type="button" class="btn-online" (click)="leave()">Leave table</button>
            </div>
            @if (match.error(); as err) {
              <p class="m-0 text-xs text-red-300">{{ err }}</p>
            }
          </div>
        </div>
      }
    }
  `,
  styles: [
    `
      .btn-online {
        border: 1px solid var(--dc-line, #334155);
        background: var(--dc-ink-2, #1e293b);
        color: var(--dc-fg, #e2e8f0);
        border-radius: 0.5rem;
        padding: 0.25rem 0.6rem;
        font-size: 0.75rem;
        cursor: pointer;
      }
      .btn-online:hover:not(:disabled) {
        border-color: var(--dc-accent, #38bdf8);
      }
      .btn-online:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--dc-accent, #38bdf8);
        color: var(--dc-accent-ink, #0f172a);
        border-color: transparent;
        font-weight: 600;
      }
    `,
  ],
})
export class OnlineBarComponent {
  protected readonly match = inject(OnlineMatchService);
  private readonly session = inject(GameSession);
  private readonly router = inject(Router);

  protected readonly localPlayer = this.session.localPlayer;
  protected readonly chatOpen = signal(false);
  protected readonly draft = signal('');

  protected readonly isActive = computed(() => this.session.state()?.activePlayer === this.session.localPlayer());

  protected readonly pillLabel = computed(() => {
    switch (this.match.status()) {
      case 'connected':
        return 'Connected';
      case 'signaling':
      case 'connecting':
        return 'Reconnecting';
      case 'failed':
        return 'Failed';
      default:
        return 'Disconnected';
    }
  });

  protected readonly pillClass = computed(() =>
    this.match.status() === 'connected' ? 'bg-emerald-900/70 text-emerald-100' : 'bg-amber-900/70 text-amber-100',
  );

  protected resign(): void {
    if (window.confirm('Resign this game? Your opponent wins.')) this.match.resign();
  }

  protected sendChat(event: Event): void {
    event.preventDefault();
    this.match.sendChat(this.draft());
    this.draft.set('');
  }

  protected leave(): void {
    this.match.leave();
    void this.router.navigateByUrl('/play');
  }
}
