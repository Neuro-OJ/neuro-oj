declare namespace Deno {
  export namespace env {
    export function get(key: string): string | undefined;
    export function set(key: string, value: string): void;
    export function toObject(): Record<string, string>;
  }
  export interface ServeOptions {
    port: number;
    hostname?: string;
    signal?: AbortSignal;
    onError?: (error: unknown) => Response | Promise<Response>;
  }
  export function serve(
    handler: (request: Request) => Response | Promise<Response>,
  ): void;
  export function serve(
    options: ServeOptions,
    handler: (request: Request) => Response | Promise<Response>,
  ): void;
  export function exit(code?: number): never;
  export function cwd(): string;
  export function chdir(directory: string): void;
  export const version: string;
  export const build: {
    target: string;
    arch: string;
    os: string;
    vendor: string;
    env?: string;
  };
  export const args: string[];
  export const pid: number;
  export const noColor: boolean;
  export namespace errors {
    export class NotFound extends Error {}
    export class PermissionDenied extends Error {}
    export class ConnectionRefused extends Error {}
    export class ConnectionReset extends Error {}
    export class ConnectionAborted extends Error {}
    export class NotConnected extends Error {}
    export class AddrInUse extends Error {}
    export class AddrNotAvailable extends Error {}
    export class BrokenPipe extends Error {}
    export class AlreadyExists extends Error {}
    export class InvalidData extends Error {}
    export class TimedOut extends Error {}
    export class Interrupted extends Error {}
    export class WriteZero extends Error {}
    export class UnexpectedEof extends Error {}
    export class BadResource extends Error {}
    export class Http extends Error {}
    export class Busy extends Error {}
  }
}

declare module "bcryptjs" {
  export function hash(
    s: string,
    salt: number | string,
  ): Promise<string>;
  export function hash(
    s: string,
    salt: number | string,
    callback: (err: Error | null, hash: string) => void,
  ): void;
  export function compare(
    s: string,
    hash: string,
  ): Promise<boolean>;
  export function compare(
    s: string,
    hash: string,
    callback: (err: Error | null, success: boolean) => void,
  ): void;
  export function genSalt(rounds?: number): Promise<string>;
  export function genSalt(
    rounds: number,
    callback: (err: Error | null, salt: string) => void,
  ): void;
}

declare module "jsr:@std/path@^1" {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
  export function normalize(path: string): string;
  export function parse(path: string): {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
  };
  export function format(pathObject: {
    root?: string;
    dir?: string;
    base?: string;
    ext?: string;
    name?: string;
  }): string;
  export const SEP: string;
  export const SEP_PATTERN: RegExp;
  export const DELIMITER: string;
}
