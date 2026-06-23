export interface VerifyCase {
  claim: string;
  isTrue: boolean;
  domain: string;
}

/** Balanced true/false math claims across domains. The false cases are
 *  plausible-but-wrong (the discriminator for real verification). */
export const VERIFY_SET: VerifyCase[] = [
  { claim: 'd/dx (x^3) = 3*x^2', isTrue: true, domain: 'derivative' },
  { claim: 'd/dx (x^3) = 2*x^2', isTrue: false, domain: 'derivative' },
  { claim: 'integral of 2*x dx = x^2 + C', isTrue: true, domain: 'integral' },
  { claim: 'integral of 2*x dx = 2*x^2 + C', isTrue: false, domain: 'integral' },
  { claim: '(x+1)^2 = x^2 + 2*x + 1', isTrue: true, domain: 'algebra' },
  { claim: '(x+1)^2 = x^2 + 1', isTrue: false, domain: 'algebra' },
  { claim: 'sin(x)^2 + cos(x)^2 = 1', isTrue: true, domain: 'identity' },
  { claim: 'sin(x)^2 - cos(x)^2 = 1', isTrue: false, domain: 'identity' },
  { claim: 'the eigenvalues of [[2,0],[0,3]] are 2 and 3', isTrue: true, domain: 'linear-algebra' },
  { claim: 'the eigenvalues of [[2,0],[0,3]] are 1 and 6', isTrue: false, domain: 'linear-algebra' },
  { claim: 'limit of (sin(x)/x) as x->0 is 1', isTrue: true, domain: 'limit' },
  { claim: 'limit of (sin(x)/x) as x->0 is 0', isTrue: false, domain: 'limit' },
  { claim: 'x^2 - 5*x + 6 factors as (x-2)*(x-3)', isTrue: true, domain: 'factor' },
  { claim: 'x^2 - 5*x + 6 factors as (x-1)*(x-6)', isTrue: false, domain: 'factor' },
];
