/**
 * Heuristic language detector for the user's prompt.
 *
 * Why a custom detector instead of leaning on the LLM: the synthesizer's
 * system prompt is in English, the action evidence block is in English, and
 * small models drift back to English under that pressure even when the prompt
 * "match the user's language" is set. Detecting the language client-side and
 * injecting an explicit `Reply in: <language>` directive into the
 * synthesizer's USER message is the only reliable way to lock the reply
 * language across model families.
 *
 * Heuristic only — no LLM call, no network. ~1µs per detection.
 *
 * Supported: Italian, Spanish, French, German, Portuguese. Anything else
 * falls through to English, which is also the explicit default for very
 * short / ambiguous inputs.
 */

export type DetectedLanguage =
  | 'English'
  | 'Italian'
  | 'Spanish'
  | 'French'
  | 'German'
  | 'Portuguese';

/**
 * Strong triggers count for 2 points each. These are verbs/forms that are
 * uniquely (or near-uniquely) one language. A single strong trigger crosses
 * the score threshold by itself.
 */
const STRONG_TRIGGERS: Record<Exclude<DetectedLanguage, 'English'>, readonly string[]> = {
  Italian: [
    'controlla', 'controllo', 'controllare', 'analizza', 'analizzo',
    'analizzare', 'mostrami', 'dammi', 'caduto', 'acceso', 'rotto',
    'avviato', 'spento', 'macchina', 'è', 'perché', 'perche',
  ],
  Spanish: ['comprobar', 'comprueba', 'comprueba', 'muéstrame', 'dame', 'caído'],
  French: ['vérifie', 'vérifier', 'analyse', 'analysez', 'montre', 'pourquoi'],
  German: ['überprüfe', 'überprüfen', 'analysiere', 'zeige', 'warum'],
  Portuguese: ['verifique', 'analise', 'mostre', 'porquê', 'caído'],
};

/** Word-boundary triggers per language. Lowercased, no diacritic-stripping. */
const TRIGGERS: Record<Exclude<DetectedLanguage, 'English'>, readonly string[]> = {
  Italian: [
    // Articles + pronouns (some shared with ES/PT — we lean on count + diacritic
    // to disambiguate)
    'il', 'lo', 'gli', 'una', 'uno', 'che', 'non', 'sono',
    'del', 'della', 'sul', 'sulla', 'questo', 'questa', 'perché', 'perche',
    'cosa', 'dove', 'quando', 'quanto', 'voglio', 'vorrei', 'è',
    'mi', 'ti', 'ci', 'si', 'ma', 'se', 'al', 'ai', 'alla', 'allo',
    'dei', 'delle', 'dal', 'dalla', 'col', 'verso', 'ed', 'né',
    // SRE-flavoured Italian — `-zz` and `-cci` consonant clusters are
    // strong IT signals; "controlla" final -a is IT imperative, "comprobar"
    // (ES equivalent) ends in -r so no clash
    'controlla', 'controllo', 'controllare', 'analizza', 'analizzo',
    'analizzare', 'mostrami', 'dammi', 'fai', 'puoi', 'devo',
    'avviato', 'spento', 'morto', 'caduto', 'acceso', 'rotto',
    'macchina', 'guarda', 'leggi', 'cosa', 'quello', 'quella',
  ],
  Spanish: [
    'el', 'los', 'las', 'una', 'unos', 'unas', 'que', 'qué', 'cómo', 'como',
    'dónde', 'donde', 'cuándo', 'cuando', 'cuánto', 'cuanto', 'por', 'para',
    'con', 'sin', 'sobre', 'porque', 'porqué', 'pero', 'también', 'esto',
    'esta', 'estoy', 'estás', 'estamos', 'son', 'es', 'tengo', 'tiene',
    'comprobar', 'verifica', 'verifico', 'analiza', 'puedes', 'quiero',
  ],
  French: [
    'le', 'la', 'les', 'une', 'des', 'que', 'qui', 'quoi', 'où', 'quand',
    'comment', 'pourquoi', 'parce', 'avec', 'sans', 'sur', 'pour', 'dans',
    'mais', 'aussi', 'cette', 'cet', 'mon', 'ma', 'mes', 'vous', 'votre',
    'nous', 'notre', 'c\'est', 'est-ce', 'vérifie', 'vérifier', 'analyse',
    'voulez', 'voulons', 'puis-je', 'peut-on',
  ],
  German: [
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen',
    'ist', 'sind', 'war', 'waren', 'nicht', 'kein', 'keine', 'aber',
    'auch', 'oder', 'und', 'was', 'wie', 'wo', 'wann', 'wer', 'warum',
    'ich', 'mich', 'mir', 'du', 'dich', 'dir', 'sie', 'sich', 'wir',
    'überprüfe', 'überprüfen', 'analysiere', 'zeig', 'zeigen',
  ],
  Portuguese: [
    'o', 'os', 'a', 'as', 'um', 'uma', 'que', 'não', 'nao', 'de', 'da',
    'do', 'das', 'dos', 'para', 'por', 'com', 'sem', 'sobre', 'está',
    'esta', 'estão', 'são', 'sou', 'mas', 'também', 'tambem', 'porque',
    'porquê', 'como', 'onde', 'quando', 'quanto', 'verifique', 'analise',
    'mostre', 'pode', 'quero',
  ],
};

const DIACRITIC_HINT: Record<Exclude<DetectedLanguage, 'English'>, RegExp> = {
  Italian: /[àèéìòù]/,
  Spanish: /[áéíóúñ¿¡]/,
  French: /[àâçéèêëîïôûùüÿœæ]/i,
  German: /[äöüß]/,
  Portuguese: /[ãõáâéêíóôúç]/,
};

/**
 * Score-based detection: each language scores +1 per trigger word match
 * and +1 per diacritic class hit. Highest score wins; ties favour earlier
 * declaration (Italian first since PIPER's primary user is Italian — the
 * tie-breaker rarely fires in practice).
 *
 * If the highest score is <2, falls back to English to avoid mis-classifying
 * very short / mostly-symbolic prompts ("ls /tmp", "uptime?").
 */
export function detectLanguage(prompt: string): DetectedLanguage {
  if (prompt.length < 4) return 'English';
  const tokens = prompt
    .toLowerCase()
    .replace(/[`*_~/\\(){}[\]<>:;,.!?"'#=+|]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const tokenSet = new Set(tokens);

  const scores: Record<Exclude<DetectedLanguage, 'English'>, number> = {
    Italian: 0,
    Spanish: 0,
    French: 0,
    German: 0,
    Portuguese: 0,
  };

  for (const lang of Object.keys(TRIGGERS) as (keyof typeof TRIGGERS)[]) {
    for (const trig of TRIGGERS[lang]) {
      if (tokenSet.has(trig)) scores[lang] += 1;
    }
    for (const strong of STRONG_TRIGGERS[lang]) {
      if (tokenSet.has(strong)) scores[lang] += 2;
    }
    if (DIACRITIC_HINT[lang].test(prompt)) scores[lang] += 1;
  }

  let best: keyof typeof scores = 'Italian';
  let bestScore = 0;
  for (const lang of Object.keys(scores) as (keyof typeof scores)[]) {
    if (scores[lang] > bestScore) {
      best = lang;
      bestScore = scores[lang];
    }
  }
  return bestScore >= 2 ? best : 'English';
}
