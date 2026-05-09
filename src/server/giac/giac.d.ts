declare module 'giac' {
  export interface GiacResult {
    value: unknown;
    display?: string;
  }

  export interface GiacOptions {
    timeout?: number;
    memory?: number;
  }

  export function evaluate(expression: string, options?: GiacOptions): unknown;
  export function evaluateLatex(expression: string): string;
  export function evaluateSteps(expression: string): { result: unknown; steps: string[] };
}
