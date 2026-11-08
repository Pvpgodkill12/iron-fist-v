export type LimbButton = 'lp' | 'rp' | 'lk' | 'rk';
export const LIMB_BUTTONS: readonly LimbButton[] = ['lp', 'rp', 'lk', 'rk'] as const;

export type AttackHeight = 'high' | 'mid' | 'low';

export type MoveAnimKind =
  | 'jab_l'
  | 'straight_r'
  | 'hook_r'
  | 'uppercut_r'
  | 'electric_upper'
  | 'demon_paw'
  | 'deathfist'
  | 'hammer_fist'
  | 'front_kick_l'
  | 'roundhouse_r'
  | 'axe_kick'
  | 'low_sweep'
  | 'hell_sweep'
  | 'hopkick'
  | 'somersault'
  | 'spin_back_kick'
  | 'flying_kick'
  | 'knee_strike'
  | 'katana_slash'
  | 'katana_spin'
  | 'throw_suplex'
  | 'rage_art';

export interface StringFollowup {
  button: LimbButton;
  move: MoveData;
}

export interface MoveData {
  id: string;
  name: string;
  notation?: string;
  height: AttackHeight;
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  reach: number;
  hitstun: number;
  blockstun: number;
  pushback: number;
  anim: MoveAnimKind;
  limb: LimbButton | 'both' | 'weapon';
  /** Launches opponent into an aerial juggle */
  launch?: boolean;
  launchVy?: number;
  /** Bounds/Tornadoes an already airborne opponent once per combo! */
  bound?: boolean;
  /** Knocks grounded opponent flat onto the floor */
  knockdown?: boolean;
  /** Tracks 3D sidestepping opponents (Tekken Homing move) */
  homing?: boolean;
  /** Unblockable attack with warning sparks */
  unblockable?: boolean;
  /** Armored Power Crush absorbs high/mid attacks from frame 6 */
  armor?: boolean;
  /** Grounded throw */
  isThrow?: boolean;
  /** Electric / Mishima lightning visual FX */
  electric?: boolean;
  /** Forward dash momentum applied during startup */
  advance?: number;
  /** Follow-up string branches */
  next?: readonly StringFollowup[];
}

export interface CommandSpecial {
  notation: string;
  move: MoveData;
}

export type StanceStyle =
  | 'mishima'
  | 'kazuya'
  | 'taekwondo'
  | 'jeetkunedo'
  | 'brawler'
  | 'wrestler'
  | 'assassin'
  | 'kungfu'
  | 'cyberninja'
  | 'capoeira'
  | 'boxer'
  | 'demon_boss';

export type HeadGearKind =
  | 'spiky_black'
  | 'swept_widow'
  | 'headband_spiky'
  | 'bruce_crop'
  | 'tall_flattop'
  | 'jaguar_mask'
  | 'blonde_ponytail'
  | 'twin_buns'
  | 'oni_cyber_helm'
  | 'dreadlocks'
  | 'slick_blonde'
  | 'demon_crown';

export interface CostumePalette {
  label: string;
  skin: string;
  top: string;
  pants: string;
  trim: string;
  gloves: string;
  boots: string;
  hair: string;
  aura: string;
  bareChest?: boolean;
  cape?: boolean;
  katana?: boolean;
  demonWings?: boolean;
}

export interface CharacterData {
  id: string;
  name: string;
  subtitle: string;
  country: string;
  martialArt: string;
  archetype: string;
  difficultyStars: 1 | 2 | 3 | 4 | 5;
  maxHp: number;
  walkSpeed: number;
  backSpeed: number;
  sidestepSpeed: number;
  bodyScale: [number, number, number]; // [width, height, depth]
  stance: StanceStyle;
  headGear: HeadGearKind;
  costumes: [CostumePalette, CostumePalette];
  normals: Record<LimbButton, MoveData>;
  specials: readonly CommandSpecial[];
  throws: [MoveData, MoveData]; // [1+3 break w/ 1, 2+4 break w/ 2]
  powerCrush: MoveData; // 1+2 outside rage
  kiSpecial: MoveData; // 3+4 Heat / Special Burst
  rageArt: MoveData; // 1+2 in Rage (<25% HP)
}

export type StageId =
  | 'moonlit_wilderness'
  | 'honmaru_dojo'
  | 'cathedral_retribution'
  | 'dragons_nest'
  | 'neotokyo_helipad';

export interface StageDefinition {
  id: StageId;
  name: string;
  subtitle: string;
  halfWidth: number;
  halfDepth: number;
  hasWalls: boolean;
  reflectiveFloor: boolean;
  wetness: number;
  skyHex: string;
  sunDir: [number, number, number];
  sunHex: string;
  sunIntensity: number;
  ambientHex: string;
  groundAmbientHex: string;
  fogHex: string;
  fogDensity: number;
  accentHex: string;
  particleTheme: 'lilies' | 'embers' | 'cathedral_sparks' | 'mountain_mist' | 'neon_rain';
  bgmStyle: 'moonlit' | 'honmaru' | 'cathedral' | 'dragon' | 'neotokyo';
}

export type GameMode = 'arcade' | 'vs_cpu' | 'vs_p2' | 'practice';
export type AiDifficulty = 1 | 2 | 3 | 4; // 1=Easy, 2=Medium, 3=Hard, 4=Tekken God
export type DummyBehavior = 'stand' | 'crouch' | 'guard_all' | 'sidestep' | 'cpu_spar';
