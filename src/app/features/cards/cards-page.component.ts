import { SeoService } from '@services';
import { ApplicationRef, ChangeDetectionStrategy, Component, EnvironmentInjector, inject, signal } from '@angular/core';
import { DigimonCard } from '@models';
import { DialogStore } from '@store';
import { PaginationCardListComponent } from '../collection/components/pagination-card-list.component';
import { PageComponent } from '../shared/page.component';
import { CardDetailPanelComponent } from './card-detail-panel.component';
import { openHoloCardFullscreen } from '../shared/holo-card-fullscreen.component';

@Component({
  selector: 'digimon-cards-page',
  template: `
    <digimon-page>
      <div class="flex w-screen h-[calc(var(--app-vh)-7.5rem)] md:h-[calc(var(--app-vh)-5rem)]">
        <!-- collectionOnly: a click shows the card instead of adding it to a deck -->
        <digimon-pagination-card-list
          [collectionOnly]="true"
          [dialogOnView]="false"
          [showCollectionMode]="false"
          (cardViewed)="select($event)"
          class="flex flex-row flex-1 min-w-0 h-full"></digimon-pagination-card-list>
        <aside aria-label="Card details" class="hidden xl:block w-[22rem] shrink-0 overflow-y-auto border-l border-line bg-ink-1 p-4">
          <digimon-card-detail-panel [card]="selected()"></digimon-card-detail-panel>
        </aside>
      </div>
    </digimon-page>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [PaginationCardListComponent, PageComponent, CardDetailPanelComponent],
})
export class CardsPageComponent {
  private seo = inject(SeoService);
  private dialogStore = inject(DialogStore);
  private appRef = inject(ApplicationRef);
  private envInjector = inject(EnvironmentInjector);
  selected = signal<DigimonCard | null>(null);

  constructor() {
    this.seo.set('Card search', 'Search every Digimon Card Game card by name, number, color, level, set and effect, with rulings and prices.');
  }

  // The side panel only exists on xl screens; smaller screens keep the dialog
  // Clicking the already-selected card again (or double-clicking it) opens the 3D view
  select(card: DigimonCard) {
    const wide = window.matchMedia('(min-width: 1280px)').matches;
    if (wide && this.selected()?.id === card.id) {
      openHoloCardFullscreen(this.appRef, this.envInjector, card);
      return;
    }
    this.selected.set(card);
    if (!wide) {
      this.dialogStore.updateViewCardDialog({ show: true, card, width: '50vw' });
    }
  }
}
