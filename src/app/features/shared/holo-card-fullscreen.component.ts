import {
  ApplicationRef,
  AfterViewInit,
  Component,
  createComponent,
  EnvironmentInjector,
  EventEmitter,
  OnDestroy,
  Output,
  ViewChild,
  ElementRef,
  Input,
} from '@angular/core';
import { DigimonCard } from '@models';
import { HoloCard3dComponent } from './holo-card-3d.component';

/**
 * Full-screen overlay showing one holo card large. Not rendered in a template: open it with
 * openHoloCardFullscreen(), which attaches it to document.body so it sits above any dialog
 * and is not clipped by transformed ancestors.
 */
@Component({
  selector: 'digimon-holo-card-fullscreen',
  standalone: true,
  imports: [HoloCard3dComponent],
  styleUrls: ['./holo-card-fullscreen.component.scss'],
  template: `
    <div class="hf-backdrop" (click)="closed.emit()">
      <button #closeBtn type="button" class="hf-close" aria-label="Close 3D view" (click)="$event.stopPropagation(); closed.emit()">Close</button>
      <div class="hf-stage" (click)="$event.stopPropagation()">
        <digimon-holo-card-3d [card]="card"></digimon-holo-card-3d>
      </div>
      <p class="hf-hint">Move over the card to tilt · click to flip · Esc or click outside to close</p>
    </div>
  `,
})
export class HoloCardFullscreenComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) card!: DigimonCard;
  @Output() closed = new EventEmitter<void>();

  @ViewChild('closeBtn') closeBtn?: ElementRef<HTMLButtonElement>;

  // Capture phase on window so Esc is handled before PrimeNG's document listener closes the dialog underneath.
  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.closed.emit();
  };

  ngAfterViewInit(): void {
    window.addEventListener('keydown', this.onKeydown, true);
    this.closeBtn?.nativeElement.focus();
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.onKeydown, true);
  }
}

/**
 * Opens the full-screen 3D card overlay for a card. Returns a function that closes it (no-op if already closed).
 */
export function openHoloCardFullscreen(appRef: ApplicationRef, injector: EnvironmentInjector, card: DigimonCard): () => void {
  const ref = createComponent(HoloCardFullscreenComponent, { environmentInjector: injector });
  ref.setInput('card', card);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    subscription.unsubscribe();
    appRef.detachView(ref.hostView);
    ref.destroy();
    ref.location.nativeElement.remove();
  };
  const subscription = ref.instance.closed.subscribe(close);
  appRef.attachView(ref.hostView);
  document.body.appendChild(ref.location.nativeElement);
  return close;
}
