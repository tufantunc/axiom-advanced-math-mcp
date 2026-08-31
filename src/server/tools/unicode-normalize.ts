/**
 * Replace Unicode math characters with their ASCII / Giac-plain equivalents.
 * Pure function — used by both runtime tool output (compute hygiene) and the
 * benchmark grader normalizer, so both have a consistent canonical form.
 */
export function unicodeToAscii(s: string): string {
  return s
    .replaceAll('√', 'sqrt')
    .replaceAll('π', 'pi')
    .replaceAll('×', '*')
    .replaceAll('·', '*')
    .replaceAll('÷', '/')
    .replaceAll('²', '^2')
    .replaceAll('³', '^3')
    .replaceAll('⁰', '^0')
    .replaceAll('¹', '^1')
    .replaceAll('⁴', '^4')
    .replaceAll('⁵', '^5')
    .replaceAll('⁶', '^6')
    .replaceAll('⁷', '^7')
    .replaceAll('⁸', '^8')
    .replaceAll('⁹', '^9');
}
