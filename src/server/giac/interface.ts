export interface GiacEngine {
  initialize(): Promise<void>;
  evaluate(expression: string): Promise<string>;
  isReady(): boolean;
}
