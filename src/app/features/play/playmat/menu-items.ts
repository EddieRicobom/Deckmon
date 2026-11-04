import { Command } from '../core/commands';
import { getStack, locateCard } from '../core/game';
import { cardLabel } from '../core/labels';
import { cardInfo } from '../core/rules/card-data';
import { digivolveCost } from '../core/rules/helpers';
import { assistedError } from '../core/rules/validate';
import { GameState, PlayerIndex, PileZone, StackZone, Zone } from '../core/types';

export type MenuTarget =
  | { kind: 'pile'; owner: PlayerIndex; zone: PileZone }
  | { kind: 'card'; owner: PlayerIndex; uid: string; zone: Zone }
  | { kind: 'stack'; owner: PlayerIndex; stackId: string; zone: StackZone };

export interface MenuItem {
  label: string;
  /** Command to send when chosen. */
  cmd?: Command;
  /** Pins the stack in the inspect panel, where counters and markers are edited inline. */
  inspect?: boolean;
  /** dp and marker items are also shown as inline controls in the inspect panel, so the panel skips them. */
  group?: 'dp' | 'marker';
  separator?: boolean;
  danger?: boolean;
  /** Starts target selection for an attack with this stack (battle Digimon only). */
  attack?: boolean;
  /** Why the item cannot be used right now (assisted rules). Undefined when it can. Shown as the tooltip. */
  disabled?: string;
}

const DP_STEPS = [1000, -1000, 2000, -2000];

/**
 * Builds the right-click / long-press menu for a card, stack or pile. Pure: no DOM, no Angular.
 * In assisted mode every command item carries the engine's reason when it is not allowed (Force lifts the rules).
 */
export function menuItemsFor(target: MenuTarget, state: GameState, force = false): MenuItem[] {
  return explain(buildItems(target, state), state, force);
}

/** Adds the engine's reason to every command item that the assisted rules refuse. */
function explain(items: MenuItem[], state: GameState, force: boolean): MenuItem[] {
  if (state.mode !== 'assisted' || force) return items;
  return items.map((item) => {
    if (!item.cmd || item.disabled) return item;
    const reason = assistedError(state, item.cmd);
    return reason ? { ...item, disabled: reason } : item;
  });
}

/** Reason an attack from this battle stack is refused, or undefined when it may start (player as the target). */
export function attackReason(state: GameState, owner: PlayerIndex, stackId: string): string | undefined {
  const reason = assistedError(state, { type: 'attack', player: owner, attackerStackId: stackId, target: { kind: 'player' } });
  return reason ?? undefined;
}

function buildItems(target: MenuTarget, state: GameState): MenuItem[] {
  const p = state.players[target.owner];
  const owner = target.owner;

  if (target.kind === 'pile') {
    switch (target.zone) {
      case 'deck':
        return [
          { label: 'Draw 1', cmd: { type: 'draw', player: owner, count: 1 } },
          { label: 'Draw 5', cmd: { type: 'draw', player: owner, count: 5 } },
          { label: 'Shuffle deck', cmd: { type: 'shuffleDeck', player: owner, zone: 'deck' } },
          ...(state.turn === 1
            ? [{ label: 'Mulligan (hand to deck, draw 5)', cmd: { type: 'mulligan', player: owner } as Command, separator: true }]
            : []),
          { label: 'Reset board (new opening hand)', cmd: { type: 'setup', player: owner }, danger: true },
        ];
      case 'eggDeck':
        return [
          { label: 'Hatch (egg to breeding)', cmd: { type: 'hatch', player: owner } },
          { label: 'Shuffle egg deck', cmd: { type: 'shuffleDeck', player: owner, zone: 'eggDeck' } },
        ];
      case 'security':
        return [
          { label: 'Reveal top security', cmd: { type: 'revealSecurity', player: owner, position: 'top' } },
          { label: 'Reveal bottom security', cmd: { type: 'revealSecurity', player: owner, position: 'bottom' } },
        ];
      default:
        return [];
    }
  }

  if (target.kind === 'stack') {
    const stack = getStack(p, target.stackId);
    if (!stack) return [];
    const items: MenuItem[] = [];
    if (target.zone === 'breeding') {
      items.push({ label: 'Move to battle area', cmd: { type: 'moveBreedingToBattle', player: owner } });
    }
    if (target.zone === 'battle' && state.mode === 'assisted' && !stack.faceDown) {
      items.push({ label: 'Attack...', attack: true, disabled: attackReason(state, owner, stack.stackId) });
    }
    items.push(
      stack.suspended
        ? { label: 'Unsuspend', cmd: { type: 'unsuspend', player: owner, stackId: stack.stackId } }
        : { label: 'Suspend (rotate)', cmd: { type: 'suspend', player: owner, stackId: stack.stackId } },
      {
        label: stack.faceDown ? 'Turn face-up' : 'Turn face-down',
        cmd: { type: 'setStackFaceDown', player: owner, stackId: stack.stackId, faceDown: !stack.faceDown },
      },
    );
    items.push({ label: '', separator: true });
    for (const delta of DP_STEPS) {
      items.push({
        label: `DP ${delta > 0 ? '+' : ''}${delta}`,
        cmd: { type: 'adjustDp', player: owner, stackId: stack.stackId, delta },
        group: 'dp',
      });
    }
    items.push({ label: 'Counters, markers and DP...', inspect: true, group: 'marker' });
    items.push({ label: '', separator: true });
    items.push({ label: 'Return to hand', cmd: { type: 'returnToHand', player: owner, stackId: stack.stackId } });
    items.push({ label: 'Put on top of deck', cmd: { type: 'stackToDeck', player: owner, stackId: stack.stackId, position: 'top' } });
    items.push({ label: 'Put on bottom of deck', cmd: { type: 'stackToDeck', player: owner, stackId: stack.stackId, position: 'bottom' } });
    items.push({ label: 'Trash', cmd: { type: 'trashStack', player: owner, stackId: stack.stackId }, danger: true });
    return items;
  }

  // Single card
  const loc = locateCard(p, target.uid);
  if (!loc) return [];
  const uid = target.uid;
  const items: MenuItem[] = [];

  if (loc.kind === 'stack') {
    const stack = getStack(p, loc.stackId);
    const isTop = stack ? loc.index === stack.cards.length - 1 : false;
    if (!isTop) {
      items.push({
        label: 'Send this digivolution card to trash',
        cmd: { type: 'moveCard', player: owner, uid, to: 'trash' },
        danger: true,
      });
      items.push({ label: 'Send this digivolution card to hand', cmd: { type: 'moveCard', player: owner, uid, to: 'hand' } });
    }
    return items;
  }

  switch (loc.zone) {
    case 'hand': {
      const handCard = p.hand.find((c) => c.uid === uid);
      const info = handCard ? cardInfo(handCard.cardId) : undefined;
      const playCost = info ? ` (cost ${info.playCost})` : '';
      const digivolveTargets = [...(p.breeding ? [p.breeding] : []), ...p.battle];
      for (const stack of digivolveTargets) {
        const top = stack.cards[stack.cards.length - 1]?.cardId ?? '';
        const cost = info ? digivolveCost(stack, info) : null;
        items.push({
          label: `Digivolve onto ${cardLabel(top)}${cost !== null ? ` (cost ${cost})` : ''}`,
          cmd: { type: 'digivolve', player: owner, handUid: uid, onto: stack.stackId },
        });
      }
      items.push(
        { label: `Play to battle area${playCost}`, cmd: { type: 'playFromHand', player: owner, uid, to: 'battle' } },
        { label: `Play to tamer area${playCost}`, cmd: { type: 'playFromHand', player: owner, uid, to: 'tamer' } },
        { label: `Play to option area${playCost}`, cmd: { type: 'playFromHand', player: owner, uid, to: 'option' } },
        { label: 'Move to breeding', cmd: { type: 'moveCard', player: owner, uid, to: 'breeding' } },
        { label: 'Reveal', cmd: { type: 'moveCard', player: owner, uid, to: 'reveal' }, separator: true },
        { label: 'Put on top of deck', cmd: { type: 'moveCard', player: owner, uid, to: 'deck', position: 'top' } },
        { label: 'Put on bottom of deck', cmd: { type: 'moveCard', player: owner, uid, to: 'deck', position: 'bottom' } },
        { label: 'Put into egg deck', cmd: { type: 'moveCard', player: owner, uid, to: 'eggDeck', position: 'top' } },
        { label: 'Put on top of security', cmd: { type: 'moveCard', player: owner, uid, to: 'security', position: 'top', faceUp: false } },
        { label: 'Trash', cmd: { type: 'moveCard', player: owner, uid, to: 'trash' }, danger: true },
      );
      break;
    }
    case 'security': {
      const card = p.security[loc.index];
      items.push(
        { label: 'Reveal', cmd: { type: 'moveCard', player: owner, uid, to: 'reveal' } },
        {
          label: card?.faceUp ? 'Turn face-down' : 'Turn face-up',
          cmd: { type: 'setFaceUp', player: owner, uid, faceUp: !card?.faceUp },
        },
        { label: 'Add to hand', cmd: { type: 'moveCard', player: owner, uid, to: 'hand' } },
        { label: 'Trash', cmd: { type: 'moveCard', player: owner, uid, to: 'trash' }, danger: true },
      );
      break;
    }
    case 'reveal':
      items.push(
        { label: 'Add to hand', cmd: { type: 'moveCard', player: owner, uid, to: 'hand' } },
        { label: 'Back to top of security', cmd: { type: 'moveCard', player: owner, uid, to: 'security', position: 'top', faceUp: false } },
        { label: 'Put on top of deck', cmd: { type: 'moveCard', player: owner, uid, to: 'deck', position: 'top' } },
        { label: 'Trash', cmd: { type: 'moveCard', player: owner, uid, to: 'trash' }, danger: true },
      );
      break;
    case 'trash':
      items.push({ label: 'Return to hand', cmd: { type: 'moveCard', player: owner, uid, to: 'hand' } });
      break;
  }
  return items;
}
