export interface VerifyScore {
  verdict: 'true' | 'false' | 'ambiguous';
  correct: boolean;
}

/** Extract a TRUE/FALSE verdict from a response. Takes the LAST explicit
 *  verdict token (the model's final conclusion), tolerating tool output like
 *  "Verified: FALSE". Returns 'ambiguous' (scored incorrect) when neither
 *  appears. */
export function scoreVerify(responseText: string, isTrue: boolean): VerifyScore {
  const upper = responseText.toUpperCase();
  let lastTrue = -1;
  let lastFalse = -1;
  for (const m of upper.matchAll(/\bTRUE\b/g)) lastTrue = m.index ?? lastTrue;
  for (const m of upper.matchAll(/\bFALSE\b/g)) lastFalse = m.index ?? lastFalse;

  let verdict: VerifyScore['verdict'];
  if (lastTrue === -1 && lastFalse === -1) verdict = 'ambiguous';
  else verdict = lastTrue > lastFalse ? 'true' : 'false';

  const correct = (verdict === 'true' && isTrue) || (verdict === 'false' && !isTrue);
  return { verdict, correct };
}
