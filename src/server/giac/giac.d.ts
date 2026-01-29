declare module 'giac' {
  export interface GiacResult {
    value: any;
    display?: string;
  }

  export interface GiacOptions {
    timeout?: number;
    memory?: number;
  }

  export function evaluate(expression: string, options?: GiacOptions): any;
  export function evaluateLatex(expression: string): string;
  export function evaluateSteps(expression: string): { result: any; steps: string[] };
}
