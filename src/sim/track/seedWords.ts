/**
 * Words for random track seeds: three of them joined by hyphens, like
 * "egg-cup-top". Short, easy to read out and to type on a pad's on-screen
 * keyboard, and plenty of tracks.
 *
 * From the list the player supplied, less the words below. Any word still
 * works typed in by hand — the seed is the text, whatever it is — but the
 * dice only deals words that can be read out without a mix-up:
 * - five that a random generator would sooner or later put next to "gas" or
 *   "pig" on everybody's screen (ass, sex, god, jew, gay);
 * - words that sound like another word, so a seed read out to a friend could
 *   be typed as the other one and make a different track: too/two/to,
 *   sea/see, won/one, bye/buy/by, and so on — including the ones that only
 *   sound alike in a British accent (paw/pour/poor, saw/sore, war/wore), the
 *   ones that sound like a letter (bee, pea, jay, why, are), and the ones with
 *   two spellings (axe/ax, eon/aeon, mom/mum).
 */
const SUPPLIED: readonly string[] = [
  'abs', 'ace', 'act', 'add', 'ado', 'age', 'ago', 'aid', 'ail', 'aim', 'air', 'ale', 'all', 'amp',
  'and', 'ant', 'any', 'ape', 'apt', 'arc', 'are', 'arm', 'art', 'ash', 'ask', 'ate', 'awe', 'axe',
  'bad', 'bag', 'ban', 'bar', 'bat', 'bay', 'bed', 'bee', 'beg', 'bet', 'bib', 'bid', 'big', 'bin',
  'bit', 'boa', 'bob', 'bog', 'boo', 'bow', 'box', 'boy', 'bra', 'bug', 'bun', 'bus', 'but', 'buy',
  'bye', 'cab', 'can', 'cap', 'car', 'cat', 'cod', 'cog', 'con', 'cop', 'cot', 'cow', 'coy', 'cry',
  'cue', 'cup', 'cut', 'dab', 'dad', 'day', 'den', 'dew', 'did', 'die', 'dig', 'dim', 'din', 'sip',
  'doe', 'dog', 'don', 'dot', 'dry', 'due', 'dug', 'duo', 'dye', 'ear', 'eat', 'eel', 'egg', 'ego',
  'elf', 'elk', 'elm', 'emo', 'emu', 'end', 'eon', 'era', 'eve', 'ewe', 'eye', 'fad', 'fan', 'far',
  'fat', 'fax', 'fed', 'fee', 'fez', 'fib', 'fig', 'fir', 'fit', 'fix', 'fly', 'foe', 'fog', 'for',
  'fox', 'fry', 'fun', 'fur', 'gag', 'gap', 'gas', 'gel', 'gem', 'get', 'gig', 'gin', 'gnu', 'goo',
  'got', 'gum', 'gun', 'gut', 'guy', 'gym', 'ice', 'icy', 'ill', 'imp', 'ink', 'inn', 'ion', 'ire',
  'its', 'jab', 'jam', 'jar', 'jaw', 'jay', 'jet', 'jib', 'job', 'joe', 'jog', 'joy', 'jug', 'jut',
  'keg', 'key', 'kid', 'kin', 'kit', 'koi', 'lab', 'lad', 'lag', 'lap', 'law', 'lax', 'lay', 'led',
  'leg', 'let', 'lid', 'lie', 'lip', 'lit', 'log', 'lot', 'low', 'lug', 'lye', 'mad', 'man', 'map',
  'mat', 'maw', 'max', 'may', 'men', 'met', 'mix', 'mob', 'mom', 'mop', 'mud', 'mug', 'mum', 'nab',
  'nag', 'nap', 'neo', 'net', 'new', 'nil', 'nip', 'nit', 'nod', 'nor', 'not', 'now', 'nun', 'nut',
  'oak', 'oar', 'oat', 'odd', 'ode', 'off', 'oft', 'ohm', 'oil', 'old', 'one', 'orb', 'ore', 'our',
  'out', 'owl', 'own', 'pad', 'pan', 'par', 'paw', 'pay', 'pea', 'peg', 'pen', 'per', 'pet', 'pie',
  'pig', 'pin', 'pit', 'ply', 'pod', 'pot', 'pub', 'pug', 'pun', 'put', 'rag', 'ram', 'ran', 'rap',
  'rat', 'raw', 'ray', 'red', 'rib', 'rid', 'rig', 'rim', 'rip', 'rob', 'roc', 'rod', 'rot', 'row',
  'rub', 'rug', 'rum', 'run', 'sad', 'sag', 'sap', 'sat', 'saw', 'say', 'sea', 'see', 'set', 'sew',
  'she', 'shy', 'sin', 'sir', 'sit', 'six', 'ski', 'sly', 'sky', 'sob', 'son', 'sow', 'soy', 'spa',
  'spy', 'sue', 'sum', 'sun', 'tab', 'tag', 'tan', 'tap', 'tar', 'tax', 'tea', 'tee', 'ten', 'the',
  'tie', 'tin', 'tip', 'toe', 'too', 'top', 'toy', 'try', 'tug', 'two', 'urn', 'use', 'van', 'vet',
  'via', 'vim', 'vow', 'wag', 'war', 'was', 'wax', 'way', 'web', 'wed', 'wet', 'who', 'why', 'wig',
  'win', 'wit', 'woe', 'wok', 'won', 'wry', 'yak', 'yam', 'yen', 'yes', 'yet', 'you', 'zap', 'zen',
  'zip', 'zit', 'zoo',
];

/** Supplied, but never dealt: see above. */
export const NOT_DEALT: ReadonlySet<string> = new Set([
  // Both of the pair were supplied.
  'too', 'two', 'bye', 'buy', 'die', 'dye', 'due', 'dew', 'sea', 'see', 'son', 'sun', 'tea', 'tee',
  'won', 'one', 'fir', 'fur', 'ale', 'ail', 'new', 'gnu', 'koi', 'coy', 'lie', 'lye', 'sew', 'sow',
  // A common word sounds the same.
  'eye', 'ewe', 'you', 'for', 'doe', 'toe', 'woe', 'rap', 'ate', 'bow', 'row', 'nit', 'nun', 'not',
  'our', 'its', 'add', 'led', 'wry', 'sum', 'per', 'boy', 'way', 'tie', 'pie', 'ode', 'roc', 'gel',
  // Alike in a British accent: no r after a vowel.
  'awe', 'oar', 'ore', 'paw', 'saw', 'raw', 'law', 'maw', 'war', 'nor', 'boa', 'don',
  // Sound like a letter.
  'bee', 'pea', 'jay', 'cue', 'why', 'are',
  // Two spellings.
  'axe', 'eon', 'mom',
]);

/** The words the dice deals from. */
export const SEED_WORDS: readonly string[] = SUPPLIED.filter((w) => !NOT_DEALT.has(w));

/** Three random words, hyphenated. `rand` returns [0, 1): the menu passes `Math.random`. */
export function randomSeedText(rand: () => number = Math.random): string {
  const pick = (): string => SEED_WORDS[Math.floor(rand() * SEED_WORDS.length)]!;
  return `${pick()}-${pick()}-${pick()}`;
}
