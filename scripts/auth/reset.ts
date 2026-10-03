import { resetOwnerFlow } from './flows';
import { loadEnvFile, openDatabase, terminalIo } from './run';

async function main(): Promise<number> {
  loadEnvFile();
  try {
    return await resetOwnerFlow(terminalIo, openDatabase());
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : 'unexpected problem'}`);
    return 1;
  }
}

void main().then((code) => process.exit(code));
