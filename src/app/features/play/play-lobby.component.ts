import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { PageComponent } from '../shared/page.component';
import { DigimonCardStore } from '../../store/digimon-card.store';
import { SaveStore } from '../../store/save.store';
import { DeckListEntry } from './core/game';
import { GameSession } from './game-session.service';
import { deckLabel, randomStarterDeck, toDeckList } from './deck-source';

const RANDOM_OPPONENT = 'random';
const STARTER_OPPONENT = 'starter';

@Component({
  selector: 'digimon-play-lobby',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [PageComponent, RouterLink],
  template: `
    <digimon-page>
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 self-start px-4 py-6 md:px-6">
        <div class="flex flex-col gap-1">
          <h1 class="m-0 text-3xl font-bold text-fg md:text-4xl">Play</h1>
          <p class="m-0 text-sm text-muted">A manual playmat. You enforce the rules yourselves, like a virtual tabletop.</p>
        </div>

        @if (session.state()) {
          <a
            routerLink="/play/table"
            class="flex items-center justify-between gap-3 rounded-xl border border-accent bg-ink-1 p-4 text-fg no-underline hover:bg-ink-2">
            <span class="font-semibold">Resume current game</span>
            <span class="text-sm text-muted">Turn {{ session.state()!.turn }} <i class="pi pi-arrow-right"></i></span>
          </a>
        }

        <section class="flex flex-col gap-4 rounded-xl border border-line bg-ink-1 p-4">
          <h2 class="m-0 text-lg font-semibold text-fg">Decks</h2>

          <label class="flex flex-col gap-1 text-sm">
            <span class="text-muted">Your deck</span>
            <select
              class="rounded-lg border border-line bg-ink-2 p-2 text-fg"
              [value]="myDeck()?.id ?? ''"
              (change)="myDeckId.set($any($event.target).value)">
              @for (deck of decks(); track deck.id) {
                <option [value]="deck.id" [selected]="myDeck()?.id === deck.id">{{ deckLabel(deck) }} ({{ cardTotal(deck.cards) }})</option>
              }
              @if (decks().length === 0) {
                <option value="">Random starter deck</option>
              }
            </select>
          </label>

          <label class="flex flex-col gap-1 text-sm">
            <span class="text-muted">Opponent deck</span>
            <select
              class="rounded-lg border border-line bg-ink-2 p-2 text-fg"
              [value]="opponentId()"
              (change)="opponentId.set($any($event.target).value)">
              <option [value]="random" [selected]="opponentId() === random">Random (saved deck, or starter if none)</option>
              <option [value]="starter" [selected]="opponentId() === starter">Random starter deck</option>
              @for (deck of decks(); track deck.id) {
                <option [value]="deck.id" [selected]="opponentId() === deck.id">{{ deckLabel(deck) }} ({{ cardTotal(deck.cards) }})</option>
              }
            </select>
          </label>

          @if (decks().length === 0) {
            <p class="m-0 text-xs text-muted">
              No saved decks found. Log in and save a deck in the deck builder to play with it. Starter decks are random until then.
            </p>
          }
          @if (!cardsReady()) {
            <p class="m-0 text-xs text-muted">Card data is still loading.</p>
          }
          @if (error(); as err) {
            <p class="m-0 text-xs text-red-300">{{ err }}</p>
          }
        </section>

        <section class="grid grid-cols-1 gap-3 md:grid-cols-3">
          <button
            type="button"
            class="flex flex-col gap-1 rounded-xl border border-accent bg-ink-1 p-4 text-left text-fg hover:bg-ink-2 disabled:opacity-60"
            [disabled]="!cardsReady()"
            (click)="startSolo()">
            <span class="font-semibold">Solo (control both sides)</span>
            <span class="text-xs text-muted">One screen, both boards. Hand the device over between turns.</span>
          </button>
          <button
            type="button"
            class="flex flex-col gap-1 rounded-xl border border-line bg-ink-1 p-4 text-left text-fg opacity-60"
            disabled>
            <span class="font-semibold">Vs Bot</span>
            <span class="text-xs text-muted">Coming soon</span>
          </button>
          <button
            type="button"
            class="flex flex-col gap-1 rounded-xl border border-line bg-ink-1 p-4 text-left text-fg opacity-60"
            disabled>
            <span class="font-semibold">Online PvP</span>
            <span class="text-xs text-muted">Coming soon</span>
          </button>
        </section>
      </div>
    </digimon-page>
  `,
})
export class PlayLobbyComponent {
  protected readonly session = inject(GameSession);
  private readonly router = inject(Router);
  private readonly saveStore = inject(SaveStore);
  private readonly cardStore = inject(DigimonCardStore);

  protected readonly random = RANDOM_OPPONENT;
  protected readonly starter = STARTER_OPPONENT;
  protected readonly decks = computed(() => this.saveStore.decks() ?? []);
  protected readonly cardsReady = computed(() => this.cardStore.cards().length > 0);
  protected readonly myDeckId = signal<string>('');
  protected readonly opponentId = signal<string>(RANDOM_OPPONENT);
  protected readonly error = signal<string | null>(null);
  /** The selected deck, falling back to the first saved deck so the select and the start action agree. */
  protected readonly myDeck = computed(() => this.decks().find((d) => d.id === this.myDeckId()) ?? this.decks()[0] ?? null);

  protected readonly deckLabel = deckLabel;

  protected cardTotal(cards: { count: number }[]): number {
    return cards.reduce((n, c) => n + c.count, 0);
  }

  startSolo(): void {
    this.error.set(null);
    const cards = this.cardStore.cardsMap();
    const decks = this.decks();

    const mine = this.myDeck();
    const p1: DeckListEntry[] = mine ? toDeckList(mine.cards, cards) : randomStarterDeck(this.cardStore.cards());

    const choice = this.opponentId();
    const theirs =
      choice === STARTER_OPPONENT
        ? null
        : choice === RANDOM_OPPONENT
          ? decks.length > 0
            ? decks[Math.floor(Math.random() * decks.length)]
            : null
          : (decks.find((d) => d.id === choice) ?? null);
    const p2: DeckListEntry[] = theirs ? toDeckList(theirs.cards, cards) : randomStarterDeck(this.cardStore.cards());

    if (p1.length === 0 || p2.length === 0) {
      this.error.set('Could not build a deck. Card data may still be loading.');
      return;
    }

    this.session.start({
      decks: [p1, p2],
      names: [mine ? deckLabel(mine) : 'Player 1', theirs ? deckLabel(theirs) : 'Starter deck'],
    });
    void this.router.navigateByUrl('/play/table');
  }
}
