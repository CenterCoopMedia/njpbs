export interface FirebaseEmulatorEnvironment {
  FIRESTORE_EMULATOR_PORT?: string;
}

export function resolveFirebaseEmulatorConfig<T>(
  config: T,
  env?: FirebaseEmulatorEnvironment,
): T;

export function shouldForwardEmulatorSignal(platform?: NodeJS.Platform): boolean;

export function firebaseEmulatorEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

export interface EmulatorCliOptions {
  mode: "start" | "exec";
  only?: string;
  command?: string;
  configPath: string;
  project?: string;
}

export function emulatorCliArgs(options: EmulatorCliOptions): string[];
