/**
 * Attacks, blocks, battles and security checks (assisted mode). Each function mutates the (cloned) state.
 * Legality is checked beforehand by validate.ts; the functions here assume a legal command.
 */
import { Command } from '../commands';
import { cardInfo } from './card-data';
import {
  deleteOwnStack,
  findStack,
  hasKeyword,
  log,
  other,
  remind,
  remindStack,
  securityChecks,
  setWinner,
  stackDp,
  stackName,
} from './helpers';
import { cardLabel } from '../labels';
import { CombatResult, GameState, PlayerIndex } from '../types';

export type AttackCommand = Extract<Command, { type: 'attack' }>;

/** Declares an attack: suspends the attacker, then either battles a suspended Digimon or goes to the player. */
export function declareAttack(state: GameState, cmd: AttackCommand): void {
  const atk = cmd.player;
  const def = other(atk);
  const attacker = findStack(state.players[atk], cmd.attackerStackId);
  if (!attacker) throw new Error('Attacker not found');
  attacker.suspended = true;
  remindStack(state, atk, attacker, 'When Attacking');

  if (cmd.target.kind === 'stack') {
    const defender = findStack(state.players[def], cmd.target.stackId);
    if (!defender) throw new Error('Target not found');
    log(state, atk, `${stackName(attacker)} attacks ${stackName(defender)}.`);
    battle(state, atk, attacker.stackId, def, defender.stackId);
    return;
  }

  log(state, atk, `${stackName(attacker)} attacks ${state.players[def].name}.`);
  const checks = securityChecks(attacker);
  const blockers = state.players[def].battle.filter((s) => !s.suspended && hasKeyword(s, 'Blocker')).map((s) => s.stackId);
  if (blockers.length > 0) {
    state.pending = {
      kind: 'block',
      owner: def,
      attacker: atk,
      attackerStackId: attacker.stackId,
      blockers,
      checks,
    };
    log(state, def, `${state.players[def].name} may block with a Blocker, or take the attack.`);
    return;
  }
  log(state, def, `No Blocker: the attack goes through.`);
  startSecurity(state, atk, attacker.stackId, checks);
}

/** The defender's answer to a pending block. `null` takes the attack. */
export function resolveBlock(state: GameState, blockerStackId: string | null): void {
  const pending = state.pending;
  if (!pending || pending.kind !== 'block') throw new Error('No block decision is pending.');
  state.pending = null;
  const atk = pending.attacker;
  const def = pending.owner;
  if (blockerStackId === null) {
    log(state, def, `${state.players[def].name} does not block.`);
    startSecurity(state, atk, pending.attackerStackId, pending.checks);
    return;
  }
  if (!pending.blockers.includes(blockerStackId)) throw new Error('That Digimon cannot block this attack.');
  const blocker = findStack(state.players[def], blockerStackId);
  if (!blocker || blocker.suspended) throw new Error('That Blocker is not available.');
  const attacker = findStack(state.players[atk], pending.attackerStackId);
  if (!attacker) throw new Error('Attacker not found');
  const piercing = hasKeyword(attacker, 'Piercing');

  blocker.suspended = true;
  log(state, def, `${stackName(blocker)} blocks.`);
  const result = battle(state, atk, attacker.stackId, def, blocker.stackId);
  if (piercing && result.defenderDeleted && !result.attackerDeleted) {
    log(state, atk, 'Piercing: the attack continues to the security check.');
    startSecurity(state, atk, attacker.stackId, pending.checks);
  }
}

/** Starts the security checks of an attack on the player. Empty security means the attacker wins. */
export function startSecurity(state: GameState, atk: PlayerIndex, attackerStackId: string, checks: number): void {
  if (checks <= 0) return;
  const def = other(atk);
  if (state.players[def].security.length === 0) {
    setWinner(state, atk, `${state.players[def].name} had no security cards left`);
    return;
  }
  state.pending = { kind: 'security', owner: def, attacker: atk, attackerStackId, remaining: checks };
  log(state, def, `${state.players[def].name} performs ${checks} security check(s).`);
}

/** The owner's client resolves one security check: reveal the top card and apply it. */
export function securityCheck(state: GameState): void {
  const pending = state.pending;
  if (!pending || pending.kind !== 'security') throw new Error('No security check is pending.');
  const def = pending.owner;
  const atk = pending.attacker;
  const defP = state.players[def];
  const sec = defP.security.pop();
  if (!sec) {
    setWinner(state, atk, `${defP.name} had no security cards left`);
    return;
  }
  const info = cardInfo(sec.cardId);
  log(state, def, `Security check reveals ${cardLabel(sec.cardId)}.`);
  defP.trash.push({ uid: sec.uid, cardId: sec.cardId });

  let attackerGone = false;
  const attacker = findStack(state.players[atk], pending.attackerStackId);
  const revealed = cardLabel(sec.cardId);
  if (!attacker) {
    attackerGone = true;
  } else if (info?.kind === 'digimon') {
    const atkDp = stackDp(attacker);
    const secDp = info.dp;
    log(state, atk, `Security Digimon (${secDp} DP) battles ${stackName(attacker)} (${atkDp} DP).`);
    const deleted = atkDp <= secDp && !hasKeyword(attacker, 'Jamming');
    setCombat(state, {
      kind: 'security',
      attacker: atk,
      attackerName: stackName(attacker),
      attackerDp: atkDp,
      defenderName: revealed,
      defenderDp: secDp,
      revealedCardId: sec.cardId,
      attackerDeleted: deleted,
      defenderDeleted: false,
    });
    if (deleted) {
      deleteOwnStack(state, atk, attacker.stackId);
      attackerGone = true;
    }
  } else {
    remind(state, def, sec.cardId, 'Security');
    setCombat(state, {
      kind: 'security',
      attacker: atk,
      attackerName: stackName(attacker),
      attackerDp: stackDp(attacker),
      defenderName: revealed,
      defenderDp: null,
      revealedCardId: sec.cardId,
      attackerDeleted: false,
      defenderDeleted: false,
    });
  }

  if (attackerGone) {
    state.pending = null;
    return;
  }
  const remaining = pending.remaining - 1;
  if (remaining <= 0) {
    state.pending = null;
    return;
  }
  if (defP.security.length === 0) {
    setWinner(state, atk, `${defP.name} had no security cards left`);
    return;
  }
  state.pending = { ...pending, remaining };
}

/**
 * Battle between two battle-area stacks. Lower DP is deleted, a tie deletes both. Retaliation deletes the other
 * stack when it is deleted in battle.
 */
export function battle(
  state: GameState,
  atkOwner: PlayerIndex,
  atkId: string,
  defOwner: PlayerIndex,
  defId: string,
): { attackerDeleted: boolean; defenderDeleted: boolean } {
  const a = findStack(state.players[atkOwner], atkId);
  const d = findStack(state.players[defOwner], defId);
  if (!a || !d) throw new Error('Battle stack not found');
  const ad = stackDp(a);
  const dd = stackDp(d);
  let attackerDeleted = ad <= dd;
  let defenderDeleted = dd <= ad;
  if (attackerDeleted && hasKeyword(a, 'Retaliation')) defenderDeleted = true;
  if (defenderDeleted && hasKeyword(d, 'Retaliation')) attackerDeleted = true;
  log(state, atkOwner, `Battle: ${ad} DP vs ${dd} DP.`);
  setCombat(state, {
    kind: 'battle',
    attacker: atkOwner,
    attackerName: stackName(a),
    attackerDp: ad,
    defenderName: stackName(d),
    defenderDp: dd,
    attackerDeleted,
    defenderDeleted,
  });
  if (attackerDeleted) deleteOwnStack(state, atkOwner, atkId);
  if (defenderDeleted) deleteOwnStack(state, defOwner, defId);
  return { attackerDeleted, defenderDeleted };
}

type CombatInput = Omit<CombatResult, 'seq'>;

/** Stores the latest combat record. `seq` is the log length now, which only grows. */
function setCombat(state: GameState, result: CombatInput): void {
  state.lastCombat = { ...result, seq: state.log.length };
}
