/**
 * Assisted-mode legality. `assistedError` returns a readable reason when a command breaks the rules, or null when
 * it is allowed. It never changes state. The reducer throws the message, so the UI shows it as an error toast.
 */
import { Command } from '../commands';
import { cardInfo } from './card-data';
import { canPay, digivolveCost, findStack, hasKeyword, other, sideColors, topInfo } from './helpers';
import { GameState } from '../types';

/**
 * Commands that change the board by hand (effects, corrections). In assisted mode they need Force.
 * The rules commands (turn flow, play, digivolve, attack, decisions) and coin/dice/shuffle do not.
 */
export const MANUAL_COMMANDS = new Set<Command['type']>([
  'setup',
  'draw',
  'moveCard',
  'revealSecurity',
  'setFaceUp',
  'suspend',
  'unsuspend',
  'unsuspendAll',
  'setStackFaceDown',
  'adjustDp',
  'addMarker',
  'adjustCounter',
  'removeMarker',
  'trashStack',
  'returnToHand',
  'stackToDeck',
  'setMemory',
  'changeMemoryBy',
]);

const DECISIONS = new Set<Command['type']>(['resolveBlock', 'securityCheck']);

export function assistedError(state: GameState, cmd: Command): string | null {
  if (state.mode !== 'assisted' || cmd.force) return null;
  const pending = state.pending ?? null;
  if (state.winner !== null && state.winner !== undefined) return 'The game is over. Start a new game to keep playing.';

  if (pending) {
    const waiting = `Waiting for ${state.players[pending.owner].name} to resolve ${
      pending.kind === 'block' ? 'a block' : 'a security check'
    }.`;
    if (!DECISIONS.has(cmd.type)) return waiting;
    if (cmd.player !== pending.owner) return waiting;
    if (cmd.type === 'resolveBlock' && pending.kind !== 'block') return 'No block decision is pending.';
    if (cmd.type === 'securityCheck' && pending.kind !== 'security') return 'No security check is pending.';
    return null;
  }

  if (DECISIONS.has(cmd.type)) return 'No decision is pending.';
  if (MANUAL_COMMANDS.has(cmd.type)) return 'Manual change: turn on Force to apply it.';

  const active = state.activePlayer;
  const p = state.players[cmd.player];
  const myTurn = cmd.player === active;

  switch (cmd.type) {
    case 'nextPhase':
      if (!myTurn) return 'Only the active player can change the phase.';
      if (state.phase !== 'breeding') return 'Phases advance automatically. Breeding is the only phase you skip manually; End the turn with Pass.';
      return null;

    case 'passTurn':
      if (!myTurn) return 'Only the active player can end the turn.';
      if (state.phase !== 'breeding' && state.phase !== 'main') return 'You can only end the turn in the breeding or main phase.';
      return null;

    case 'hatch':
      if (!myTurn || state.phase !== 'breeding') return 'Hatching happens in your breeding phase.';
      if (p.breeding) return 'Your breeding area is occupied.';
      if (p.eggDeck.length === 0) return 'Your egg deck is empty.';
      return null;

    case 'moveBreedingToBattle': {
      if (!myTurn || state.phase !== 'breeding') return 'Moving from breeding happens in your breeding phase.';
      if (!p.breeding) return 'Your breeding area is empty.';
      const level = topInfo(p.breeding)?.level ?? null;
      if (level === null || level < 3) return 'Only a Lv.3 or higher Digimon can move from breeding to battle.';
      return null;
    }

    case 'playFromHand': {
      if (!myTurn || state.phase !== 'main') return 'Cards are played in your main phase.';
      const card = p.hand.find((c) => c.uid === cmd.uid);
      if (!card) return 'That card is not in your hand.';
      const info = cardInfo(card.cardId);
      if (!info) return 'Unknown card: its rules data is missing.';
      if (info.kind === 'egg') return 'Digi-Eggs cannot be played from hand. Hatch them in breeding.';
      if (cmd.to === 'battle' && info.kind !== 'digimon') return 'Only a Digimon can be played to the battle area.';
      if (cmd.to === 'tamer' && info.kind !== 'tamer') return 'Only a Tamer can be played to the tamer area.';
      if (cmd.to === 'option' && info.kind !== 'option') return 'Only an Option can be played to the option area.';
      if (cmd.to === 'option') {
        const missing = info.optionColors.filter((c) => !sideColors(p).has(c));
        if (missing.length > 0) return `Option needs a ${missing.join(' and ')} Digimon or Tamer on your side.`;
      }
      if (!canPay(state, info.playCost)) return `Not enough memory: this costs ${info.playCost}.`;
      return null;
    }

    case 'digivolve': {
      if (!myTurn || state.phase !== 'main') return 'Digivolution happens in your main phase.';
      const card = p.hand.find((c) => c.uid === cmd.handUid);
      if (!card) return 'That card is not in your hand.';
      const info = cardInfo(card.cardId);
      if (!info || info.kind !== 'digimon') return 'Only a Digimon in hand can digivolve.';
      const target = findStack(p, cmd.onto);
      if (!target || (target !== p.breeding && !p.battle.includes(target))) {
        return 'Digivolve onto a Digimon in your battle or breeding area.';
      }
      const cost = digivolveCost(target, info);
      if (cost === null) return `${info.name} cannot digivolve onto that Digimon (level or colour does not match).`;
      if (!canPay(state, cost)) return `Not enough memory: this digivolution costs ${cost}.`;
      return null;
    }

    case 'attack': {
      if (!myTurn || state.phase !== 'main') return 'Attacks happen in your main phase.';
      const attacker = p.battle.find((s) => s.stackId === cmd.attackerStackId);
      if (!attacker) return 'Only a Digimon in your battle area can attack.';
      if (attacker.suspended) return 'A suspended Digimon cannot attack.';
      if (attacker.enteredTurn === state.turn && !hasKeyword(attacker, 'Rush')) {
        return 'That Digimon entered play this turn. Only a Digimon with Rush can attack.';
      }
      const target = cmd.target;
      if (target.kind === 'stack') {
        const defender = state.players[other(cmd.player)].battle.find((s) => s.stackId === target.stackId);
        if (!defender) return 'That target is not in the opponent battle area.';
        if (!defender.suspended) return 'You can only attack a suspended Digimon, or the opponent.';
      }
      return null;
    }

    default:
      return null;
  }
}
