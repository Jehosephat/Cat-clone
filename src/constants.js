export const RESOURCES = ['brick', 'lumber', 'wool', 'grain', 'ore'];

export const TERRAIN_RESOURCE = {
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
  desert: null,
};

export const RESOURCE_LABEL = {
  brick: 'Brick',
  lumber: 'Lumber',
  wool: 'Wool',
  grain: 'Grain',
  ore: 'Ore',
};

export const RESOURCE_ICON = {
  brick: '🧱',
  lumber: '🪵',
  wool: '🐑',
  grain: '🌾',
  ore: '⛰️',
};

export const TERRAIN_LABEL = {
  hills: 'Hills',
  forest: 'Forest',
  pasture: 'Pasture',
  fields: 'Fields',
  mountains: 'Mountains',
  desert: 'Desert',
};

export const COSTS = {
  road: { brick: 1, lumber: 1 },
  settlement: { brick: 1, lumber: 1, wool: 1, grain: 1 },
  city: { ore: 3, grain: 2 },
  devCard: { ore: 1, wool: 1, grain: 1 },
};

export const PIECE_LIMITS = { roads: 15, settlements: 5, cities: 4 };

export const DEV_CARDS = {
  knight: 14,
  victoryPoint: 5,
  roadBuilding: 2,
  yearOfPlenty: 2,
  monopoly: 2,
};

export const DEV_CARD_LABEL = {
  knight: 'Knight',
  victoryPoint: 'Victory Point',
  roadBuilding: 'Road Building',
  yearOfPlenty: 'Year of Plenty',
  monopoly: 'Monopoly',
  hidden: 'Face-down card',
};

export const DEV_CARD_TEXT = {
  knight: 'Move the robber. Steal 1 resource from the owner of a settlement or city adjacent to the robber’s new hex.',
  victoryPoint: '1 Victory Point! Reveal this card on your turn if, with it, you reach the number of points required for victory.',
  roadBuilding: 'Place 2 new roads as if you had just built them.',
  yearOfPlenty: 'Take any 2 resources from the bank. Add them to your hand. They can be 2 of the same resource or 2 different resources.',
  monopoly: 'When you play this card, announce 1 type of resource. All other players must give you all of their resources of that type.',
  hidden: 'Turned face up once the undo window for the purchase closes.',
};

export const BANK_PER_RESOURCE = 19;

export const PLAYER_COLORS = [
  { id: 'red', label: 'Red', hex: '#d64545' },
  { id: 'blue', label: 'Blue', hex: '#3b6fd6' },
  { id: 'white', label: 'White', hex: '#f3f1ea' },
  { id: 'orange', label: 'Orange', hex: '#f0932b' },
];

export const DEFAULT_OPTIONS = {
  playerCount: 4,
  targetVP: 10,
  boardLayout: 'random', // 'random' | 'beginner'
  randomHarbors: true,
  balancedNumbers: false, // no adjacent 6 & 8 tokens
  friendlyRobber: false, // robber can't be placed next to players with 2 or fewer VPs
  discardLimit: 7,
  undo: true, // offer a short undo window after most actions
  passDevice: true,
  seed: null,
};

// Standard beginner layout from the rulebook (rows top to bottom, left to right).
export const BEGINNER_LAYOUT = [
  [['mountains', 10], ['pasture', 2], ['forest', 9]],
  [['fields', 12], ['hills', 6], ['pasture', 4], ['hills', 10]],
  [['fields', 9], ['forest', 11], ['desert', null], ['forest', 3], ['mountains', 8]],
  [['forest', 8], ['mountains', 3], ['fields', 4], ['pasture', 5]],
  [['hills', 5], ['fields', 6], ['pasture', 11]],
];

export const TERRAIN_COUNTS = {
  hills: 3,
  forest: 4,
  pasture: 4,
  fields: 4,
  mountains: 3,
  desert: 1,
};

// Number token order for the variable setup spiral (rulebook letters A..R).
export const NUMBER_SPIRAL = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];

// Harbor types in clockwise order starting at the top-left of the standard board.
export const HARBOR_SEQUENCE = ['any', 'grain', 'ore', 'any', 'wool', 'any', 'any', 'brick', 'lumber'];

export const PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
