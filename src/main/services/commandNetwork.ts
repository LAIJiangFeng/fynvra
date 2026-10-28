import { commandEnvironment, type NetworkProxy } from '@shared/networkProxy';

let readConfiguration: () => NetworkProxy | undefined = () => undefined;

/** Main wires the settings reader at startup; commands read it again on every spawn. */
export function configureCommandNetwork(read: () => NetworkProxy | undefined): void {
  readConfiguration = read;
}

export function savedCommandEnvironment(): NodeJS.ProcessEnv {
  return commandEnvironment(process.env, readConfiguration(), process.platform === 'win32');
}
